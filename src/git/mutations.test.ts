import { describe, it, expect, beforeAll } from 'vitest';
import {
  validateMutation,
  createBranchDeleteMutation,
  formatMutationPreview,
  formatValidationResult,
  getDeletableBranches,
  DEFAULT_MUTATION_CONFIG,
  type MutationConfig,
  type BranchDeleteMutation,
} from './mutations.js';
import { buildGraph } from './graph.js';
import { createGitExecutor } from './executor.js';
import type { Commit, Branch } from './types.js';
import { unsafeCommitHash } from './types.js';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

// Helper to create test commits
function makeCommit(hash: string, parents: string[], subject: string = 'Test'): Commit {
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

function makeBranch(
  name: string,
  hash: string,
  options: { isHead?: boolean; isProtected?: boolean; type?: 'local' | 'remote' } = {}
): Branch {
  return {
    name,
    fullName: `refs/heads/${name}`,
    commitHash: unsafeCommitHash(hash.padEnd(40, '0')),
    type: options.type ?? 'local',
    isHead: options.isHead ?? false,
    isProtected: options.isProtected ?? false,
  };
}

function h(s: string): string {
  return s.padEnd(40, '0');
}

describe('validateMutation', () => {
  describe('branch deletion', () => {
    it('allows deleting non-protected merged branch', () => {
      const c1 = makeCommit('a', []);
      const c2 = makeCommit('b', ['a']);
      const main = makeBranch('main', 'b', { isHead: true });
      const feature = makeBranch('feature', 'a');

      const graph = buildGraph([c1, c2], [main, feature], unsafeCommitHash(h('b')), 'main');

      const mutation: BranchDeleteMutation = {
        type: 'branch_delete',
        description: "Delete local branch 'feature'",
        command: ['branch', '-d', 'feature'],
        isDestructive: false,
        warnings: [],
        branchName: 'feature',
        branchType: 'local',
        isFullyMerged: true,
        force: false,
        commitHash: unsafeCommitHash(h('a')),
      };

      const result = validateMutation(mutation, DEFAULT_MUTATION_CONFIG, graph);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('blocks deleting protected branch', () => {
      const c1 = makeCommit('a', []);
      const main = makeBranch('main', 'a', { isHead: true });
      const develop = makeBranch('develop', 'a');

      const graph = buildGraph([c1], [main, develop], unsafeCommitHash(h('a')), 'main');

      const mutation: BranchDeleteMutation = {
        type: 'branch_delete',
        description: "Delete local branch 'develop'",
        command: ['branch', '-d', 'develop'],
        isDestructive: false,
        warnings: [],
        branchName: 'develop',
        branchType: 'local',
        isFullyMerged: true,
        force: false,
        commitHash: unsafeCommitHash(h('a')),
      };

      const result = validateMutation(mutation, DEFAULT_MUTATION_CONFIG, graph);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('protected'))).toBe(true);
    });

    it('blocks deleting current branch', () => {
      const c1 = makeCommit('a', []);
      const main = makeBranch('main', 'a', { isHead: true });

      const graph = buildGraph([c1], [main], unsafeCommitHash(h('a')), 'main');

      const mutation: BranchDeleteMutation = {
        type: 'branch_delete',
        description: "Delete local branch 'main'",
        command: ['branch', '-d', 'main'],
        isDestructive: false,
        warnings: [],
        branchName: 'main',
        branchType: 'local',
        isFullyMerged: true,
        force: false,
        commitHash: unsafeCommitHash(h('a')),
      };

      const result = validateMutation(mutation, DEFAULT_MUTATION_CONFIG, graph);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('current branch'))).toBe(true);
    });

    it('blocks deleting unmerged branch without force', () => {
      const c1 = makeCommit('a', []);
      const c2 = makeCommit('b', ['a']);
      const main = makeBranch('main', 'a', { isHead: true });
      const feature = makeBranch('feature', 'b');

      const graph = buildGraph([c1, c2], [main, feature], unsafeCommitHash(h('a')), 'main');

      const mutation: BranchDeleteMutation = {
        type: 'branch_delete',
        description: "Delete local branch 'feature'",
        command: ['branch', '-d', 'feature'],
        isDestructive: true,
        warnings: [],
        branchName: 'feature',
        branchType: 'local',
        isFullyMerged: false,
        force: false,
        commitHash: unsafeCommitHash(h('b')),
      };

      const result = validateMutation(mutation, DEFAULT_MUTATION_CONFIG, graph);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('not fully merged'))).toBe(true);
    });

    it('allows force deleting unmerged branch with config', () => {
      const c1 = makeCommit('a', []);
      const c2 = makeCommit('b', ['a']);
      const main = makeBranch('main', 'a', { isHead: true });
      const feature = makeBranch('feature', 'b');

      const graph = buildGraph([c1, c2], [main, feature], unsafeCommitHash(h('a')), 'main');

      const mutation: BranchDeleteMutation = {
        type: 'branch_delete',
        description: "Delete local branch 'feature'",
        command: ['branch', '-D', 'feature'],
        isDestructive: true,
        warnings: [],
        branchName: 'feature',
        branchType: 'local',
        isFullyMerged: false,
        force: true,
        commitHash: unsafeCommitHash(h('b')),
      };

      const config: MutationConfig = {
        ...DEFAULT_MUTATION_CONFIG,
        allowForceDelete: true,
      };

      const result = validateMutation(mutation, config, graph);

      expect(result.valid).toBe(true);
      // Should have warning about data loss
      expect(result.warnings.some((w) => w.includes('lost commits'))).toBe(true);
    });

    it('matches protected branch patterns with glob', () => {
      const c1 = makeCommit('a', []);
      const main = makeBranch('main', 'a', { isHead: true });
      const release = makeBranch('release/1.0', 'a');

      const graph = buildGraph([c1], [main, release], unsafeCommitHash(h('a')), 'main');

      const mutation: BranchDeleteMutation = {
        type: 'branch_delete',
        description: "Delete local branch 'release/1.0'",
        command: ['branch', '-d', 'release/1.0'],
        isDestructive: false,
        warnings: [],
        branchName: 'release/1.0',
        branchType: 'local',
        isFullyMerged: true,
        force: false,
        commitHash: unsafeCommitHash(h('a')),
      };

      const result = validateMutation(mutation, DEFAULT_MUTATION_CONFIG, graph);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('protected'))).toBe(true);
    });
  });
});

