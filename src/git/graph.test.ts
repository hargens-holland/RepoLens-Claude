import { describe, it, expect, beforeAll } from 'vitest';
import {
  buildGraph,
  loadRepository,
  getAncestors,
  getDescendants,
  findMergeBase,
  isAncestor,
  getCommitsBetween,
  getGraphStats,
} from './graph.js';
import type { Commit, GitRef, Branch } from './types.js';
import { unsafeCommitHash } from './types.js';
import { createGitExecutor } from './executor.js';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

// Helper to create test commits
function makeCommit(
  hash: string,
  parents: string[],
  subject: string,
  date: Date = new Date()
): Commit {
  return {
    hash: unsafeCommitHash(hash.padEnd(40, '0')),
    parents: parents.map((p) => unsafeCommitHash(p.padEnd(40, '0'))),
    author: { name: 'Test', email: 'test@test.com' },
    committer: { name: 'Test', email: 'test@test.com' },
    authoredAt: date,
    committedAt: date,
    subject,
    body: '',
  };
}

// Helper to create test refs
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

describe('buildGraph', () => {
  it('builds graph from empty inputs', () => {
    const graph = buildGraph([], [], null, null);

    expect(graph.commits.size).toBe(0);
    expect(graph.refs).toHaveLength(0);
    expect(graph.head).toBeNull();
    expect(graph.headRef).toBeNull();
    expect(graph.roots).toHaveLength(0);
    expect(graph.topologicalOrder).toHaveLength(0);
  });

  it('builds graph with single commit', () => {
    const commit = makeCommit('a', [], 'Initial commit');
    const graph = buildGraph([commit], [], unsafeCommitHash('a'.padEnd(40, '0')), null);

    expect(graph.commits.size).toBe(1);
    expect(graph.commits.get(commit.hash)).toBe(commit);
    expect(graph.roots).toContain(commit.hash);
    expect(graph.topologicalOrder).toEqual([commit.hash]);
  });

  it('builds graph with linear history', () => {
    const c1 = makeCommit('a', [], 'First');
    const c2 = makeCommit('b', ['a'], 'Second');
    const c3 = makeCommit('c', ['b'], 'Third');

    const graph = buildGraph([c1, c2, c3], [], unsafeCommitHash('c'.padEnd(40, '0')), null);

    expect(graph.commits.size).toBe(3);
    expect(graph.roots).toHaveLength(1);
    expect(graph.roots).toContain(c1.hash);

    // Check children index
    expect(graph.children.get(c1.hash)).toContain(c2.hash);
    expect(graph.children.get(c2.hash)).toContain(c3.hash);
    expect(graph.children.get(c3.hash)).toBeUndefined();
  });

  it('builds graph with merge commit', () => {
    //   c1 - c2 - c4 (merge)
    //    \       /
    //     c3 ---
    const c1 = makeCommit('a', [], 'Initial');
    const c2 = makeCommit('b', ['a'], 'On main');
    const c3 = makeCommit('c', ['a'], 'On branch');
    const c4 = makeCommit('d', ['b', 'c'], 'Merge');

    const graph = buildGraph([c1, c2, c3, c4], [], unsafeCommitHash('d'.padEnd(40, '0')), null);

    expect(graph.commits.size).toBe(4);
    expect(graph.roots).toHaveLength(1);

    // c1 has two children
    const c1Children = graph.children.get(c1.hash);
    expect(c1Children).toHaveLength(2);
    expect(c1Children).toContain(c2.hash);
    expect(c1Children).toContain(c3.hash);

    // c2 and c3 each have c4 as child
    expect(graph.children.get(c2.hash)).toContain(c4.hash);
    expect(graph.children.get(c3.hash)).toContain(c4.hash);
  });

  it('indexes refs by name and commit', () => {
    const commit = makeCommit('a', [], 'Initial');
    const branch = makeBranch('main', 'a', true);

    const graph = buildGraph([commit], [branch], commit.hash, 'main');

    // Lookup by name
    expect(graph.commitsByRef.get('main')).toBe(commit.hash);
    expect(graph.commitsByRef.get('refs/heads/main')).toBe(commit.hash);

    // Lookup by commit
    const refsAtCommit = graph.refsByCommit.get(commit.hash);
    expect(refsAtCommit).toHaveLength(1);
    expect(refsAtCommit![0]).toBe(branch);
  });

  it('handles multiple refs on same commit', () => {
    const commit = makeCommit('a', [], 'Initial');
    const main = makeBranch('main', 'a', true);
    const develop = makeBranch('develop', 'a', false);

    const graph = buildGraph([commit], [main, develop], commit.hash, 'main');

    const refsAtCommit = graph.refsByCommit.get(commit.hash);
    expect(refsAtCommit).toHaveLength(2);
  });

  it('identifies roots when parents are outside commit set', () => {
    // Simulate loading only recent commits
    const c2 = makeCommit('b', ['a'], 'Second'); // parent 'a' not in set
    const c3 = makeCommit('c', ['b'], 'Third');

    const graph = buildGraph([c2, c3], [], unsafeCommitHash('c'.padEnd(40, '0')), null);

    // c2 should be a root since its parent isn't in our set
    expect(graph.roots).toHaveLength(1);
    expect(graph.roots).toContain(c2.hash);
  });

  it('preserves topological order from input', () => {
    const c1 = makeCommit('a', [], 'First');
    const c2 = makeCommit('b', ['a'], 'Second');
    const c3 = makeCommit('c', ['b'], 'Third');

    const graph = buildGraph([c1, c2, c3], [], unsafeCommitHash('c'.padEnd(40, '0')), null);

    expect(graph.topologicalOrder).toEqual([c1.hash, c2.hash, c3.hash]);
  });
});

