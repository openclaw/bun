//! Cross-function closure of the physical views named by reached Flow sites.

use super::{Fragment, FragmentIndex, Identity, Index, Notes, Reachability, reached};
use bun_sema::check::task::Finished;
use bun_sema::check::{FlowRecordContract, KindsDeclared, Program as Checked};
use bun_sema::program::FileId;
use bun_sema::types::TypeId;
use bun_sema::util::{InParallel, for_each_mut};
use rustc_hash::{FxHashMap, FxHashSet};
use std::borrow::Cow;

const MAX_FAMILY_MEMBERS: usize = 1024;
const MAX_FAMILY_PAIRS: usize = 65_536;
const PAIRS_PER_BATCH: usize = 4096;
const PAIRS_PER_TASK: usize = 128;

pub struct Exhausted {
    pub contributors: Vec<FileId>,
    pub what: Cow<'static, str>,
}

#[derive(Default)]
pub(super) struct Failure {
    pairs: Vec<(Identity, Identity)>,
    reasons: Vec<&'static str>,
}

impl Failure {
    pub(super) fn extend(&mut self, other: Self) {
        self.pairs.extend(other.pairs);
        for reason in other.reasons {
            if !self.reasons.contains(&reason) {
                self.reasons.push(reason);
            }
        }
    }
}

#[derive(Default)]
pub(super) struct Closure {
    scanned: FxHashSet<u32>,
    family_of: FxHashMap<Identity, usize>,
    families: Vec<Vec<Identity>>,
    contributors: Vec<FxHashSet<FileId>>,
    comparisons: Vec<usize>,
    dirty: Vec<bool>,
    generators: FxHashSet<Identity>,
    compared: FxHashSet<(Identity, Identity)>,
    roots: FxHashSet<Identity>,
    records: FxHashMap<FlowRecordContract, Identity>,
    aliases: FxHashMap<Identity, Identity>,
    notes: Notes,
}

impl Closure {
    fn add(&mut self, family: usize, identity: Identity) {
        match self.family_of.get(&identity).copied() {
            Some(other) if other == family => {}
            Some(other) => {
                let contributors = std::mem::take(&mut self.contributors[other]);
                self.contributors[family].extend(contributors);
                self.comparisons[family] += std::mem::take(&mut self.comparisons[other]);
                self.dirty[family] = true;
                self.dirty[other] = false;
                for identity in std::mem::take(&mut self.families[other]) {
                    self.family_of.insert(identity, family);
                    self.families[family].push(identity);
                }
            }
            None => {
                self.family_of.insert(identity, family);
                self.families[family].push(identity);
                self.dirty[family] = true;
            }
        }
    }

    fn join(&mut self, left: Identity, right: Identity) -> usize {
        let family = self
            .family_of
            .get(&left)
            .or_else(|| self.family_of.get(&right))
            .copied()
            .unwrap_or_else(|| {
                self.families.push(Vec::new());
                self.contributors.push(FxHashSet::default());
                self.comparisons.push(0);
                self.dirty.push(true);
                self.families.len() - 1
            });
        self.add(family, left);
        self.add(family, right);
        self.dirty[family] = true;
        family
    }

    pub(super) fn include_reached(
        &mut self,
        fragments: &[Fragment],
        index: &Index,
        reach: &Reachability,
        is_opaque: &impl Fn(bun_sema::program::FileId) -> bool,
    ) {
        for (number, fragment) in fragments.iter().enumerate() {
            for (local, (function, &id)) in fragment
                .funcs
                .iter()
                .zip(&fragment.program_ids.funcs)
                .enumerate()
            {
                if index.func(id) != Some(FragmentIndex::new(number, local))
                    || !reach.has(id, reached::BODY)
                    || is_opaque(function.key.file())
                {
                    continue;
                }
                let Some(body) = &function.body else { continue };
                if !self.scanned.insert(id) {
                    continue;
                }
                for (left, right) in body.notes.flow_layout_edges() {
                    self.generators.extend([left, right]);
                    let family = self.join(left, right);
                    if function.key.file() != super::NO_FILE {
                        self.contributors[family].insert(function.key.file());
                    }
                }
            }
        }
    }

    fn exhausted(&self, family: usize, what: &'static str) -> Exhausted {
        let mut contributors: Vec<_> = self.contributors[family].iter().copied().collect();
        contributors.sort_unstable();
        Exhausted {
            contributors,
            what: what.into(),
        }
    }

