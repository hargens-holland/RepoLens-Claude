import { describe, it, expect } from 'vitest';
import {
  createVisualGraph,
  getVisibleCommits,
  getVisibleEdges,
  getBoundingBox,
  findCommitAtPosition,
  getEdgePath,
  edgePathToSvg,
  optimizeLanes,
} from './visualization.js';
import { buildGraph } from './graph.js';
import type { Commit, Branch } from './types.js';
import { unsafeCommitHash } from './types.js';

// Helper to create test commits
function makeCommit(
  hash: string,
  parents: string[],
  subject: string = 'Test commit'
): Commit {
  return {
    hash: unsafeCommitHash(hash.padEnd(40, '0')),
    parents: parents.map((p) => unsafeCommitHash(p.padEnd(40, '0'))),
    author: { name: 'Test', email: 'test@test.com' },
    committer: { name: 'Test', email: 'test@test.com' },
    authoredAt: new Date(),
    committedAt: new Date(),
    subject,
    body: '',
  };
}

function makeBranch(name: string, hash: string, isHead: boolean = false): Branch {
  return {
    name,
    fullName: `refs/heads/${name}`,
    commitHash: unsafeCommitHash(hash.padEnd(40, '0')),
    type: 'local',
    isHead,
    isProtected: false,
  };
}

function h(s: string): string {
  return s.padEnd(40, '0');
}