describe('getAncestors', () => {
  it('returns empty for root commit', () => {
    const c1 = makeCommit('a', [], 'Root');
    const graph = buildGraph([c1], [], c1.hash, null);

    const ancestors = getAncestors(graph, c1.hash);
    expect(ancestors).toHaveLength(0);
  });

  it('returns all ancestors in BFS order', () => {
    const c1 = makeCommit('a', [], 'First');
    const c2 = makeCommit('b', ['a'], 'Second');
    const c3 = makeCommit('c', ['b'], 'Third');

    const graph = buildGraph([c1, c2, c3], [], c3.hash, null);

    const ancestors = getAncestors(graph, c3.hash);
    expect(ancestors).toHaveLength(2);
    expect(ancestors[0]).toBe(c2.hash); // Closest first
    expect(ancestors[1]).toBe(c1.hash);
  });

  it('respects maxDepth', () => {
    const c1 = makeCommit('a', [], 'First');
    const c2 = makeCommit('b', ['a'], 'Second');
    const c3 = makeCommit('c', ['b'], 'Third');

    const graph = buildGraph([c1, c2, c3], [], c3.hash, null);

    const ancestors = getAncestors(graph, c3.hash, 1);
    expect(ancestors).toHaveLength(1);
    expect(ancestors[0]).toBe(c2.hash);
  });

  it('handles merge commits', () => {
    const c1 = makeCommit('a', [], 'Initial');
    const c2 = makeCommit('b', ['a'], 'On main');
    const c3 = makeCommit('c', ['a'], 'On branch');
    const c4 = makeCommit('d', ['b', 'c'], 'Merge');

    const graph = buildGraph([c1, c2, c3, c4], [], c4.hash, null);

    const ancestors = getAncestors(graph, c4.hash);
    expect(ancestors).toHaveLength(3);
    // Both parents at depth 1, then c1 at depth 2
    expect(ancestors).toContain(c2.hash);
    expect(ancestors).toContain(c3.hash);
    expect(ancestors).toContain(c1.hash);
  });
});

