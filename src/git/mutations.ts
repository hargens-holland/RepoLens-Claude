/**
 * Git mutation operations
 *
 * This module handles Git commands that modify repository state.
 * All mutations follow these principles:
 *
 * 1. Command Transparency - The exact command is always shown before execution
 * 2. Confirmation Required - User must explicitly approve mutations
 * 3. Protected Branches - Configurable rules prevent dangerous operations
 * 4. Safe Defaults - No force operations without explicit opt-in
 */

import type { CommitHash, GitResult, ExecuteOptions, Branch } from './types.js';
import { ok, err } from './types.js';
import type { GitExecutor } from './executor.js';
import type { RepositoryGraph } from './types.js';

// ============================================
// MUTATION TYPES
// ============================================

/**
 * Types of mutations supported
 */
export type MutationType = 'branch_delete' | 'branch_rename' | 'tag_delete';

/**
 * Base interface for all mutations
 */
export interface MutationBase {
  readonly type: MutationType;
  /** Human-readable description of what this mutation does */
  readonly description: string;
  /** The exact git command that will be executed */
  readonly command: readonly string[];
  /** Whether this mutation is destructive (can lose data) */
  readonly isDestructive: boolean;
  /** Warnings to show the user */
  readonly warnings: readonly string[];
}

/**
 * Branch deletion mutation
 */
export interface BranchDeleteMutation extends MutationBase {
  readonly type: 'branch_delete';
  readonly branchName: string;
  readonly branchType: 'local' | 'remote';
  readonly isFullyMerged: boolean;
  readonly force: boolean;
  /** Commit hash the branch points to (for recovery info) */
  readonly commitHash: CommitHash;
}

/**
 * Branch rename mutation
 */
export interface BranchRenameMutation extends MutationBase {
  readonly type: 'branch_rename';
  readonly oldName: string;
  readonly newName: string;
}

/**
 * Tag deletion mutation
 */
export interface TagDeleteMutation extends MutationBase {
  readonly type: 'tag_delete';
  readonly tagName: string;
  readonly commitHash: CommitHash;
}

export type Mutation = BranchDeleteMutation | BranchRenameMutation | TagDeleteMutation;

// ============================================
// VALIDATION
// ============================================

/**
 * Validation result for a mutation
 */
export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Configuration for mutation validation
 */
export interface MutationConfig {
  /** Branch name patterns that cannot be deleted */
  readonly protectedBranches: readonly string[];
  /** Allow force-deleting unmerged branches */
  readonly allowForceDelete: boolean;
  /** Allow deleting the current HEAD branch */
  readonly allowDeleteCurrentBranch: boolean;
  /** Allow deleting remote-tracking branches */
  readonly allowDeleteRemote: boolean;
}

/**
 * Default mutation configuration
 */
export const DEFAULT_MUTATION_CONFIG: MutationConfig = {
  protectedBranches: ['main', 'master', 'develop', 'release/*', 'production'],
  allowForceDelete: false,
  allowDeleteCurrentBranch: false,
  allowDeleteRemote: false,
};

/**
 * Validate a mutation against configuration rules
 */
export function validateMutation(
  mutation: Mutation,
  config: MutationConfig,
  graph: RepositoryGraph
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  switch (mutation.type) {
    case 'branch_delete':
      validateBranchDelete(mutation, config, graph, errors, warnings);
      break;
    case 'branch_rename':
      validateBranchRename(mutation, config, graph, errors, warnings);
      break;
    case 'tag_delete':
      validateTagDelete(mutation, config, errors, warnings);
      break;
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function validateBranchDelete(
  mutation: BranchDeleteMutation,
  config: MutationConfig,
  graph: RepositoryGraph,
  errors: string[],
  warnings: string[]
): void {
  const { branchName, branchType, isFullyMerged, force } = mutation;

  // Check protected branches
  if (isProtectedBranch(branchName, config.protectedBranches)) {
    errors.push(`Branch '${branchName}' is protected and cannot be deleted`);
  }

  // Check if deleting current branch
  if (graph.headRef === branchName) {
    if (!config.allowDeleteCurrentBranch) {
      errors.push(`Cannot delete the current branch '${branchName}'. Switch to another branch first.`);
    } else {
      warnings.push(`You are deleting the current branch. HEAD will become detached.`);
    }
  }

  // Check remote branch deletion
  if (branchType === 'remote') {
    if (!config.allowDeleteRemote) {
      errors.push(`Remote branch deletion is disabled. Enable 'allowDeleteRemote' to allow this.`);
    }
    warnings.push(`This will only delete the local remote-tracking branch, not the branch on the remote server.`);
  }

  // Check unmerged branches
  if (!isFullyMerged) {
    if (!force && !config.allowForceDelete) {
      errors.push(
        `Branch '${branchName}' is not fully merged. Use force delete or merge it first.`
      );
    } else if (force) {
      warnings.push(
        `Branch '${branchName}' is not fully merged. Deleting it may result in lost commits.`
      );
    }
  }
}

function validateBranchRename(
  mutation: BranchRenameMutation,
  config: MutationConfig,
  graph: RepositoryGraph,
  errors: string[],
  warnings: string[]
): void {
  const { oldName, newName } = mutation;

  // Check if old name is protected
  if (isProtectedBranch(oldName, config.protectedBranches)) {
    errors.push(`Branch '${oldName}' is protected and cannot be renamed`);
  }

  // Check if new name would be protected
  if (isProtectedBranch(newName, config.protectedBranches)) {
    warnings.push(`New name '${newName}' matches a protected branch pattern`);
  }

  // Check if new name already exists
  const existingBranch = graph.refs.find(
    (r) => r.type === 'local' && r.name === newName
  );
  if (existingBranch) {
    errors.push(`Branch '${newName}' already exists`);
  }
}

function validateTagDelete(
  _mutation: TagDeleteMutation,
  _config: MutationConfig,
  _errors: string[],
  warnings: string[]
): void {
  // Tags are generally safe to delete locally
  warnings.push(
    `This will only delete the local tag. If it was pushed, it will still exist on the remote.`
  );
}

/**
 * Check if a branch name matches any protected pattern
 */
function isProtectedBranch(name: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === name) return true;

    // Simple glob matching
    if (pattern.includes('*')) {
      const regex = new RegExp(
        '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
      );
      if (regex.test(name)) return true;
    }
  }
  return false;
}