    pub(super) fn failed(&self, failure: Failure) -> Exhausted {
        let mut contributors = FxHashSet::default();
        for (left, right) in failure.pairs {
            let family = self.family_of[&left];
            debug_assert_eq!(
                family, self.family_of[&right],
                "pending Flow pair belongs to one family"
            );
            contributors.extend(self.contributors[family].iter().copied());
        }
        let mut contributors: Vec<_> = contributors.into_iter().collect();
        contributors.sort_unstable();
        Exhausted {
            contributors,
            what: format!(
                "a cross-function Flow task where {}",
                failure.reasons.join("; ")
            )
            .into(),
        }
    }

    // After the first failed batch, the caller freezes the closure and only drains known pairs.
    pub(super) fn exclude_failed(&mut self, failure: &Failure) {
        for &(left, _) in &failure.pairs {
            self.dirty[self.family_of[&left]] = false;
        }
    }

    pub(super) fn pending(&mut self) -> Result<Vec<(Identity, Identity)>, Exhausted> {
        let mut pairs = Vec::new();
        for family in 0..self.families.len() {
            if !self.dirty[family] {
                continue;
            }
            if self.families[family].len() > MAX_FAMILY_MEMBERS {
                return Err(self.exhausted(
                    family,
                    "a cross-function Flow family with more than 1024 layouts",
                ));
            }
            if self.comparisons[family] > MAX_FAMILY_PAIRS {
                return Err(self.exhausted(
                    family,
                    "a cross-function Flow family requiring more than 65536 layout comparisons",
                ));
            }
            self.families[family].sort_unstable();
            let members = &self.families[family];
            for (right, &b) in members.iter().enumerate() {
                for &a in &members[..right] {
                    if (!self.generators.contains(&a) && !self.generators.contains(&b))
                        || self.compared.contains(&(a, b))
                    {
                        continue;
                    }
                    if self.comparisons[family] >= MAX_FAMILY_PAIRS {
                        return Err(self.exhausted(family,
                            "a cross-function Flow family requiring more than 65536 layout comparisons",
                        ));
                    }
                    self.comparisons[family] += 1;
                    self.compared.insert((a, b));
                    pairs.push((a, b));
                    if pairs.len() == PAIRS_PER_BATCH {
                        return Ok(pairs);
                    }
                }
            }
            self.dirty[family] = false;
        }
        Ok(pairs)
    }

    pub(super) fn accept(&mut self, batch: &mut Batch) {
        // All results have survived task validation and publication. Preserve every parent's edges,
        // while only the first identity for the exact materialized contract grows the family.
        for (left, right, both) in std::mem::take(&mut batch.results) {
            if let Some((identity, contract)) = both {
                let both = *self.records.entry(contract).or_insert(identity);
                self.aliases.insert(identity, both);
                let family = self.family_of[&left];
                self.add(family, right);
                self.add(family, both);
                self.roots.insert(both);
            }
        }
        self.notes
            .append(std::mem::take(&mut batch.notes).renamed(|identity| {
                Some(self.aliases.get(&identity).copied().unwrap_or(identity))
            }));
    }

    pub(super) fn roots(&self) -> Vec<Identity> {
        let mut roots: Vec<_> = self.roots.iter().copied().collect();
        roots.sort_unstable();
        roots
    }

    pub(super) fn take_notes(&mut self) -> Notes {
        std::mem::take(&mut self.notes)
    }
}

#[derive(Default)]
pub(super) struct Batch {
    notes: Notes,
    results: Vec<(Identity, Identity, Option<(Identity, FlowRecordContract)>)>,
    pub(super) failure: Option<Failure>,
}

struct Task<'s> {
    notes: Notes,
    results: Vec<(Identity, Identity, Option<(Identity, FlowRecordContract)>)>,
    failure: Option<Failure>,
    finished: Finished<'s>,
}