describe('getDescendants', () => {
  it('returns empty for tip commit', () => {
    const c1 = makeCommit('a', [], 'Root');
    const graph = buildGraph([c1], [], c1.hash, null);

    const descendants = getDescendants(graph, c1.hash);
    expect(descendants).toHaveLength(0);
  });

  it('returns all descendants in BFS order', () => {
    const c1 = makeCommit('a', [], 'First');
    const c2 = makeCommit('b', ['a'], 'Second');
    const c3 = makeCommit('c', ['b'], 'Third');

    const graph = buildGraph([c1, c2, c3], [], c3.hash, null);

    const descendants = getDescendants(graph, c1.hash);
    expect(descendants).toHaveLength(2);
    expect(descendants[0]).toBe(c2.hash); // Closest first
    expect(descendants[1]).toBe(c3.hash);
  });

  it('handles branching', () => {
    const c1 = makeCommit('a', [], 'Initial');
    const c2 = makeCommit('b', ['a'], 'Branch 1');
    const c3 = makeCommit('c', ['a'], 'Branch 2');

    const graph = buildGraph([c1, c2, c3], [], c3.hash, null);

    const descendants = getDescendants(graph, c1.hash);
    expect(descendants).toHaveLength(2);
    expect(descendants).toContain(c2.hash);
    expect(descendants).toContain(c3.hash);
  });
});

describe('findMergeBase', () => {
  it('returns null for unrelated commits', () => {
    const c1 = makeCommit('a', [], 'Root 1');
    const c2 = makeCommit('b', [], 'Root 2');

    const graph = buildGraph([c1, c2], [], c2.hash, null);

    const mergeBase = findMergeBase(graph, c1.hash, c2.hash);
    expect(mergeBase).toBeNull();
  });

  it('finds common ancestor', () => {
    const c1 = makeCommit('a', [], 'Initial');
    const c2 = makeCommit('b', ['a'], 'On main');
    const c3 = makeCommit('c', ['a'], 'On branch');

    const graph = buildGraph([c1, c2, c3], [], c3.hash, null);

    const mergeBase = findMergeBase(graph, c2.hash, c3.hash);
    expect(mergeBase).toBe(c1.hash);
  });

  it('returns ancestor when one commit is ancestor of other', () => {
    const c1 = makeCommit('a', [], 'First');
    const c2 = makeCommit('b', ['a'], 'Second');
    const c3 = makeCommit('c', ['b'], 'Third');

    const graph = buildGraph([c1, c2, c3], [], c3.hash, null);

    // c1 is ancestor of c3
    const mergeBase = findMergeBase(graph, c1.hash, c3.hash);
    expect(mergeBase).toBe(c1.hash);

    // Same in reverse
    const mergeBase2 = findMergeBase(graph, c3.hash, c1.hash);
    expect(mergeBase2).toBe(c1.hash);
  });

  it('finds most recent common ancestor', () => {
    //   c1 - c2 - c4
    //    \   |
    //     c3 - c5
    const c1 = makeCommit('a', [], 'Initial');
    const c2 = makeCommit('b', ['a'], 'Main');
    const c3 = makeCommit('c', ['a'], 'Branch from c1');
    const c4 = makeCommit('d', ['b'], 'Main tip');
    const c5 = makeCommit('e', ['c'], 'Branch tip');

    const graph = buildGraph([c1, c2, c3, c4, c5], [], c5.hash, null);

    const mergeBase = findMergeBase(graph, c4.hash, c5.hash);
    expect(mergeBase).toBe(c1.hash);
  });
});

