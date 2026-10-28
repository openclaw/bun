/// Strongly connected components in source-to-dependency order.
pub(crate) struct Components {
    pub(crate) component_of: Vec<usize>,
    pub(crate) members: Vec<Vec<usize>>,
    pub(crate) dependencies: Vec<Vec<usize>>,
}

/// Condense cycles before propagating the sets used by final chunk hashes.
/// Both DFS passes are iterative: split bundles can contain very long chains.
pub(crate) fn components(edges: &[Vec<u32>]) -> Components {
    let n = edges.len();
    let mut reverse = vec![Vec::new(); n];
    for (i, outgoing) in edges.iter().enumerate() {
        for &j in outgoing {
            reverse[j as usize].push(i);
        }
    }

    let mut seen = vec![false; n];
    let mut order = Vec::with_capacity(n);
    let mut stack = Vec::new();
    for root in 0..n {
        if seen[root] {
            continue;
        }
        seen[root] = true;
        stack.push((root, 0));
        while let Some(&(i, next)) = stack.last() {
            if next == edges[i].len() {
                order.push(i);
                stack.pop();
            } else {
                stack.last_mut().unwrap().1 += 1;
                let j = edges[i][next] as usize;
                if !seen[j] {
                    seen[j] = true;
                    stack.push((j, 0));
                }
            }
        }
    }

    let mut component_of = vec![usize::MAX; n];
    let mut members = Vec::new();
    let mut pending = Vec::new();
    for root in order.into_iter().rev() {
        if component_of[root] != usize::MAX {
            continue;
        }
        let id = members.len();
        let mut group = Vec::new();
        component_of[root] = id;
        pending.push(root);
        while let Some(i) = pending.pop() {
            group.push(i);
            for &j in &reverse[i] {
                if component_of[j] == usize::MAX {
                    component_of[j] = id;
                    pending.push(j);
                }
            }
        }
        members.push(group);
    }

    let mut dependencies = vec![Vec::new(); members.len()];
    for (i, outgoing) in edges.iter().enumerate() {
        let from = component_of[i];
        for &j in outgoing {
            let to = component_of[j as usize];
            if from != to {
                // Kosaraju's reverse finishing order visits source components first.
                debug_assert!(from < to);
                dependencies[from].push(to);
            }
        }
    }
    for outgoing in &mut dependencies {
        outgoing.sort_unstable();
        outgoing.dedup();
    }
    Components {
        component_of,
        members,
        dependencies,
    }
}

#[cfg(test)]
mod tests {
    use super::components;

    fn check(edges: &[Vec<u32>]) {
        let graph = components(edges);
        let n = edges.len();
        let mut reachable = vec![vec![false; n]; graph.members.len()];
        for (id, members) in graph.members.iter().enumerate() {
            for &i in members {
                reachable[id][i] = true;
            }
        }
        for id in (0..graph.members.len()).rev() {
            for &dependency in &graph.dependencies[id] {
                assert!(dependency > id);
                for i in 0..n {
                    reachable[id][i] |= reachable[dependency][i];
                }
            }
        }
        for root in 0..n {
            let mut expected = vec![false; n];
            let mut pending = vec![root];
            expected[root] = true;
            while let Some(i) = pending.pop() {
                for &j in &edges[i] {
                    if !expected[j as usize] {
                        expected[j as usize] = true;
                        pending.push(j as usize);
                    }
                }
            }
            assert_eq!(reachable[graph.component_of[root]], expected);
        }
    }

    #[test]
    fn matches_reachability_with_cycles_duplicates_and_disconnected_chunks() {
        check(&[]);
        check(&[vec![0]]);
        check(&[vec![1, 1], vec![2], vec![0, 3], vec![4], vec![3], vec![]]);
        check(&[vec![1, 2], vec![3], vec![3], vec![], vec![5], vec![]]);
    }

    #[test]
    fn matches_every_four_chunk_graph() {
        for mask in 0..(1u32 << 16) {
            let mut edges = vec![Vec::new(); 4];
            for (i, outgoing) in edges.iter_mut().enumerate() {
                for j in 0..4 {
                    if mask & (1 << (i * 4 + j)) != 0 {
                        outgoing.push(j as u32);
                    }
                }
            }
            check(&edges);
        }
    }

    #[test]
    fn handles_long_chains_and_cycles_without_recursion() {
        let n = 50_000;
        let mut edges: Vec<Vec<u32>> = (1..=n).map(|i| vec![i]).collect();
        edges[n as usize - 1].clear();
        let chain = components(&edges);
        assert_eq!(chain.members.len(), n as usize);
        assert!(chain.dependencies.last().unwrap().is_empty());
        edges[n as usize - 1].push(0);
        let cycle = components(&edges);
        assert_eq!(cycle.members.len(), 1);
        assert_eq!(cycle.members[0].len(), n as usize);
        assert!(cycle.dependencies[0].is_empty());
    }
}
