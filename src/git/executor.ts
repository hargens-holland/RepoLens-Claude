/**
 * Safe Git command executor
 *
 * This module provides a sandboxed interface for executing Git commands.
 * Only explicitly allowlisted read-only commands can be executed.
 */

import { spawn } from 'node:child_process';
import type { ExecuteOptions, GitError, GitResult, RawGitOutput } from './types.js';
import { err, ok } from './types.js';

// ============================================
// COMMAND SAFETY
// ============================================

/**
 * Allowlist of safe Git subcommands
 * These are all read-only operations that cannot modify repository state
 */
const SAFE_SUBCOMMANDS = new Set([
  // Repository inspection
  'rev-parse',
  'status',

  // History and refs
  'log',
  'show-ref',
  'for-each-ref',
  'symbolic-ref',
  'branch',
  'tag',

  // Object inspection
  'show',
  'cat-file',
  'ls-tree',
  'ls-files',

  // Diff and comparison
  'diff',
  'diff-tree',

  // Remote inspection (read-only)
  'remote',

  // Config reading
  'config',
]);

/**
 * Flags that make otherwise safe commands dangerous
 */
const DANGEROUS_FLAGS = new Set([
  '--delete',
  '-d',
  '-D',
  '--force',
  '-f',
  '--move',
  '-m',
  '-M',
  '--set-upstream',
  '-u',
  '--unset',
  '--remove-section',
  '--rename-section',
  '--replace-all',
  '--add',
]);

/**
 * Validate that a command is safe to execute
 * Throws if command is not allowlisted
 */
function validateCommand(args: readonly string[]): void {
  if (args.length === 0) {
    throw new GitExecutorError('unsafe_command', 'Empty command');
  }

  const subcommand = args[0];
  if (!subcommand || !SAFE_SUBCOMMANDS.has(subcommand)) {
    throw new GitExecutorError(
      'unsafe_command',
      `Git subcommand not allowlisted: ${subcommand}`,
      { args }
    );
  }

  // Check for dangerous flags
  for (const arg of args) {
    if (DANGEROUS_FLAGS.has(arg)) {
      throw new GitExecutorError(
        'unsafe_command',
        `Dangerous flag not allowed: ${arg}`,
        { args }
      );
    }
  }

  // Special case: 'config' is only safe for reading
  if (subcommand === 'config') {
    // config without --get, --get-all, --list, or --get-regexp might be a write
    const hasReadFlag = args.some(
      (a) => a === '--get' || a === '--get-all' || a === '--list' || a === '-l' || a === '--get-regexp'
    );
    const hasWritePattern = args.some((a) => a.includes('='));

    if (!hasReadFlag || hasWritePattern) {
      throw new GitExecutorError(
        'unsafe_command',
        'git config is only allowed with read flags (--get, --list, etc.)',
        { args }
      );
    }
  }

  // Special case: 'remote' is only safe without add/remove/set-url
  if (subcommand === 'remote') {
    const unsafeRemoteOps = ['add', 'remove', 'rm', 'rename', 'set-url', 'set-head', 'set-branches', 'prune'];
    if (args.some((a) => unsafeRemoteOps.includes(a))) {
      throw new GitExecutorError(
        'unsafe_command',
        'git remote modification operations are not allowed',
        { args }
      );
    }
  }
}

// ============================================
// ERROR HANDLING
// ============================================

/**
 * Custom error class for Git executor errors
 */
export class GitExecutorError extends Error {
  readonly type: GitError['type'];
  readonly command?: string;
  readonly args?: readonly string[];
  readonly stderr?: string;
  readonly exitCode?: number;

  constructor(
    type: GitError['type'],
    message: string,
    details?: {
      command?: string;
      args?: readonly string[];
      stderr?: string;
      exitCode?: number;
    }
  ) {
    super(message);
    this.name = 'GitExecutorError';
    this.type = type;
    this.command = details?.command;
    this.args = details?.args;
    this.stderr = details?.stderr;
    this.exitCode = details?.exitCode;
  }

  toGitError(): GitError {
    return {
      type: this.type,
      message: this.message,
      command: this.command,
      args: this.args,
      stderr: this.stderr,
      exitCode: this.exitCode,
    };
  }
}

// ============================================
// EXECUTOR IMPLEMENTATION
// ============================================

/**
 * Default timeout for git commands (30 seconds)
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Maximum output size to prevent memory issues (50MB)
 */
const MAX_OUTPUT_SIZE = 50 * 1024 * 1024;

/**
 * Interface for the Git executor
 */
export interface GitExecutor {
  /**
   * Execute a git command and return raw output
   * Only safe, read-only commands are allowed
   */
  execute(args: readonly string[], options: ExecuteOptions): Promise<GitResult<RawGitOutput>>;

  /**
   * Check if git is available on the system
   */
  isGitAvailable(): Promise<boolean>;

  /**
   * Verify a path is a git repository
   */
  isRepository(path: string): Promise<boolean>;
}

/**
 * Create a new GitExecutor instance
 */
export function createGitExecutor(gitPath: string = 'git'): GitExecutor {
  return new GitExecutorImpl(gitPath);
}

class GitExecutorImpl implements GitExecutor {
  private readonly gitPath: string;
  private gitAvailable: boolean | null = null;

  constructor(gitPath: string) {
    this.gitPath = gitPath;
  }

