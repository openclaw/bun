//! Cross-function closure of the physical views named by reached Flow sites.

use super::{Fragment, FragmentIndex, Identity, Index, Notes, Reach, reached};
use bun_sema::check::task::Finished;
use bun_sema::check::{FlowRecordContract, KindsDeclared, Program as Checked, SourceSearchTrace};
use bun_sema::types::TypeId;
use bun_sema::util::{InParallel, for_each_mut};
use rustc_hash::{FxHashMap, FxHashSet};

const MAX_FAMILY_MEMBERS: usize = 1024;
const MAX_FAMILY_PAIRS: usize = 65_536;
const PAIRS_PER_BATCH: usize = 4096;
const PAIRS_PER_TASK: usize = 128;

#[derive(Default)]
pub(super) struct Closure {
    scanned: FxHashSet<u32>,
    family_of: FxHashMap<Identity, usize>,
    families: Vec<Vec<Identity>>,
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

    fn join(&mut self, left: Identity, right: Identity) {
        let family = self
            .family_of
            .get(&left)
            .or_else(|| self.family_of.get(&right))
            .copied()
            .unwrap_or_else(|| {
                self.families.push(Vec::new());
                self.comparisons.push(0);
                self.dirty.push(true);
                self.families.len() - 1
            });
        self.add(family, left);
        self.add(family, right);
        self.dirty[family] = true;
    }