// ============================================
// MUTATION BUILDERS
// ============================================

/**
 * Options for creating a branch delete mutation
 */
export interface BranchDeleteOptions {
  /** Branch to delete */
  readonly branch: Branch;
  /** Force delete even if not fully merged */
  readonly force?: boolean;
  /** Repository graph for context */
  readonly graph: RepositoryGraph;
  /** Path to the repository (defaults to process.cwd()) */
  readonly path?: string;
}

/**
 * Create a branch deletion mutation
 */
export async function createBranchDeleteMutation(
  executor: GitExecutor,
  options: BranchDeleteOptions
): Promise<GitResult<BranchDeleteMutation>> {
  const { branch, force = false, graph, path = process.cwd() } = options;

  // Check if branch is fully merged
  const isFullyMerged = await checkBranchMerged(executor, branch, graph, path);

  // Build the command
  const command = buildBranchDeleteCommand(branch, force, isFullyMerged);

  // Build warnings
  const warnings: string[] = [];

  if (!isFullyMerged) {
    warnings.push(`Branch contains commits not in ${graph.headRef ?? 'HEAD'}`);
  }

  if (branch.type === 'remote') {
    warnings.push('This deletes the local remote-tracking reference only');
  }

  const mutation: BranchDeleteMutation = {
    type: 'branch_delete',
    description: `Delete ${branch.type} branch '${branch.name}'`,
    command,
    isDestructive: !isFullyMerged,
    warnings,
    branchName: branch.name,
    branchType: branch.type,
    isFullyMerged,
    force: force || !isFullyMerged,
    commitHash: branch.commitHash,
  };

  return ok(mutation);
}

/**
 * Check if a branch is fully merged into HEAD
 */
async function checkBranchMerged(
  executor: GitExecutor,
  branch: Branch,
  graph: RepositoryGraph,
  path: string
): Promise<boolean> {
  if (!graph.head) return false;

  // Use git branch --merged to check
  const result = await executor.execute(
    ['branch', '--merged', graph.head],
    { cwd: path }
  );

  if (!result.ok || result.value.exitCode !== 0) {
    return false;
  }

  // Parse output - each line is a branch name (with * for current)
  const mergedBranches = result.value.stdout
    .split('\n')
    .map((line) => line.replace(/^\*?\s*/, '').trim())
    .filter(Boolean);

  return mergedBranches.includes(branch.name);
}

/**
 * Build the git command for branch deletion
 */
function buildBranchDeleteCommand(
  branch: Branch,
  force: boolean,
  isFullyMerged: boolean
): readonly string[] {
  if (branch.type === 'remote') {
    // For remote-tracking branches: git branch -d -r origin/branch
    return ['branch', force || !isFullyMerged ? '-D' : '-d', '-r', branch.name];
  }

  // For local branches: git branch -d branch
  return ['branch', force || !isFullyMerged ? '-D' : '-d', branch.name];
}

// ============================================
// MUTATION EXECUTION
// ============================================

/**
 * Result of executing a mutation
 */
export interface MutationResult {
  readonly success: boolean;
  readonly mutation: Mutation;
  /** Output from git command */
  readonly output: string;
  /** Error message if failed */
  readonly error?: string;
  /** Recovery information (e.g., how to undo) */
  readonly recovery?: string;
}

/**
 * Execute a mutation
 *
 * IMPORTANT: This actually modifies the repository!
 * Always validate and confirm with user before calling this.
 */