pub(super) fn make_pairs<'s>(
    program: &Checked<'s>,
    pairs: &[(Identity, TypeId, Identity, TypeId)],
    kinds_declared: &KindsDeclared,
    requires_native_layouts: bool,
    in_parallel: InParallel<'_>,
) -> Batch {
    let mut batch = Batch::default();
    let mut slices: Vec<_> = pairs.chunks(PAIRS_PER_TASK).collect();
    while !slices.is_empty() {
        let mut tasks: Vec<(usize, Option<Task<'s>>)> =
            (0..slices.len()).map(|index| (index, None)).collect();
        for_each_mut(&mut tasks, in_parallel, &|(task, outcome)| {
            let mut c = program.checker();
            c.begin_stack_budget();
            c.begin_task(super::LINK_STEP, *task as u32, true);
            c.withhold_expression_tables();
            let mut made = Vec::new();
            let mut results = Vec::new();
            let mut failure = None;
            let (mut pair_unknown, mut no_contract) = (0, 0);
            for &(left, a, right, b) in slices[*task] {
                let before = c.unknown_count();

                let (both, unsupported) = match c.intersection_for_flow_cast(a, b) {
                    Ok(both) => (both, None),
                    Err(reason) => (None, Some(reason)),
                };
                let redefined = both.is_some_and(|both| c.may_be_redefined(both));
                let too_nested = requires_native_layouts && !redefined && both.is_some_and(|both| c.is_nested_too_deeply(both));
                let generated = both.filter(|_| !redefined && !too_nested).and_then(|both| {
                    c.keep_type(both);
                    made.push((a, b, both));
                    let generated = c.flow_record_contract(both);
                    no_contract += usize::from(generated.is_none());
                    generated
                });
                let unknown = c.unknown_count() != before;
                let missing_contract = both.is_some() && !redefined && !too_nested && generated.is_none();
                pair_unknown += usize::from(unknown);
                if unsupported.is_some() || unknown || missing_contract || redefined || too_nested {
                    let mut reasons = Vec::new();
                    reasons.extend(unsupported);
                    if unknown {
                        reasons.push("an auxiliary relation exceeded its analysis limit");
                    }
                    if missing_contract {
                        reasons.push("a materialized record contract could not be resolved");
                    }
                    if redefined {
                        reasons.push("a generated Flow record may be redefined");
                    }
                    if too_nested {
                        reasons.push("a generated Flow record exceeds the nesting limit");
                    }
                    failure.get_or_insert_with(Failure::default).extend(Failure {
                        pairs: vec![(left, right)],
                        reasons,
                    });
                }
                results.push((left, right, generated));
            }
            // NO_FILE description drains global query notes without an evaluation body. Keep the
            // same type-publication effects before recording the explicit transition edges.
            drop(c.take_notes_recorded().renamed(|ty| {
                c.keep_type(ty);
                Some(c.type_identity(ty))
            }));
            // The global closure chooses canonical records before their layouts are described.
            for &(a, b, both) in &made {
                c.record_cast(&[a, b], both, false, false, true, true);
                c.record_upcast(both, a);
                c.record_upcast(both, b);
            }
            let before_notes = c.unknown_count();
            let notes = c.take_notes_recorded().renamed(|ty| {
                c.keep_type(ty);
                Some(c.type_identity(ty))
            });
            let notes_unknown = c.unknown_count() != before_notes;
            let ran_out_of_stack = c.take_ran_out_of_stack();
            if notes_unknown || ran_out_of_stack {
                // Notes and stack limits cover this native task, so retain every pair it processed.
                let pairs = slices[*task]
                    .iter()
                    .map(|&(left, _, right, _)| (left, right))
                    .collect();
                let mut reasons = Vec::new();
                if pair_unknown != 0 {
                    reasons.push("an auxiliary relation exceeded its analysis limit");
                }
                if no_contract != 0 {
                    reasons.push("a materialized record contract could not be resolved");
                }
                if notes_unknown {
                    reasons.push("transition notes exceeded an auxiliary relation limit");
                }
                if ran_out_of_stack {
                    reasons.push("native analysis exhausted its stack");
                }
                failure = Some(Failure { pairs, reasons });
            }
            let finished = c.end_task();
            *outcome = Some(Task {
                notes,
                results,
                failure,
                finished,
            });
        });
        let mut outcomes = Vec::new();
        let mut finished = Vec::new();
        for Task {
            notes,
            results,
            failure,
            finished: task,
        } in tasks.into_iter().filter_map(|task| task.1)
        {
            outcomes.push((notes, results, failure));
            finished.push(task);
        }
        let invalid = program.validate(&finished, true);
        let mut accepted = Vec::new();
        let mut retried = Vec::new();
        for (((notes, results, failure), record), (slice, invalid)) in outcomes
            .into_iter()
            .zip(finished)
            .zip(slices.into_iter().zip(invalid))
        {
            if invalid {
                retried.push(slice);
            } else {
                accepted.push(record);
                batch.notes.append(notes);
                batch.results.extend(results);
                if let Some(failure) = failure {
                    // Only validated tasks contribute failures to the next whole-program attempt.
                    batch.failure.get_or_insert_with(Failure::default).extend(failure);
                }
            }
        }
        kinds_declared.publish(|| {
            program.link(&mut accepted, in_parallel);
            program.publish(&mut accepted, in_parallel, false);
        });
        slices = retried;
    }
    batch
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pair_failure_keeps_original_owners_and_excludes_other_task_families() {
        let mut closure = Closure::default();
        let (left, right, generated, other) = ([1, 0], [2, 0], [3, 0], [4, 0]);
        let first = closure.join(left, generated);
        closure.contributors[first].insert(FileId(7));
        let second = closure.join(right, other);
        closure.contributors[second].insert(FileId(2));
        closure.join(generated, right);
        let unrelated = closure.join([5, 0], [6, 0]);
        closure.contributors[unrelated].insert(FileId(99));

        let exhausted = closure.failed(Failure {
            pairs: vec![(generated, other)],
            reasons: vec!["an auxiliary relation exceeded its analysis limit"],
        });
        assert_eq!(exhausted.contributors, vec![FileId(2), FileId(7)]);
        assert!(exhausted.what.contains("auxiliary relation"));
    }

    #[test]
    fn failed_families_leave_later_known_batches_available() {
        let mut closure = Closure::default();
        for (base, file) in [(1, FileId(7)), (1000, FileId(2))] {
            for identity in base + 1..=base + 96 {
                let family = closure.join([base, 0], [identity, 0]);
                closure.contributors[family].insert(file);
                closure.generators.extend([[base, 0], [identity, 0]]);
            }
        }
        let healthy = closure.join([3000, 0], [3001, 0]);
        closure.generators.extend([[3000, 0], [3001, 0]]);
        closure.contributors[healthy].insert(FileId(99));

        let first = closure.pending().unwrap();
        assert_eq!(first.len(), PAIRS_PER_BATCH);
        let first_family = closure.family_of[&first[0].0];
        assert!(
            first
                .iter()
                .all(|pair| closure.family_of[&pair.0] == first_family)
        );
        let mut failure = Failure {
            pairs: first,
            reasons: vec!["a Flow intersection has no supported data-field representation"],
        };
        closure.exclude_failed(&failure);
        let second = closure.pending().unwrap();
        assert_eq!(second.len(), PAIRS_PER_BATCH);
        assert!(
            second
                .iter()
                .all(|pair| closure.family_of[&pair.0] != first_family)
        );
        let next = Failure {
            pairs: second,
            reasons: vec!["a Flow intersection has no supported data-field representation"],
        };
        closure.exclude_failed(&next);
        failure.extend(next);
        let remaining = closure.pending().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(closure.family_of[&remaining[0].0], healthy);
        assert!(closure.pending().unwrap().is_empty());
        let exhausted = closure.failed(failure);
        assert_eq!(exhausted.contributors, vec![FileId(2), FileId(7)]);
        assert_eq!(
            exhausted.what,
            "a cross-function Flow task where a Flow intersection has no supported data-field representation"
        );
    }

    #[test]
    fn task_failure_keeps_every_task_family_but_not_unrelated_families() {
        let mut closure = Closure::default();
        let first = closure.join([1, 0], [2, 0]);
        closure.contributors[first].extend([FileId(7), FileId(2)]);
        let second = closure.join([3, 0], [4, 0]);
        closure.contributors[second].extend([FileId(8), FileId(2)]);
        let unrelated = closure.join([5, 0], [6, 0]);
        closure.contributors[unrelated].insert(FileId(99));

        let exhausted = closure.failed(Failure {
            pairs: vec![([1, 0], [2, 0]), ([3, 0], [4, 0])],
            reasons: vec![
                "transition notes exceeded an auxiliary relation limit",
                "native analysis exhausted its stack",
            ],
        });
        assert_eq!(
            exhausted.contributors,
            vec![FileId(2), FileId(7), FileId(8)]
        );
        assert!(exhausted.what.contains("transition notes"));
        assert!(exhausted.what.contains("exhausted its stack"));
    }
}

#[cfg(test)]
mod bounds_tests {
    use super::*;

    #[test]
    fn a_member_overflow_keeps_the_original_source_owner() {
        let mut closure = Closure::default();
        let family = closure.join([1, 0], [2, 0]);
        closure.contributors[family].insert(FileId(7));
        for identity in 3..=MAX_FAMILY_MEMBERS as u64 + 1 {
            closure.add(family, [identity, 0]);
        }
        let exhausted = closure.pending().unwrap_err();
        assert_eq!(exhausted.contributors, vec![FileId(7)]);
        assert!(exhausted.what.contains("1024"));
    }

    #[test]
    fn the_comparison_budget_cannot_restart_after_a_family_merge() {
        let mut closure = Closure::default();
        let first = closure.join([1, 0], [2, 0]);
        let second = closure.join([3, 0], [4, 0]);
        closure.comparisons[first] = MAX_FAMILY_PAIRS;
        closure.comparisons[second] = 1;
        closure.generators.extend([[1, 0], [3, 0]]);
        closure.join([1, 0], [3, 0]);
        let exhausted = closure.pending().unwrap_err();
        assert!(exhausted.what.contains("65536"));
    }
}
