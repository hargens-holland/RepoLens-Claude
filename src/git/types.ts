/**
 * Core Git data types for RepoLens
 * These types are UI-agnostic and represent the parsed Git state
 */

// ============================================
// BRANDED TYPES
// ============================================

/**
 * Unique identifier for a commit (full 40-char SHA)
 * Branded type prevents accidental string mixing
 */
export type CommitHash = string & { readonly __brand: 'CommitHash' };

/**
 * Type guard to validate a commit hash
 */
export function isCommitHash(value: string): value is CommitHash {
  return /^[a-f0-9]{40}$/.test(value);
}

/**
 * Create a CommitHash from a string (validates format)
 */
export function toCommitHash(value: string): CommitHash {
  const trimmed = value.trim().toLowerCase();
  if (!isCommitHash(trimmed)) {
    throw new Error(`Invalid commit hash: ${value}`);
  }
  return trimmed;
}

/**
 * Create a CommitHash without validation (use when source is trusted)
 */
export function unsafeCommitHash(value: string): CommitHash {
  return value.trim().toLowerCase() as CommitHash;
}

// ============================================
// GIT ENTITIES
// ============================================

/**
 * Author/committer identity
 */
export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

/**
 * Core commit representation
 * Immutable after parsing
 */
export interface Commit {
  readonly hash: CommitHash;
  readonly parents: readonly CommitHash[];
  readonly author: GitIdentity;
  readonly committer: GitIdentity;
  readonly authoredAt: Date;
  readonly committedAt: Date;
  readonly subject: string;
  readonly body: string;
}

/**
 * Reference types in Git
 */
export type RefType = 'local' | 'remote' | 'tag';

/**
 * A Git reference (branch or tag)
 */
export interface GitRef {
  readonly name: string;
  readonly fullName: string;
  readonly commitHash: CommitHash;
  readonly type: RefType;
  readonly isHead: boolean;
}

/**
 * Branch-specific reference
 */
export interface Branch extends GitRef {
  readonly type: 'local' | 'remote';
  readonly remoteName?: string;
  readonly trackingRef?: string;
  readonly isProtected: boolean;
}

/**
 * Tag reference
 */
export interface Tag extends GitRef {
  readonly type: 'tag';
  readonly isAnnotated: boolean;
  readonly taggerInfo?: GitIdentity;
  readonly tagMessage?: string;
}

// ============================================
// GRAPH STRUCTURES
// ============================================

/**
 * The complete parsed repository state
 */
export interface RepositoryGraph {
  readonly commits: ReadonlyMap<CommitHash, Commit>;
  readonly refs: readonly GitRef[];
  readonly head: CommitHash | null;
  readonly headRef: string | null;

  readonly children: ReadonlyMap<CommitHash, readonly CommitHash[]>;
  readonly commitsByRef: ReadonlyMap<string, CommitHash>;
  readonly refsByCommit: ReadonlyMap<CommitHash, readonly GitRef[]>;

  readonly roots: readonly CommitHash[];
  readonly topologicalOrder: readonly CommitHash[];
}

// ============================================
// COMMAND EXECUTION TYPES
// ============================================

/**
 * Raw output from git commands before parsing
 */
export interface RawGitOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly command: string;
  readonly args: readonly string[];
  readonly durationMs: number;
}

/**
 * Git error categories
 */
export type GitErrorType =
  | 'not_a_repo'
  | 'command_failed'
  | 'parse_error'
  | 'timeout'
  | 'unsafe_command'
  | 'git_not_found'
  | 'empty_repo';

/**
 * Structured Git error
 */
export interface GitError {
  readonly type: GitErrorType;
  readonly message: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly stderr?: string;
  readonly exitCode?: number;
}

/**
 * Result type for Git operations
 */
export type GitResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: GitError };

/**
 * Helper to create success result
 */
export function ok<T>(value: T): GitResult<T> {
  return { ok: true, value };
}

/**
 * Helper to create error result
 */
export function err<T>(error: GitError): GitResult<T> {
  return { ok: false, error };
}

// ============================================
// CONFIGURATION
// ============================================

/**
 * Options for parsing a repository
 */
export interface ParseOptions {
  readonly repoPath: string;
  readonly maxCommits?: number;
  readonly since?: Date;
  readonly until?: Date;
  readonly branches?: readonly string[];
  readonly protectedBranches?: readonly string[];
}

/**
 * Options for command execution
 */
export interface ExecuteOptions {
  readonly cwd: string;
  readonly timeout?: number;
  readonly signal?: AbortSignal;
}