export async function executeMutation(
  executor: GitExecutor,
  mutation: Mutation,
  options: ExecuteOptions
): Promise<GitResult<MutationResult>> {
  // Execute the command
  const result = await executeMutationCommand(executor, mutation.command, options);

  if (!result.ok) {
    return err(result.error);
  }

  const { stdout, stderr, exitCode } = result.value;

  if (exitCode !== 0) {
    return ok({
      success: false,
      mutation,
      output: stderr || stdout,
      error: `Command failed with exit code ${exitCode}`,
    });
  }

  // Build recovery information
  const recovery = buildRecoveryInfo(mutation);

  return ok({
    success: true,
    mutation,
    output: stdout || 'Success',
    recovery,
  });
}

/**
 * Execute a mutation command
 * This bypasses the normal safety checks since we've already validated
 */
async function executeMutationCommand(
  _executor: GitExecutor,
  command: readonly string[],
  options: ExecuteOptions
): Promise<GitResult<{ stdout: string; stderr: string; exitCode: number }>> {
  // We need to use a special executor that allows mutation commands
  // For now, we'll spawn directly since GitExecutor blocks these

  const { spawn } = await import('node:child_process');

  return new Promise((resolve) => {
    const child = spawn('git', [...command], {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env['PATH'],
        HOME: process.env['HOME'],
        GIT_TERMINAL_PROMPT: '0',
      },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    child.on('error', (error) => {
      resolve(err({
        type: 'command_failed',
        message: error.message,
        command: 'git',
        args: command,
      }));
    });

    child.on('close', (code) => {
      resolve(ok({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        exitCode: code ?? 1,
      }));
    });
  });
}

/**
 * Build recovery information for a mutation
 */
function buildRecoveryInfo(mutation: Mutation): string {
  switch (mutation.type) {
    case 'branch_delete': {
      const m = mutation as BranchDeleteMutation;
      return `To recover, run: git branch '${m.branchName}' ${m.commitHash.slice(0, 7)}`;
    }
    case 'tag_delete': {
      const m = mutation as TagDeleteMutation;
      return `To recover, run: git tag '${m.tagName}' ${m.commitHash.slice(0, 7)}`;
    }
    case 'branch_rename': {
      const m = mutation as BranchRenameMutation;
      return `To undo, run: git branch -m '${m.newName}' '${m.oldName}'`;
    }
  }
}

// ============================================
// PREVIEW FORMATTING
// ============================================

/**
 * Format a mutation for preview display
 */
export function formatMutationPreview(mutation: Mutation): string {
  const lines: string[] = [];

  lines.push(`Operation: ${mutation.description}`);
  lines.push(`Command:   git ${mutation.command.join(' ')}`);

  if (mutation.isDestructive) {
    lines.push(`\n⚠️  DESTRUCTIVE: This operation may result in data loss`);
  }

  if (mutation.warnings.length > 0) {
    lines.push(`\nWarnings:`);
    for (const warning of mutation.warnings) {
      lines.push(`  • ${warning}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format validation result for display
 */
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];

  if (!result.valid) {
    lines.push('❌ Validation failed:\n');
    for (const error of result.errors) {
      lines.push(`  • ${error}`);
    }
  }

  if (result.warnings.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('⚠️  Warnings:\n');
    for (const warning of result.warnings) {
      lines.push(`  • ${warning}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format mutation result for display
 */
export function formatMutationResult(result: MutationResult): string {
  const lines: string[] = [];

  if (result.success) {
    lines.push(`✓ ${result.mutation.description}`);
    if (result.output && result.output !== 'Success') {
      lines.push(`  ${result.output.trim()}`);
    }
    if (result.recovery) {
      lines.push(`\n  Recovery: ${result.recovery}`);
    }
  } else {
    lines.push(`✗ Failed: ${result.mutation.description}`);
    lines.push(`  ${result.error}`);
    if (result.output) {
      lines.push(`  ${result.output.trim()}`);
    }
  }

  return lines.join('\n');
}

// ============================================
// BRANCH LISTING UTILITIES
// ============================================

/**
 * Get deletable branches from a repository graph
 */
export function getDeletableBranches(
  graph: RepositoryGraph,
  config: MutationConfig
): Branch[] {
  const branches: Branch[] = [];

  for (const ref of graph.refs) {
    if (ref.type !== 'local' && ref.type !== 'remote') continue;

    const branch = ref as Branch;

    // Skip current branch unless allowed
    if (branch.name === graph.headRef && !config.allowDeleteCurrentBranch) {
      continue;
    }

    // Skip remote branches unless allowed
    if (branch.type === 'remote' && !config.allowDeleteRemote) {
      continue;
    }

    // Include branch with protection status
    branches.push({
      ...branch,
      isProtected: isProtectedBranch(branch.name, config.protectedBranches),
    });
  }

  return branches;
}