describe('createVisualGraph', () => {
  describe('linear history', () => {
    it('assigns all commits to lane 0', () => {
      const c1 = makeCommit('a', []);
      const c2 = makeCommit('b', ['a']);
      const c3 = makeCommit('c', ['b']);

      const repoGraph = buildGraph(
        [c1, c2, c3],
        [],
        unsafeCommitHash(h('c')),
        null
      );
      const visual = createVisualGraph(repoGraph);

      expect(visual.totalLanes).toBe(1);
      expect(visual.commits).toHaveLength(3);

      // All commits should be in lane 0
      for (const commit of visual.commits) {
        expect(commit.lane).toBe(0);
      }

      // Newest commit (c) at row 0
      expect(visual.commits[0]!.hash).toBe(h('c'));
      expect(visual.commits[0]!.row).toBe(0);

      // Oldest commit (a) at row 2
      expect(visual.commits[2]!.hash).toBe(h('a'));
      expect(visual.commits[2]!.row).toBe(2);
    });

    it('creates straight edges', () => {
      const c1 = makeCommit('a', []);
      const c2 = makeCommit('b', ['a']);

      const repoGraph = buildGraph([c1, c2], [], unsafeCommitHash(h('b')), null);
      const visual = createVisualGraph(repoGraph);

      expect(visual.edges).toHaveLength(1);

      const edge = visual.edges[0]!;
      expect(edge.type).toBe('straight');
      expect(edge.fromLane).toBe(edge.toLane);
    });
  });

  describe('branching', () => {
    it('assigns branches to different lanes', () => {
      // c1 - c2 (main)
      //  \
      //   c3 (feature)
      const c1 = makeCommit('a', []);
      const c2 = makeCommit('b', ['a']);
      const c3 = makeCommit('c', ['a']);

      const repoGraph = buildGraph(
        [c1, c2, c3],
        [],
        unsafeCommitHash(h('b')),
        null
      );
      const visual = createVisualGraph(repoGraph);

      expect(visual.totalLanes).toBeGreaterThanOrEqual(2);

      // c2 and c3 should be in different lanes
      const c2Visual = visual.commitByHash.get(unsafeCommitHash(h('b')));
      const c3Visual = visual.commitByHash.get(unsafeCommitHash(h('c')));

      expect(c2Visual).toBeDefined();
      expect(c3Visual).toBeDefined();
      expect(c2Visual!.lane).not.toBe(c3Visual!.lane);
    });

    it('creates fork edges when branches diverge', () => {
      const c1 = makeCommit('a', []);
      const c2 = makeCommit('b', ['a']);
      const c3 = makeCommit('c', ['a']);

      const repoGraph = buildGraph(
        [c1, c2, c3],
        [],
        unsafeCommitHash(h('b')),
        null
      );
      const visual = createVisualGraph(repoGraph);

      // Should have edges from both c2 and c3 to c1
      const edgesToC1 = visual.edges.filter(
        (e) => e.toHash === unsafeCommitHash(h('a'))
      );
      expect(edgesToC1).toHaveLength(2);
    });
  });

  describe('merging', () => {
    it('handles merge commits', () => {
      //   c1 - c2 - c4 (merge)
      //    \       /
      //     c3 ---
      const c1 = makeCommit('a', []);
      const c2 = makeCommit('b', ['a']);
      const c3 = makeCommit('c', ['a']);
      const c4 = makeCommit('d', ['b', 'c']); // Merge

      const repoGraph = buildGraph(
        [c1, c2, c3, c4],
        [],
        unsafeCommitHash(h('d')),
        null
      );
      const visual = createVisualGraph(repoGraph);

      const mergeCommit = visual.commitByHash.get(unsafeCommitHash(h('d')));
      expect(mergeCommit).toBeDefined();
      expect(mergeCommit!.isMerge).toBe(true);

      // Should have 2 edges from merge commit
      const mergeEdges = visual.edges.filter(
        (e) => e.fromHash === unsafeCommitHash(h('d'))
      );
      expect(mergeEdges).toHaveLength(2);

      // First parent edge should be straight or fork
      expect(mergeEdges[0]!.type).not.toBe('merge');

      // Second parent edge should be merge type
      const secondParentEdge = mergeEdges.find((e) => e.parentIndex === 1);
      expect(secondParentEdge).toBeDefined();
      expect(secondParentEdge!.type).toBe('merge');
    });
  });

  describe('refs', () => {
    it('includes refs on commits', () => {
      const c1 = makeCommit('a', []);
      const main = makeBranch('main', 'a', true);

      const repoGraph = buildGraph(
        [c1],
        [main],
        unsafeCommitHash(h('a')),
        'main'
      );
      const visual = createVisualGraph(repoGraph);

      const commit = visual.commits[0]!;
      expect(commit.refs).toHaveLength(1);
      expect(commit.refs[0]!.name).toBe('main');
      expect(commit.refs[0]!.isHead).toBe(true);
      expect(commit.isBranchTip).toBe(true);
    });

    it('marks protected branches', () => {
      const c1 = makeCommit('a', []);
      const main = makeBranch('main', 'a', true);

      const repoGraph = buildGraph(
        [c1],
        [main],
        unsafeCommitHash(h('a')),
        'main'
      );
      const visual = createVisualGraph(repoGraph, {
        protectedBranches: ['main'],
      });

      const commit = visual.commits[0]!;
      expect(commit.refs[0]!.isProtected).toBe(true);
    });
  });

  describe('root and head detection', () => {
    it('marks root commits', () => {
      const c1 = makeCommit('a', []);
      const c2 = makeCommit('b', ['a']);

      const repoGraph = buildGraph(
        [c1, c2],
        [],
        unsafeCommitHash(h('b')),
        null
      );
      const visual = createVisualGraph(repoGraph);

      const c1Visual = visual.commitByHash.get(unsafeCommitHash(h('a')));
      const c2Visual = visual.commitByHash.get(unsafeCommitHash(h('b')));

      expect(c1Visual!.isRoot).toBe(true);
      expect(c2Visual!.isRoot).toBe(false);
    });

    it('marks HEAD commit', () => {
      const c1 = makeCommit('a', []);
      const c2 = makeCommit('b', ['a']);

      const repoGraph = buildGraph(
        [c1, c2],
        [],
        unsafeCommitHash(h('b')),
        'main'
      );
      const visual = createVisualGraph(repoGraph);

      const c2Visual = visual.commitByHash.get(unsafeCommitHash(h('b')));
      expect(c2Visual!.isHead).toBe(true);
    });
  });

  describe('edge rows', () => {
    it('fills in edge toRow values', () => {
      const c1 = makeCommit('a', []);
      const c2 = makeCommit('b', ['a']);

      const repoGraph = buildGraph([c1, c2], [], unsafeCommitHash(h('b')), null);
      const visual = createVisualGraph(repoGraph);

      const edge = visual.edges[0]!;
      expect(edge.fromRow).toBe(0); // c2 is at row 0
      expect(edge.toRow).toBe(1); // c1 is at row 1
    });
  });
});

describe('getVisibleCommits', () => {
  it('returns commits in row range', () => {
    const commits = Array.from({ length: 10 }, (_, i) =>
      makeCommit(String.fromCharCode(97 + i), i > 0 ? [String.fromCharCode(96 + i)] : [])
    );

    const repoGraph = buildGraph(
      commits,
      [],
      unsafeCommitHash(h('j')),
      null
    );
    const visual = createVisualGraph(repoGraph);

    const visible = getVisibleCommits(visual, 2, 5);
    expect(visible).toHaveLength(4);
    expect(visible[0]!.row).toBe(2);
    expect(visible[3]!.row).toBe(5);
  });

  it('handles range beyond graph bounds', () => {
    const c1 = makeCommit('a', []);
    const repoGraph = buildGraph([c1], [], unsafeCommitHash(h('a')), null);
    const visual = createVisualGraph(repoGraph);

    const visible = getVisibleCommits(visual, 0, 100);
    expect(visible).toHaveLength(1);
  });
});