  async execute(args: readonly string[], options: ExecuteOptions): Promise<GitResult<RawGitOutput>> {
    // Validate command safety before execution
    try {
      validateCommand(args);
    } catch (e) {
      if (e instanceof GitExecutorError) {
        return err(e.toGitError());
      }
      throw e;
    }

    // Check git availability on first call
    if (this.gitAvailable === null) {
      this.gitAvailable = await this.isGitAvailable();
    }

    if (!this.gitAvailable) {
      return err({
        type: 'git_not_found',
        message: `Git executable not found: ${this.gitPath}`,
      });
    }

    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const startTime = Date.now();

    return new Promise((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutSize = 0;
      let stderrSize = 0;
      let killed = false;

      const child = spawn(this.gitPath, [...args], {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Don't inherit environment to avoid leaking sensitive data
        env: {
          // Minimal environment for git to work
          PATH: process.env['PATH'],
          HOME: process.env['HOME'],
          // Disable git prompts
          GIT_TERMINAL_PROMPT: '0',
          // Use English for consistent output parsing
          LANG: 'C',
          LC_ALL: 'C',
        },
      });

      // Handle timeout
      const timeoutId = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
        // Force kill after 5 seconds if SIGTERM doesn't work
        setTimeout(() => child.kill('SIGKILL'), 5000);
      }, timeout);

      // Handle abort signal
      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          killed = true;
          child.kill('SIGTERM');
        });
      }

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutSize += chunk.length;
        if (stdoutSize <= MAX_OUTPUT_SIZE) {
          stdoutChunks.push(chunk);
        } else if (!killed) {
          killed = true;
          child.kill('SIGTERM');
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrSize += chunk.length;
        if (stderrSize <= MAX_OUTPUT_SIZE) {
          stderrChunks.push(chunk);
        }
      });

      child.on('error', (error) => {
        clearTimeout(timeoutId);
        resolve(
          err({
            type: 'command_failed',
            message: `Failed to spawn git: ${error.message}`,
            command: this.gitPath,
            args,
          })
        );
      });

      child.on('close', (code, signal) => {
        clearTimeout(timeoutId);
        const durationMs = Date.now() - startTime;

        const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        const exitCode = code ?? (signal ? 128 : 1);

        // Handle timeout
        if (killed && signal) {
          resolve(
            err({
              type: 'timeout',
              message: `Git command timed out after ${timeout}ms`,
              command: this.gitPath,
              args,
              stderr,
            })
          );
          return;
        }

        // Handle output size exceeded
        if (stdoutSize > MAX_OUTPUT_SIZE) {
          resolve(
            err({
              type: 'command_failed',
              message: `Git output exceeded maximum size (${MAX_OUTPUT_SIZE} bytes)`,
              command: this.gitPath,
              args,
            })
          );
          return;
        }

        // Return raw output - let caller decide if exitCode !== 0 is an error
        resolve(
          ok({
            stdout,
            stderr,
            exitCode,
            command: this.gitPath,
            args,
            durationMs,
          })
        );
      });
    });
  }

  async isGitAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.gitPath, ['--version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
  }

  async isRepository(path: string): Promise<boolean> {
    const result = await this.execute(['rev-parse', '--git-dir'], { cwd: path });
    return result.ok && result.value.exitCode === 0;
  }
}

// ============================================
// PREDEFINED COMMAND BUILDERS
// ============================================

/**
 * Common Git command configurations
 * These ensure consistent, well-formed commands
 */
export const GitCommands = {
  /**
   * Get commit log with structured output
   * Uses NULL bytes as delimiters for safe parsing
   */
  log(options?: { maxCount?: number; since?: Date; until?: Date; all?: boolean }): readonly string[] {
    const args: string[] = [
      'log',
      // Format: hash, parents, author name, author email, author date,
      //         committer name, committer email, commit date, subject, body
      // %x00 = NULL byte field separator
      // %x01 = NULL byte record separator
      '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%b%x01',
      '--topo-order',
    ];

    if (options?.all !== false) {
      args.push('--all');
    }

    if (options?.maxCount !== undefined) {
      args.push('-n', String(options.maxCount));
    }

    if (options?.since) {
      args.push(`--since=${options.since.toISOString()}`);
    }

    if (options?.until) {
      args.push(`--until=${options.until.toISOString()}`);
    }

    return args;
  },

  /**
   * Get all refs (branches and tags)
   */
  refs(): readonly string[] {
    return [
      'for-each-ref',
      '--format=%(objectname) %(refname) %(objecttype)',
      'refs/heads',
      'refs/remotes',
      'refs/tags',
    ];
  },

  /**
   * Get current HEAD symbolic ref (branch name)
   */
  headRef(): readonly string[] {
    return ['symbolic-ref', '--short', 'HEAD'];
  },

  /**
   * Get current HEAD commit hash
   */
  headCommit(): readonly string[] {
    return ['rev-parse', 'HEAD'];
  },

  /**
   * Verify path is a git repository
   */
  verifyRepo(): readonly string[] {
    return ['rev-parse', '--git-dir'];
  },

  /**
   * List files at a specific commit
   */
  listTree(commitish: string, path?: string): readonly string[] {
    const args = ['ls-tree', '-r', '--name-only', commitish];
    if (path) {
      args.push('--', path);
    }
    return args;
  },

  /**
   * Show file content at a specific commit
   */
  showFile(commitish: string, path: string): readonly string[] {
    return ['show', `${commitish}:${path}`];
  },

  /**
   * Get diff between two commits
   */
  diff(from: string, to: string, options?: { nameOnly?: boolean }): readonly string[] {
    const args = ['diff', from, to];
    if (options?.nameOnly) {
      args.push('--name-only');
    }
    return args;
  },

  /**
   * Get repository config value
   */
  getConfig(key: string): readonly string[] {
    return ['config', '--get', key];
  },

  /**
   * List all config values
   */
  listConfig(): readonly string[] {
    return ['config', '--list'];
  },
} as const;