describe('getDeletableBranches', () => {
  it('returns non-protected local branches', () => {
    const c1 = makeCommit('a', []);
    const main = makeBranch('main', 'a', { isHead: true });
    const feature = makeBranch('feature', 'a');
    const develop = makeBranch('develop', 'a');

    const graph = buildGraph([c1], [main, feature, develop], unsafeCommitHash(h('a')), 'main');

    const branches = getDeletableBranches(graph, DEFAULT_MUTATION_CONFIG);

    // feature should be deletable, develop is protected, main is current
    const branchNames = branches.map((b) => b.name);
    expect(branchNames).toContain('feature');
    expect(branchNames).not.toContain('main'); // current branch
  });

  it('excludes remote branches by default', () => {
    const c1 = makeCommit('a', []);
    const main = makeBranch('main', 'a', { isHead: true });
    const remote = makeBranch('origin/main', 'a', { type: 'remote' });

    const graph = buildGraph([c1], [main, remote], unsafeCommitHash(h('a')), 'main');

    const branches = getDeletableBranches(graph, DEFAULT_MUTATION_CONFIG);

    expect(branches.find((b) => b.name === 'origin/main')).toBeUndefined();
  });

  it('includes remote branches with config', () => {
    const c1 = makeCommit('a', []);
    const main = makeBranch('main', 'a', { isHead: true });
    const remote = makeBranch('origin/feature', 'a', { type: 'remote' });

    const graph = buildGraph([c1], [main, remote], unsafeCommitHash(h('a')), 'main');

    const config: MutationConfig = {
      ...DEFAULT_MUTATION_CONFIG,
      allowDeleteRemote: true,
    };

    const branches = getDeletableBranches(graph, config);

    expect(branches.find((b) => b.name === 'origin/feature')).toBeDefined();
  });
});

