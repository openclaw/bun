"""Graph evidence must retain roots and distinguish incoming edges from SCC ownership."""
import copy
from pathlib import Path
import runpy
import unittest

LIBRARY = runpy.run_path(str(Path(__file__).with_name('tls-cycle-heap.py')), run_name='graph_contract')
PROJECT, TAGS = LIBRARY['project_graph'], LIBRARY['TAGS']


def fixture():
    nodes = []
    for ident in range(10):
        nodes.extend((ident, 16, 0, 0, 0, hex(ident * 16), '0x0'))
    return dict(version=3, type='GCDebugging', nodes=nodes,
        nodeClassNames=['Object'], edgeTypes=['Internal', 'Property', 'Index', 'Variable'],
        edgeNames=list(TAGS), labels=['', 'DOMGCOutput'], roots=[1, 0, 0, 9, 1, 0],
        edges=[1, 5, 1, 0, 2, 6, 1, 1, 3, 7, 1, 2, 4, 8, 1, 3,
               0, 1, 0, 0, 1, 2, 0, 0, 3, 4, 0, 0, 4, 3, 0, 0, 9, 3, 0, 0])


class GraphContract(unittest.TestCase):
    def test_all_roots_and_scc_boundary_are_preserved(self):
        result = PROJECT(fixture())
        target = result['targets'][TAGS[2]]
        self.assertEqual(result['roots'], [dict(id=1, reason='', reachability=''),
                                          dict(id=9, reason='DOMGCOutput', reachability='')])
        self.assertEqual({node['id'] for node in target['scc']}, {3, 4})
        self.assertEqual({edge['source'] for edge in target['incoming']}, {4, 9})
        self.assertEqual([edge['source'] for edge in target['scc_external_incoming']], [9])
        self.assertEqual(target['root_paths'][0]['root']['reason'], 'DOMGCOutput')
        self.assertEqual([(edge['source'], edge['dest']) for edge in target['root_paths'][0]['path']], [(9, 3)])
        self.assertIsNone(target['synthetic_root_path'])
        self.assertEqual([(edge['source'], edge['dest']) for edge in
                          result['targets'][TAGS[1]]['synthetic_root_path']], [(0, 1), (1, 2)])

    def test_absent_dropped_tag_is_inconclusive(self):
        graph = fixture()
        del graph['edges'][8:12]
        target = PROJECT(graph)['targets'][TAGS[2]]
        self.assertFalse(target['present'])
        self.assertEqual(target['interpretation'], 'collected or otherwise absent during this diagnostic')

    def test_repeated_edges_do_not_create_a_second_owner(self):
        graph = fixture()
        graph['edges'].extend([1, 5, 1, 0])
        self.assertEqual(PROJECT(graph)['targets'][TAGS[0]]['node']['id'], 1)

    def test_ambiguous_owner_and_invalid_root_are_rejected(self):
        graph = fixture()
        other = copy.deepcopy(graph)
        other['edges'].extend([2, 5, 1, 0])
        with self.assertRaises(AssertionError):
            PROJECT(other)
        graph['roots'][0] = 99
        with self.assertRaises(AssertionError):
            PROJECT(graph)


if __name__ == '__main__':
    unittest.main()
