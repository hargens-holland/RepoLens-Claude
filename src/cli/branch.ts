/**
 * Branch management CLI commands
 *
 * Provides interactive branch operations with preview and confirmation.
 */

import * as readline from 'node:readline';
import type { RepositoryGraph, Branch } from '../git/types.js';
import type { GitExecutor } from '../git/executor.js';
import {
  createBranchDeleteMutation,
  validateMutation,
  executeMutation,
  formatMutationPreview,
  formatValidationResult,
  formatMutationResult,
  getDeletableBranches,
  DEFAULT_MUTATION_CONFIG,
  type MutationConfig,
} from '../git/mutations.js';

// ============================================
// COLORS
// ============================================

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
} as const;

function color(text: string, ...codes: string[]): string {
  return `${codes.join('')}${text}${COLORS.reset}`;
}

// ============================================
// INTERACTIVE PROMPTS
// ============================================

/**
 * Create a readline interface for interactive input
 */
function createReadline(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

/**
 * Prompt user for confirmation
 */
async function confirm(message: string, defaultValue: boolean = false): Promise<boolean> {
  const rl = createReadline();
  const hint = defaultValue ? '[Y/n]' : '[y/N]';

  return new Promise((resolve) => {
    rl.question(`${message} ${hint} `, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();

      if (normalized === '') {
        resolve(defaultValue);
      } else {
        resolve(normalized === 'y' || normalized === 'yes');
      }
    });
  });
}

/**
 * Prompt user to select from a list
 */
async function select<T>(
  message: string,
  options: Array<{ label: string; value: T; disabled?: boolean; hint?: string }>
): Promise<T | null> {
  const rl = createReadline();

  console.log(`\n${color(message, COLORS.bold)}\n`);

  options.forEach((option, index) => {
    const num = `${index + 1}.`;
    if (option.disabled) {
      console.log(color(`  ${num} ${option.label} (protected)`, COLORS.dim));
    } else {
      const hint = option.hint ? color(` ${option.hint}`, COLORS.dim) : '';
      console.log(`  ${color(num, COLORS.cyan)} ${option.label}${hint}`);
    }
  });

  console.log(`  ${color('0.', COLORS.cyan)} Cancel\n`);

  return new Promise((resolve) => {
    rl.question('Select option: ', (answer) => {
      rl.close();
      const num = parseInt(answer.trim(), 10);

      if (num === 0 || isNaN(num)) {
        resolve(null);
      } else if (num > 0 && num <= options.length) {
        const selected = options[num - 1]!;
        if (selected.disabled) {
          console.log(color('\nCannot select protected branch', COLORS.red));
          resolve(null);
        } else {
          resolve(selected.value);
        }
      } else {
        console.log(color('\nInvalid selection', COLORS.red));
        resolve(null);
      }
    });
  });
}

// ============================================
// BRANCH COMMANDS
// ============================================

/**
 * Options for branch delete command
 */
export interface BranchDeleteCommandOptions {
  readonly repoPath: string;
  readonly branchName?: string;
  readonly force?: boolean;
  readonly yes?: boolean;
  readonly noColor?: boolean;
}

/**
 * Interactive branch deletion command
 */