describe('formatMutationPreview', () => {
  it('formats basic mutation preview', () => {
    const mutation: BranchDeleteMutation = {
      type: 'branch_delete',
      description: "Delete local branch 'feature'",
      command: ['branch', '-d', 'feature'],
      isDestructive: false,
      warnings: [],
      branchName: 'feature',
      branchType: 'local',
      isFullyMerged: true,
      force: false,
      commitHash: unsafeCommitHash(h('a')),
    };

    const preview = formatMutationPreview(mutation);

    expect(preview).toContain("Delete local branch 'feature'");
    expect(preview).toContain('git branch -d feature');
  });

  it('includes destructive warning', () => {
    const mutation: BranchDeleteMutation = {
      type: 'branch_delete',
      description: "Delete local branch 'feature'",
      command: ['branch', '-D', 'feature'],
      isDestructive: true,
      warnings: ['Branch is not fully merged'],
      branchName: 'feature',
      branchType: 'local',
      isFullyMerged: false,
      force: true,
      commitHash: unsafeCommitHash(h('a')),
    };

    const preview = formatMutationPreview(mutation);

    expect(preview).toContain('DESTRUCTIVE');
    expect(preview).toContain('Branch is not fully merged');
  });
});

describe('formatValidationResult', () => {
  it('formats errors', () => {
    const result = {
      valid: false,
      errors: ['Branch is protected', 'Cannot delete current branch'],
      warnings: [],
    };

    const formatted = formatValidationResult(result);

    expect(formatted).toContain('Validation failed');
    expect(formatted).toContain('Branch is protected');
    expect(formatted).toContain('Cannot delete current branch');
  });

  it('formats warnings', () => {
    const result = {
      valid: true,
      errors: [],
      warnings: ['This may lose commits'],
    };

    const formatted = formatValidationResult(result);

    expect(formatted).toContain('Warnings');
    expect(formatted).toContain('This may lose commits');
  });
});

describe('createBranchDeleteMutation with real git', { timeout: 30000 }, () => {
  const executor = createGitExecutor();
  let testRepoPath: string;

  beforeAll(async () => {
    testRepoPath = await mkdtemp(join(tmpdir(), 'repolens-mutation-test-'));

    execSync('git init', { cwd: testRepoPath });
    execSync('git config user.email "test@test.com"', { cwd: testRepoPath });
    execSync('git config user.name "Test"', { cwd: testRepoPath });

    // Create initial commit
    execSync('echo "v1" > file.txt', { cwd: testRepoPath });
    execSync('git add .', { cwd: testRepoPath });
    execSync('git commit -m "Initial commit"', { cwd: testRepoPath });

    // Create a feature branch with extra commits
    execSync('git checkout -b feature', { cwd: testRepoPath });
    execSync('echo "v2" > file.txt', { cwd: testRepoPath });
    execSync('git commit -am "Feature commit"', { cwd: testRepoPath });

    // Back to master
    execSync('git checkout master', { cwd: testRepoPath });

    return async () => {
      await rm(testRepoPath, { recursive: true, force: true });
    };
  });

  it('creates mutation for merged branch', async () => {
    // Create and merge a branch
    execSync('git checkout -b merged-feature', { cwd: testRepoPath });
    execSync('git checkout master', { cwd: testRepoPath });
    execSync('git merge merged-feature', { cwd: testRepoPath });

    // Load the repo
    const { loadRepository } = await import('./graph.js');
    const result = await loadRepository(executor, { path: testRepoPath });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { graph } = result.value;
    const mergedBranch = graph.refs.find((r) => r.name === 'merged-feature') as Branch;

    expect(mergedBranch).toBeDefined();

    const mutationResult = await createBranchDeleteMutation(executor, {
      branch: mergedBranch,
      force: false,
      graph,
      path: testRepoPath,
    });

    expect(mutationResult.ok).toBe(true);
    if (!mutationResult.ok) return;

    const mutation = mutationResult.value;
    expect(mutation.isFullyMerged).toBe(true);
    expect(mutation.command).toContain('-d'); // Not -D
  });

  it('creates mutation for unmerged branch', async () => {
    const { loadRepository } = await import('./graph.js');
    const result = await loadRepository(executor, { path: testRepoPath });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { graph } = result.value;
    const featureBranch = graph.refs.find((r) => r.name === 'feature') as Branch;

    expect(featureBranch).toBeDefined();

    const mutationResult = await createBranchDeleteMutation(executor, {
      branch: featureBranch,
      force: false,
      graph,
      path: testRepoPath,
    });

    expect(mutationResult.ok).toBe(true);
    if (!mutationResult.ok) return;

    const mutation = mutationResult.value;
    expect(mutation.isFullyMerged).toBe(false);
    expect(mutation.isDestructive).toBe(true);
    expect(mutation.command).toContain('-D'); // Force because not merged
  });
});