describe('getVisibleEdges', () => {
  it('returns edges in row range', () => {
    const c1 = makeCommit('a', []);
    const c2 = makeCommit('b', ['a']);
    const c3 = makeCommit('c', ['b']);

    const repoGraph = buildGraph(
      [c1, c2, c3],
      [],
      unsafeCommitHash(h('c')),
      null
    );
    const visual = createVisualGraph(repoGraph);

    // Get edges in rows 0-1 (should get edge from c to b)
    const visible = getVisibleEdges(visual, 0, 1);
    expect(visible.length).toBeGreaterThanOrEqual(1);
  });

  it('includes edges that pass through range', () => {
    // Create a long linear history
    const commits = Array.from({ length: 5 }, (_, i) =>
      makeCommit(String.fromCharCode(97 + i), i > 0 ? [String.fromCharCode(96 + i)] : [])
    );

    const repoGraph = buildGraph(
      commits,
      [],
      unsafeCommitHash(h('e')),
      null
    );
    const visual = createVisualGraph(repoGraph);

    // Get edges that touch row 2 (middle)
    const visible = getVisibleEdges(visual, 2, 2);
    expect(visible.length).toBeGreaterThanOrEqual(1);
  });
});

describe('getBoundingBox', () => {
  it('calculates bounds for commits', () => {
    const c1 = makeCommit('a', []);
    const c2 = makeCommit('b', ['a']);
    const c3 = makeCommit('c', ['a']);

    const repoGraph = buildGraph(
      [c1, c2, c3],
      [],
      unsafeCommitHash(h('b')),
      null
    );
    const visual = createVisualGraph(repoGraph);

    const bounds = getBoundingBox(visual.commits, visual.edges);

    expect(bounds.minRow).toBe(0);
    expect(bounds.maxRow).toBe(2);
    expect(bounds.minLane).toBe(0);
    expect(bounds.maxLane).toBeGreaterThanOrEqual(1);
  });

  it('handles empty graph', () => {
    const bounds = getBoundingBox([], []);
    expect(bounds.minRow).toBe(0);
    expect(bounds.maxRow).toBe(0);
  });
});

describe('findCommitAtPosition', () => {
  it('finds commit at exact position', () => {
    const c1 = makeCommit('a', []);

    const repoGraph = buildGraph([c1], [], unsafeCommitHash(h('a')), null);
    const visual = createVisualGraph(repoGraph);

    const found = findCommitAtPosition(visual, 0, 0);
    expect(found).not.toBeNull();
    expect(found!.hash).toBe(h('a'));
  });

  it('finds commit within tolerance', () => {
    const c1 = makeCommit('a', []);

    const repoGraph = buildGraph([c1], [], unsafeCommitHash(h('a')), null);
    const visual = createVisualGraph(repoGraph);

    const found = findCommitAtPosition(visual, 0, 0.3, 0.5);
    expect(found).not.toBeNull();
  });

  it('returns null outside tolerance', () => {
    const c1 = makeCommit('a', []);

    const repoGraph = buildGraph([c1], [], unsafeCommitHash(h('a')), null);
    const visual = createVisualGraph(repoGraph);

    const found = findCommitAtPosition(visual, 0, 2, 0.5);
    expect(found).toBeNull();
  });
});

describe('getEdgePath', () => {
  it('returns two points for straight edge', () => {
    const edge = {
      id: 'test',
      fromHash: unsafeCommitHash(h('a')),
      toHash: unsafeCommitHash(h('b')),
      fromRow: 0,
      fromLane: 0,
      toRow: 1,
      toLane: 0,
      type: 'straight' as const,
      parentIndex: 0,
    };

    const path = getEdgePath(edge);
    expect(path).toHaveLength(2);
    expect(path[0]).toEqual({ row: 0, lane: 0 });
    expect(path[1]).toEqual({ row: 1, lane: 0 });
  });

  it('adds intermediate points for lane-changing edges', () => {
    const edge = {
      id: 'test',
      fromHash: unsafeCommitHash(h('a')),
      toHash: unsafeCommitHash(h('b')),
      fromRow: 0,
      fromLane: 0,
      toRow: 2,
      toLane: 1,
      type: 'fork' as const,
      parentIndex: 0,
    };

    const path = getEdgePath(edge);
    expect(path.length).toBeGreaterThan(2);
  });
});

describe('edgePathToSvg', () => {
  it('generates valid SVG path', () => {
    const points = [
      { row: 0, lane: 0 },
      { row: 1, lane: 0 },
    ];

    const svg = edgePathToSvg(points, 30, 20, false);
    expect(svg).toMatch(/^M \d+ \d+ L \d+ \d+$/);
  });

  it('handles curves for multiple points', () => {
    const points = [
      { row: 0, lane: 0 },
      { row: 1, lane: 0 },
      { row: 1, lane: 1 },
      { row: 2, lane: 1 },
    ];

    const svg = edgePathToSvg(points, 30, 20, true);
    expect(svg).toContain('Q'); // Quadratic curve
  });
});