describe('isAncestor', () => {
  it('returns false for same commit', () => {
    const c1 = makeCommit('a', [], 'Root');
    const graph = buildGraph([c1], [], c1.hash, null);

    expect(isAncestor(graph, c1.hash, c1.hash)).toBe(false);
  });

  it('returns true for direct parent', () => {
    const c1 = makeCommit('a', [], 'First');
    const c2 = makeCommit('b', ['a'], 'Second');

    const graph = buildGraph([c1, c2], [], c2.hash, null);

    expect(isAncestor(graph, c1.hash, c2.hash)).toBe(true);
    expect(isAncestor(graph, c2.hash, c1.hash)).toBe(false);
  });

  it('returns true for indirect ancestor', () => {
    const c1 = makeCommit('a', [], 'First');
    const c2 = makeCommit('b', ['a'], 'Second');
    const c3 = makeCommit('c', ['b'], 'Third');

    const graph = buildGraph([c1, c2, c3], [], c3.hash, null);

    expect(isAncestor(graph, c1.hash, c3.hash)).toBe(true);
  });

  it('returns false for unrelated commits', () => {
    const c1 = makeCommit('a', [], 'Root 1');
    const c2 = makeCommit('b', [], 'Root 2');

    const graph = buildGraph([c1, c2], [], c2.hash, null);

    expect(isAncestor(graph, c1.hash, c2.hash)).toBe(false);
  });
});

describe('getCommitsBetween', () => {
  it('returns commits reachable from include but not exclude', () => {
    const c1 = makeCommit('a', [], 'Initial');
    const c2 = makeCommit('b', ['a'], 'On main');
    const c3 = makeCommit('c', ['a'], 'On branch');
    const c4 = makeCommit('d', ['c'], 'Branch tip');

    const graph = buildGraph([c1, c2, c3, c4], [], c4.hash, null);

    // Commits on branch not on main
    const branchCommits = getCommitsBetween(graph, c4.hash, c2.hash);
    expect(branchCommits).toHaveLength(2);
    expect(branchCommits).toContain(c3.hash);
    expect(branchCommits).toContain(c4.hash);
    expect(branchCommits).not.toContain(c1.hash); // Common ancestor excluded
  });

  it('returns empty when include is ancestor of exclude', () => {
    const c1 = makeCommit('a', [], 'First');
    const c2 = makeCommit('b', ['a'], 'Second');

    const graph = buildGraph([c1, c2], [], c2.hash, null);

    const commits = getCommitsBetween(graph, c1.hash, c2.hash);
    expect(commits).toHaveLength(0);
  });
});

describe('getGraphStats', () => {
  it('computes stats for empty graph', () => {
    const graph = buildGraph([], [], null, null);
    const stats = getGraphStats(graph);

    expect(stats.totalCommits).toBe(0);
    expect(stats.totalBranches).toBe(0);
    expect(stats.totalTags).toBe(0);
    expect(stats.mergeCommits).toBe(0);
    expect(stats.oldestCommit).toBeNull();
    expect(stats.newestCommit).toBeNull();
  });

  it('computes stats correctly', () => {
    const oldDate = new Date('2024-01-01');
    const newDate = new Date('2024-06-01');

    const c1 = makeCommit('a', [], 'Initial', oldDate);
    const c2 = makeCommit('b', ['a'], 'On main', new Date('2024-03-01'));
    const c3 = makeCommit('c', ['a'], 'On branch', new Date('2024-02-01'));
    const c4 = makeCommit('d', ['b', 'c'], 'Merge', newDate);

    const main = makeBranch('main', 'd', true);
    const feature: GitRef = {
      name: 'v1.0.0',
      fullName: 'refs/tags/v1.0.0',
      commitHash: unsafeCommitHash('a'.padEnd(40, '0')),
      type: 'tag',
      isHead: false,
    };

    const graph = buildGraph([c1, c2, c3, c4], [main, feature], c4.hash, 'main');
    const stats = getGraphStats(graph);

    expect(stats.totalCommits).toBe(4);
    expect(stats.totalBranches).toBe(1);
    expect(stats.totalTags).toBe(1);
    expect(stats.totalRoots).toBe(1);
    expect(stats.mergeCommits).toBe(1);
    expect(stats.maxParents).toBe(2);
    expect(stats.oldestCommit).toEqual(oldDate);
    expect(stats.newestCommit).toEqual(newDate);
  });
});