export async function branchDeleteCommand(
  executor: GitExecutor,
  graph: RepositoryGraph,
  options: BranchDeleteCommandOptions
): Promise<boolean> {
  const useColors = !options.noColor && process.stdout.isTTY;
  const c = useColors ? COLORS : { reset: '', bold: '', dim: '', red: '', green: '', yellow: '', blue: '', cyan: '' };

  // Get config
  const config: MutationConfig = {
    ...DEFAULT_MUTATION_CONFIG,
    allowForceDelete: options.force ?? false,
  };

  // Get deletable branches
  const branches = getDeletableBranches(graph, config);

  if (branches.length === 0) {
    console.log('No branches available for deletion.');
    return false;
  }

  // Select branch to delete
  let branchToDelete: Branch | null = null;

  if (options.branchName) {
    // Branch specified on command line
    branchToDelete = branches.find((b) => b.name === options.branchName) ?? null;
    if (!branchToDelete) {
      console.error(`${c.red}Branch '${options.branchName}' not found or not deletable${c.reset}`);
      return false;
    }
  } else {
    // Interactive selection
    const branchOptions = branches.map((branch) => ({
      label: formatBranchLabel(branch, graph, useColors),
      value: branch,
      disabled: branch.isProtected,
      hint: branch.isProtected ? '(protected)' : undefined,
    }));

    branchToDelete = await select('Select branch to delete:', branchOptions);

    if (!branchToDelete) {
      console.log('Cancelled.');
      return false;
    }
  }

  // Create mutation
  const mutationResult = await createBranchDeleteMutation(executor, {
    branch: branchToDelete,
    force: options.force,
    graph,
  });

  if (!mutationResult.ok) {
    console.error(`${c.red}Error: ${mutationResult.error.message}${c.reset}`);
    return false;
  }

  const mutation = mutationResult.value;

  // Validate mutation
  const validation = validateMutation(mutation, config, graph);

  if (!validation.valid) {
    console.log(`\n${formatValidationResult(validation)}`);
    return false;
  }

  // Show preview
  console.log(`\n${c.bold}Preview:${c.reset}\n`);
  console.log(formatMutationPreview(mutation));

  if (validation.warnings.length > 0) {
    console.log(`\n${c.yellow}Warnings:${c.reset}`);
    for (const warning of validation.warnings) {
      console.log(`  ${c.yellow}•${c.reset} ${warning}`);
    }
  }

  // Confirm unless --yes flag
  if (!options.yes) {
    const confirmed = await confirm(
      `\n${c.bold}Delete branch '${branchToDelete.name}'?${c.reset}`,
      false
    );

    if (!confirmed) {
      console.log('Cancelled.');
      return false;
    }
  }

  // Execute mutation
  console.log(`\nExecuting: ${c.dim}git ${mutation.command.join(' ')}${c.reset}\n`);

  const result = await executeMutation(executor, mutation, { cwd: options.repoPath });

  if (!result.ok) {
    console.error(`${c.red}Error: ${result.error.message}${c.reset}`);
    return false;
  }

  // Show result
  console.log(formatMutationResult(result.value));

  return result.value.success;
}

/**
 * Format a branch label for display
 */
function formatBranchLabel(branch: Branch, graph: RepositoryGraph, useColors: boolean): string {
  const c = useColors ? COLORS : { reset: '', bold: '', dim: '', red: '', green: '', yellow: '', blue: '', cyan: '' };

  let label = branch.name;

  if (branch.name === graph.headRef) {
    label = `${c.cyan}${label}${c.reset} ${c.dim}(current)${c.reset}`;
  } else if (branch.type === 'remote') {
    label = `${c.red}${label}${c.reset}`;
  } else {
    label = `${c.green}${label}${c.reset}`;
  }

  // Add commit info
  label += ` ${c.dim}${branch.commitHash.slice(0, 7)}${c.reset}`;

  return label;
}

/**
 * List branches command
 */
export async function branchListCommand(
  graph: RepositoryGraph,
  options: { noColor?: boolean; all?: boolean }
): Promise<void> {
  const useColors = !options.noColor && process.stdout.isTTY;
  const c = useColors ? COLORS : { reset: '', bold: '', dim: '', red: '', green: '', yellow: '', blue: '', cyan: '' };

  const config = {
    ...DEFAULT_MUTATION_CONFIG,
    allowDeleteRemote: options.all ?? false,
  };

  const branches = options.all
    ? graph.refs.filter((r) => r.type === 'local' || r.type === 'remote') as Branch[]
    : graph.refs.filter((r) => r.type === 'local') as Branch[];

  if (branches.length === 0) {
    console.log('No branches found.');
    return;
  }

  console.log(`\n${c.bold}Branches:${c.reset}\n`);

  for (const branch of branches) {
    const isCurrent = branch.name === graph.headRef;
    const isProtected = isProtectedBranch(branch.name, config.protectedBranches);

    let prefix = '  ';
    if (isCurrent) {
      prefix = `${c.green}* ${c.reset}`;
    }

    let name = branch.name;
    if (branch.type === 'remote') {
      name = `${c.red}${name}${c.reset}`;
    } else if (isCurrent) {
      name = `${c.green}${name}${c.reset}`;
    }

    let suffix = '';
    if (isProtected) {
      suffix = ` ${c.yellow}[protected]${c.reset}`;
    }

    console.log(`${prefix}${name}${suffix}`);
  }

  console.log('');
}

function isProtectedBranch(name: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === name) return true;
    if (pattern.includes('*')) {
      const regex = new RegExp(
        '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
      );
      if (regex.test(name)) return true;
    }
  }
  return false;
}