describe('optimizeLanes', () => {
  it('returns same graph if no crossings', () => {
    const c1 = makeCommit('a', []);
    const c2 = makeCommit('b', ['a']);

    const repoGraph = buildGraph([c1, c2], [], unsafeCommitHash(h('b')), null);
    const visual = createVisualGraph(repoGraph);

    const optimized = optimizeLanes(visual);

    // Should be unchanged
    expect(optimized.commits[0]!.lane).toBe(visual.commits[0]!.lane);
    expect(optimized.commits[1]!.lane).toBe(visual.commits[1]!.lane);
  });

  it('preserves graph structure after optimization', () => {
    const c1 = makeCommit('a', []);
    const c2 = makeCommit('b', ['a']);
    const c3 = makeCommit('c', ['a']);
    const c4 = makeCommit('d', ['b', 'c']);

    const repoGraph = buildGraph(
      [c1, c2, c3, c4],
      [],
      unsafeCommitHash(h('d')),
      null
    );
    const visual = createVisualGraph(repoGraph);
    const optimized = optimizeLanes(visual);

    // Same number of commits and edges
    expect(optimized.commits.length).toBe(visual.commits.length);
    expect(optimized.edges.length).toBe(visual.edges.length);

    // Same commit hashes
    for (const commit of visual.commits) {
      expect(optimized.commitByHash.has(commit.hash)).toBe(true);
    }
  });
});

describe('complex scenarios', () => {
  it('handles diamond pattern', () => {
    //   c1
    //   / \
    // c2   c3
    //   \ /
    //   c4
    const c1 = makeCommit('a', []);
    const c2 = makeCommit('b', ['a']);
    const c3 = makeCommit('c', ['a']);
    const c4 = makeCommit('d', ['b', 'c']);

    const repoGraph = buildGraph(
      [c1, c2, c3, c4],
      [],
      unsafeCommitHash(h('d')),
      null
    );
    const visual = createVisualGraph(repoGraph);

    expect(visual.commits).toHaveLength(4);
    expect(visual.edges).toHaveLength(4); // 2 from c4, 1 from c2, 1 from c3
  });

  it('handles octopus merge', () => {
    // c1, c2, c3 all merge into c4
    const c1 = makeCommit('a', []);
    const c2 = makeCommit('b', []);
    const c3 = makeCommit('c', []);
    const c4 = makeCommit('d', ['a', 'b', 'c']);

    const repoGraph = buildGraph(
      [c1, c2, c3, c4],
      [],
      unsafeCommitHash(h('d')),
      null
    );
    const visual = createVisualGraph(repoGraph);

    const mergeCommit = visual.commitByHash.get(unsafeCommitHash(h('d')));
    expect(mergeCommit!.isMerge).toBe(true);
    expect(mergeCommit!.edgeIds).toHaveLength(3);
  });

  it('handles multiple root commits', () => {
    const c1 = makeCommit('a', []);
    const c2 = makeCommit('b', []);
    const c3 = makeCommit('c', ['a', 'b']); // Merges two unrelated histories

    const repoGraph = buildGraph(
      [c1, c2, c3],
      [],
      unsafeCommitHash(h('c')),
      null
    );
    const visual = createVisualGraph(repoGraph);

    const roots = visual.commits.filter((c) => c.isRoot);
    expect(roots).toHaveLength(2);
  });

  it('handles long parallel branches', () => {
    // main: c1 - c2 - c3 - c4
    // feat:  \-- c5 - c6 - c7
    const c1 = makeCommit('1', []);
    const c2 = makeCommit('2', ['1']);
    const c3 = makeCommit('3', ['2']);
    const c4 = makeCommit('4', ['3']);
    const c5 = makeCommit('5', ['1']);
    const c6 = makeCommit('6', ['5']);
    const c7 = makeCommit('7', ['6']);

    const repoGraph = buildGraph(
      [c1, c2, c3, c4, c5, c6, c7],
      [],
      unsafeCommitHash(h('4')),
      null
    );
    const visual = createVisualGraph(repoGraph);

    expect(visual.totalLanes).toBeGreaterThanOrEqual(2);

    // Main branch should stay in one lane
    const mainLane = visual.commitByHash.get(unsafeCommitHash(h('4')))!.lane;
    expect(visual.commitByHash.get(unsafeCommitHash(h('3')))!.lane).toBe(mainLane);
    expect(visual.commitByHash.get(unsafeCommitHash(h('2')))!.lane).toBe(mainLane);
  });
});