describe('loadRepository', { timeout: 30000 }, () => {
  const executor = createGitExecutor();
  let testRepoPath: string;

  beforeAll(async () => {
    // Create a test repository with some history
    testRepoPath = await mkdtemp(join(tmpdir(), 'repolens-graph-test-'));

    execSync('git init', { cwd: testRepoPath });
    execSync('git config user.email "test@test.com"', { cwd: testRepoPath });
    execSync('git config user.name "Test"', { cwd: testRepoPath });

    // Create initial commit
    execSync('echo "v1" > file.txt', { cwd: testRepoPath });
    execSync('git add .', { cwd: testRepoPath });
    execSync('git commit -m "Initial commit"', { cwd: testRepoPath });

    // Create a branch and commit
    execSync('git checkout -b feature', { cwd: testRepoPath });
    execSync('echo "v2" > file.txt', { cwd: testRepoPath });
    execSync('git commit -am "Feature commit"', { cwd: testRepoPath });

    // Back to main and commit
    execSync('git checkout master', { cwd: testRepoPath });
    execSync('echo "v3" > other.txt', { cwd: testRepoPath });
    execSync('git add .', { cwd: testRepoPath });
    execSync('git commit -m "Main commit"', { cwd: testRepoPath });

    // Merge
    execSync('git merge feature -m "Merge feature"', { cwd: testRepoPath });

    // Create a tag
    execSync('git tag v1.0.0', { cwd: testRepoPath });

    return async () => {
      await rm(testRepoPath, { recursive: true, force: true });
    };
  });

  it('loads repository successfully', async () => {
    const result = await loadRepository(executor, { path: testRepoPath });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { graph, warnings, loadTimeMs } = result.value;

    expect(graph.commits.size).toBe(4);
    expect(graph.refs.length).toBeGreaterThan(0);
    expect(graph.head).not.toBeNull();
    expect(graph.headRef).toBe('master');
    expect(loadTimeMs).toBeGreaterThanOrEqual(0);
    expect(warnings).toHaveLength(0);
  });

  it('identifies merge commits', async () => {
    const result = await loadRepository(executor, { path: testRepoPath });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const stats = getGraphStats(result.value.graph);
    expect(stats.mergeCommits).toBe(1);
  });

  it('loads refs correctly', async () => {
    const result = await loadRepository(executor, { path: testRepoPath });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { graph } = result.value;

    // Should have master, feature branches and v1.0.0 tag
    const branchNames = graph.refs
      .filter((r) => r.type === 'local')
      .map((r) => r.name);
    expect(branchNames).toContain('master');
    expect(branchNames).toContain('feature');

    const tagNames = graph.refs
      .filter((r) => r.type === 'tag')
      .map((r) => r.name);
    expect(tagNames).toContain('v1.0.0');
  });

  it('marks protected branches', async () => {
    const result = await loadRepository(executor, {
      path: testRepoPath,
      protectedBranches: ['master'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const masterRef = result.value.graph.refs.find(
      (r) => r.name === 'master' && r.type === 'local'
    ) as Branch;

    expect(masterRef).toBeDefined();
    expect(masterRef.isProtected).toBe(true);
  });

  it('respects maxCommits option', async () => {
    const result = await loadRepository(executor, {
      path: testRepoPath,
      maxCommits: 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.graph.commits.size).toBe(2);
  });

  it('returns error for non-repo path', async () => {
    const result = await loadRepository(executor, { path: tmpdir() });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.type).toBe('not_a_repo');
  });

  it('handles empty repository', async () => {
    const emptyRepoPath = await mkdtemp(join(tmpdir(), 'repolens-empty-'));
    execSync('git init', { cwd: emptyRepoPath });

    try {
      const result = await loadRepository(executor, { path: emptyRepoPath });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.graph.commits.size).toBe(0);
      expect(result.value.warnings).toContain('Repository has no commits');
    } finally {
      await rm(emptyRepoPath, { recursive: true, force: true });
    }
  });
});
