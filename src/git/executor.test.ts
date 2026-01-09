import { describe, it, expect, beforeAll } from 'vitest';
import { createGitExecutor, GitCommands } from './executor.js';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

describe('GitExecutor', () => {
  const executor = createGitExecutor();

  describe('command safety', () => {
    it('allows safe read-only commands', async () => {
      const result = await executor.execute(['rev-parse', '--git-dir'], {
        cwd: process.cwd(),
      });
      expect(result.ok).toBe(true);
    });

    it('rejects unknown subcommands', async () => {
      const result = await executor.execute(['push', 'origin', 'main'], {
        cwd: process.cwd(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('unsafe_command');
        expect(result.error.message).toContain('not allowlisted');
      }
    });

    it('rejects dangerous flags', async () => {
      const result = await executor.execute(['branch', '--delete', 'feature'], {
        cwd: process.cwd(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('unsafe_command');
        expect(result.error.message).toContain('Dangerous flag');
      }
    });

    it('rejects git config writes', async () => {
      const result = await executor.execute(['config', 'user.name', 'Hacker'], {
        cwd: process.cwd(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('unsafe_command');
      }
    });

    it('allows git config reads', async () => {
      const result = await executor.execute(['config', '--get', 'user.name'], {
        cwd: process.cwd(),
      });
      // May succeed or fail depending on config, but should not be rejected as unsafe
      expect(result.ok).toBe(true);
    });

    it('rejects remote modification commands', async () => {
      const result = await executor.execute(['remote', 'add', 'evil', 'https://evil.com'], {
        cwd: process.cwd(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('unsafe_command');
      }
    });

    it('allows remote listing', async () => {
      const result = await executor.execute(['remote', '-v'], {
        cwd: process.cwd(),
      });
      expect(result.ok).toBe(true);
    });

    it('rejects empty commands', async () => {
      const result = await executor.execute([], {
        cwd: process.cwd(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('unsafe_command');
      }
    });
  });

  describe('git availability', () => {
    it('reports git as available', async () => {
      const available = await executor.isGitAvailable();
      expect(available).toBe(true);
    });

    it('detects invalid git path', async () => {
      const badExecutor = createGitExecutor('/nonexistent/git');
      const available = await badExecutor.isGitAvailable();
      expect(available).toBe(false);
    });
  });

  describe('repository detection', () => {
    it('identifies current directory as a repo', async () => {
      const isRepo = await executor.isRepository(process.cwd());
      expect(isRepo).toBe(true);
    });

    it('identifies non-repo directories', async () => {
      const isRepo = await executor.isRepository(tmpdir());
      expect(isRepo).toBe(false);
    });
  });

  describe('command execution', () => {
    let testRepoPath: string;

    beforeAll(async () => {
      // Create a temporary git repository for testing
      testRepoPath = await mkdtemp(join(tmpdir(), 'repolens-test-'));
      execSync('git init', { cwd: testRepoPath });
      execSync('git config user.email "test@test.com"', { cwd: testRepoPath });
      execSync('git config user.name "Test"', { cwd: testRepoPath });
      execSync('echo "hello" > test.txt', { cwd: testRepoPath });
      execSync('git add .', { cwd: testRepoPath });
      execSync('git commit -m "Initial commit"', { cwd: testRepoPath });

      return async () => {
        await rm(testRepoPath, { recursive: true, force: true });
      };
    });

    it('executes git log successfully', async () => {
      const result = await executor.execute(GitCommands.log({ maxCount: 10 }), {
        cwd: testRepoPath,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.exitCode).toBe(0);
        expect(result.value.stdout).toContain('Initial commit');
      }
    });

    it('gets refs from repository', async () => {
      const result = await executor.execute(GitCommands.refs(), {
        cwd: testRepoPath,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.exitCode).toBe(0);
        // Should have at least the main/master branch
        expect(result.value.stdout).toMatch(/refs\/heads\/(main|master)/);
      }
    });

    it('gets HEAD commit', async () => {
      const result = await executor.execute(GitCommands.headCommit(), {
        cwd: testRepoPath,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.exitCode).toBe(0);
        // SHA should be 40 hex characters
        expect(result.value.stdout.trim()).toMatch(/^[a-f0-9]{40}$/);
      }
    });

    it('lists files in tree', async () => {
      const headResult = await executor.execute(GitCommands.headCommit(), {
        cwd: testRepoPath,
      });
      expect(headResult.ok).toBe(true);
      if (!headResult.ok) return;

      const sha = headResult.value.stdout.trim();
      const result = await executor.execute(GitCommands.listTree(sha), {
        cwd: testRepoPath,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.stdout).toContain('test.txt');
      }
    });

    it('includes timing information', async () => {
      const result = await executor.execute(['rev-parse', 'HEAD'], {
        cwd: testRepoPath,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('error handling', () => {
    it('handles non-existent directory', async () => {
      const result = await executor.execute(['rev-parse', 'HEAD'], {
        cwd: '/nonexistent/path/that/does/not/exist',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('command_failed');
      }
    });

    it('handles invalid git commands gracefully', async () => {
      const result = await executor.execute(['log', '--invalid-flag-xyz'], {
        cwd: process.cwd(),
      });
      expect(result.ok).toBe(true); // Execution succeeds, but exitCode is non-zero
      if (result.ok) {
        expect(result.value.exitCode).not.toBe(0);
        expect(result.value.stderr.length).toBeGreaterThan(0);
      }
    });
  });
});

describe('GitCommands', () => {
  it('builds log command with defaults', () => {
    const args = GitCommands.log();
    expect(args).toContain('log');
    expect(args).toContain('--all');
    expect(args).toContain('--topo-order');
  });

  it('builds log command with maxCount', () => {
    const args = GitCommands.log({ maxCount: 100 });
    expect(args).toContain('-n');
    expect(args).toContain('100');
  });

  it('builds log command with date filters', () => {
    const since = new Date('2024-01-01');
    const args = GitCommands.log({ since });
    expect(args.some((a) => a.startsWith('--since='))).toBe(true);
  });

  it('builds refs command', () => {
    const args = GitCommands.refs();
    expect(args).toContain('for-each-ref');
    expect(args).toContain('refs/heads');
    expect(args).toContain('refs/remotes');
    expect(args).toContain('refs/tags');
  });

  it('builds diff command', () => {
    const args = GitCommands.diff('HEAD~1', 'HEAD', { nameOnly: true });
    expect(args).toContain('diff');
    expect(args).toContain('HEAD~1');
    expect(args).toContain('HEAD');
    expect(args).toContain('--name-only');
  });
});