    pub(super) fn include_reached(
        &mut self,
        fragments: &[Fragment],
        index: &Index,
        reach: &Reach,
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
                    self.join(left, right);
                }
            }
        }
    }

    pub(super) fn pending(&mut self) -> Result<Vec<(Identity, Identity)>, &'static str> {
        let mut pairs = Vec::new();
        for (family, members) in self.families.iter_mut().enumerate() {
            if !self.dirty[family] {
                continue;
            }
            if members.len() > MAX_FAMILY_MEMBERS {
                return Err("a cross-function Flow family with more than 1024 layouts");
            }
            if self.comparisons[family] > MAX_FAMILY_PAIRS {
                return Err(
                    "a cross-function Flow family requiring more than 65536 layout comparisons",
                );
            }
            members.sort_unstable();
            for (right, &b) in members.iter().enumerate() {
                for &a in &members[..right] {
                    if (!self.generators.contains(&a) && !self.generators.contains(&b))
                        || self.compared.contains(&(a, b))
                    {
                        continue;
                    }
                    if self.comparisons[family] >= MAX_FAMILY_PAIRS {
                        return Err(
                            "a cross-function Flow family requiring more than 65536 layout comparisons",
                        );
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

    pub(super) fn accept(&mut self, program: &Checked<'_>, batch: &mut Batch) {
        let diagnosing = SourceSearchTrace::native_queries_enabled();
        let before: Vec<usize> = if diagnosing {
            self.families
                .iter()
                .map(Vec::len)
                .filter(|&n| n != 0)
                .collect()
        } else {
            Vec::new()
        };
        let results = batch.results.len();
        let mut generated = 0;
        let mut new_records = Vec::new();
        // All results have survived task validation and publication. Preserve every parent's edges,
        // while only the first identity for the exact materialized contract grows the family.
        for (left, right, both) in std::mem::take(&mut batch.results) {
            if let Some((identity, contract)) = both {
                generated += 1;
                if diagnosing && !self.records.contains_key(&contract) {
                    new_records.push((left, right, identity));
                }
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
        if diagnosing {
            let after: Vec<usize> = self
                .families
                .iter()
                .map(Vec::len)
                .filter(|&n| n != 0)
                .collect();
            if let Some(trace) = SourceSearchTrace::flow_layout_batch(
                std::ptr::from_ref(program).addr(),
                results,
                generated,
                new_records.len(),
                &before,
                &after,
            ) {
                for (left, right, identity) in new_records {
                    if let Some(detail) = batch.diagnostics.remove(&identity) {
                        trace.flow_layout_record(left, right, identity, &detail);
                    }
                }
            }
        }
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
    diagnostics: FxHashMap<Identity, String>,
    pub(super) unresolved: bool,
}

struct Task<'s> {
    notes: Notes,
    results: Vec<(Identity, Identity, Option<(Identity, FlowRecordContract)>)>,
    diagnostics: FxHashMap<Identity, String>,
    unresolved: bool,
    finished: Finished<'s>,
}

pub(super) fn make_pairs<'s>(
    program: &Checked<'s>,
    pairs: &[(Identity, TypeId, Identity, TypeId)],
    kinds_declared: &KindsDeclared,
    in_parallel: InParallel<'_>,
) -> Batch {
    let mut batch = Batch::default();
    let mut slices: Vec<_> = pairs.chunks(PAIRS_PER_TASK).collect();
    while !slices.is_empty() {
        let mut tasks: Vec<(usize, Option<Task<'s>>)> =
            (0..slices.len()).map(|index| (index, None)).collect();
        for_each_mut(&mut tasks, in_parallel, &|(task, outcome)| {
            let mut trace = SourceSearchTrace::flow_layout_closure(
                std::ptr::from_ref(program).addr(),
                slices[*task].len(),
            );
            let mut c = program.checker();
            c.begin_stack_budget();
            c.begin_task(super::LINK_STEP, *task as u32, true);
            c.withhold_expression_tables();
            let mut made = Vec::new();
            let mut results = Vec::new();
            let mut diagnostics = FxHashMap::default();
            let mut unresolved = false;
            let (mut pair_unknown, mut no_contract) = (0, 0);
            let (mut failed_pairs, mut logged_failed_pairs) = (0, 0);
            for &(left, a, right, b) in slices[*task] {
                let before = c.unknown_count();
                let both = c.intersection_for_flow_cast(a, b);
                unresolved |= c.unknown_count() != before;
                pair_unknown += usize::from(c.unknown_count() != before);
                let generated = both.and_then(|both| {
                    c.keep_type(both);
                    made.push((a, b, both));
                    let generated = c.flow_record_contract(both);
                    if SourceSearchTrace::native_active() {
                        if let Some((identity, contract)) = &generated {
                            diagnostics
                                .entry(*identity)
                                .or_insert_with(|| c.flow_record_diagnostic(both, contract));
                        }
                    }
                    unresolved |= generated.is_none();
                    no_contract += usize::from(generated.is_none());
                    generated
                });
                unresolved |= c.unknown_count() != before;
                let unknown = c.unknown_count() != before;
                let missing_contract = both.is_some() && generated.is_none();
                if unknown || missing_contract {
                    failed_pairs += 1;
                    if SourceSearchTrace::native_active() && logged_failed_pairs < 16 {
                        let detail = format!(
                            "source={}\ntarget={}\nsource_formula={}\ntarget_formula={}",
                            c.flow_type_diagnostic(a),
                            c.flow_type_diagnostic(b),
                            c.flow_formula_diagnostic(a),
                            c.flow_formula_diagnostic(b)
                        );
                        SourceSearchTrace::flow_layout_pair_failure(
                            left,
                            right,
                            a.0,
                            b.0,
                            unknown,
                            missing_contract,
                            &detail,
                        );
                        logged_failed_pairs += 1;
                    }
                }
                if let Some(trace) = &mut trace {
                    trace.scan(generated.is_none());
                    trace.progress(
                        0,
                        results.len() + 1,
                        c.unknown_count() != before || both.is_some() && generated.is_none(),
                    );
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
            unresolved |= notes_unknown || ran_out_of_stack;
            SourceSearchTrace::flow_layout_reasons(
                pair_unknown,
                no_contract,
                notes_unknown,
                ran_out_of_stack,
                failed_pairs,
                logged_failed_pairs,
            );
            let finished = {
                let _phase = SourceSearchTrace::native_phase("flow_layout_finish");
                c.end_task()
            };
            *outcome = Some(Task {
                notes,
                results,
                diagnostics,
                unresolved,
                finished,
            });
        });
        let mut outcomes = Vec::new();
        let mut finished = Vec::new();
        for Task {
            notes,
            results,
            diagnostics,
            unresolved,
            finished: task,
        } in tasks.into_iter().filter_map(|task| task.1)
        {
            outcomes.push((notes, results, diagnostics, unresolved));
            finished.push(task);
        }
        let invalid = program.validate(&finished, true);
        let mut accepted = Vec::new();
        let mut retried = Vec::new();
        for (((notes, results, diagnostics, unresolved), record), (slice, invalid)) in outcomes
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
                batch.diagnostics.extend(diagnostics);
                batch.unresolved |= unresolved;
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
