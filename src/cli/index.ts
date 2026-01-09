#!/usr/bin/env node
/**
 * RepoLens CLI
 *
 * Git repository visualization and management tool.
 *
 * Usage:
 *   repolens [options] [path]           Visualize repository
 *   repolens branch [options]           Branch management
 *   repolens branch delete [name]       Delete a branch
 *   repolens branch list                List branches
 */

import { resolve } from 'node:path';
import { createGitExecutor } from '../git/executor.js';
import { loadRepository, getGraphStats } from '../git/graph.js';
import { createVisualGraph } from '../git/visualization.js';
import { renderGraph, renderHeader, renderSimple } from './render.js';
import { branchDeleteCommand, branchListCommand } from './branch.js';

// ============================================
// ARGUMENT PARSING
// ============================================

interface CliArgs {
  command: 'visualize' | 'branch-delete' | 'branch-list' | 'help' | 'version';
  path: string;
  limit: number | undefined;
  ascii: boolean;
  noColor: boolean;
  fullHash: boolean;
  simple: boolean;
  branchName?: string;
  force?: boolean;
  yes?: boolean;
  all?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    command: 'visualize',
    path: process.cwd(),
    limit: 20,
    ascii: false,
    noColor: false,
    fullHash: false,
    simple: false,
    all: false,
  };

  let i = 0;

  // Check for subcommand
  if (argv[0] && !argv[0].startsWith('-')) {
    const firstArg = argv[0];

    if (firstArg === 'branch') {
      i++;
      // Parse branch subcommand
      const branchCmd = argv[i];

      if (branchCmd === 'delete' || branchCmd === 'rm') {
        args.command = 'branch-delete';
        i++;
        // Check for branch name
        if (argv[i] && !argv[i]!.startsWith('-')) {
          args.branchName = argv[i];
          i++;
        }
      } else if (branchCmd === 'list' || branchCmd === 'ls') {
        args.command = 'branch-list';
        i++;
      } else if (branchCmd === '-h' || branchCmd === '--help') {
        args.command = 'help';
        return args;
      } else {
        // Default to list if no subcommand
        args.command = 'branch-list';
      }
    } else if (firstArg === 'help' || firstArg === '-h' || firstArg === '--help') {
      args.command = 'help';
      return args;
    } else if (firstArg === 'version' || firstArg === '-v' || firstArg === '--version') {
      args.command = 'version';
      return args;
    }
  }

  // Parse remaining arguments
  while (i < argv.length) {
    const arg = argv[i]!;

    switch (arg) {
      case '-h':
      case '--help':
        args.command = 'help';
        break;

      case '-v':
      case '--version':
        args.command = 'version';
        break;

      case '-n':
      case '--limit':
        i++;
        const limitStr = argv[i];
        if (limitStr) {
          const limit = parseInt(limitStr, 10);
          if (!isNaN(limit) && limit > 0) {
            args.limit = limit;
          }
        }
        break;

      case '-a':
      case '--all':
        args.limit = undefined;
        args.all = true;
        break;

      case '--ascii':
        args.ascii = true;
        break;

      case '--no-color':
        args.noColor = true;
        break;

      case '--full-hash':
        args.fullHash = true;
        break;

      case '--simple':
        args.simple = true;
        break;

      case '-f':
      case '--force':
        args.force = true;
        break;

      case '-y':
      case '--yes':
        args.yes = true;
        break;

      default:
        // Positional argument - treat as path or branch name
        if (!arg.startsWith('-')) {
          if (args.command === 'branch-delete' && !args.branchName) {
            args.branchName = arg;
          } else {
            args.path = resolve(arg);
          }
        }
        break;
    }

    i++;
  }

  return args;
}

// ============================================
// HELP TEXT
// ============================================

const HELP_TEXT = `
RepoLens - Git Repository Visualization & Management

Usage:
  repolens [options] [path]           Visualize repository history
  repolens branch <command>           Branch management

Commands:
  branch list                         List all branches
  branch delete [name]                Delete a branch (interactive if no name)

Visualization Options:
  -n, --limit <n>       Show only the last n commits (default: 20)
  -a, --all             Show all commits (no limit)
  --ascii               Use ASCII characters instead of Unicode
  --no-color            Disable colors
  --full-hash           Show full commit hashes
  --simple              Simple output mode

Branch Delete Options:
  -f, --force           Force delete unmerged branches
  -y, --yes             Skip confirmation prompt
  --no-color            Disable colors

General Options:
  -h, --help            Show this help message
  -v, --version         Show version

Examples:
  repolens                            # Visualize current directory
  repolens ~/projects/myrepo          # Visualize specific repo
  repolens -n 50                      # Show last 50 commits
  repolens branch list                # List branches
  repolens branch delete feature      # Delete 'feature' branch
  repolens branch delete              # Interactive branch selection
  repolens branch delete -f feature   # Force delete unmerged branch
`;

const VERSION = '0.1.0';

// ============================================
// MAIN
// ============================================

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  // Handle help and version
  if (args.command === 'help') {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  if (args.command === 'version') {
    console.log(`repolens v${VERSION}`);
    process.exit(0);
  }

  // Detect color support
  const useColors = !args.noColor &&
    process.stdout.isTTY &&
    !process.env['NO_COLOR'];

  // Create executor and load repository
  const executor = createGitExecutor();

  const result = await loadRepository(executor, {
    path: args.path,
    maxCommits: args.command === 'visualize' ? args.limit : undefined,
  });

  if (!result.ok) {
    const error = result.error;
    console.error(`Error: ${error.message}`);
    if (error.type === 'not_a_repo') {
      console.error(`'${args.path}' is not a git repository`);
    }
    process.exit(1);
  }

  const { graph, warnings, loadTimeMs } = result.value;

  // Show warnings
  for (const warning of warnings) {
    if (useColors) {
      console.error(`\x1b[33mWarning:\x1b[0m ${warning}`);
    } else {
      console.error(`Warning: ${warning}`);
    }
  }

  // Handle commands
  switch (args.command) {
    case 'visualize':
      await runVisualize(args, graph, loadTimeMs, useColors);
      break;

    case 'branch-list':
      await branchListCommand(graph, { noColor: !useColors, all: args.all });
      break;

    case 'branch-delete':
      const success = await branchDeleteCommand(executor, graph, {
        repoPath: args.path,
        branchName: args.branchName,
        force: args.force,
        yes: args.yes,
        noColor: !useColors,
      });
      process.exit(success ? 0 : 1);
      break;
  }
}

async function runVisualize(
  args: CliArgs,
  graph: import('../git/types.js').RepositoryGraph,
  loadTimeMs: number,
  useColors: boolean
): Promise<void> {
  // Handle empty repository
  if (graph.commits.size === 0) {
    console.log('Repository has no commits.');
    process.exit(0);
  }

  // Create visual graph
  const visualGraph = createVisualGraph(graph);

  // Render
  if (args.simple) {
    const output = renderSimple(visualGraph, { limit: args.limit });
    console.log(output);
  } else {
    const header = renderHeader(visualGraph, args.path, useColors);
    const graphOutput = renderGraph(visualGraph, {
      unicode: !args.ascii,
      colors: useColors,
      fullHash: args.fullHash,
      limit: args.limit,
    });

    console.log(header);
    console.log(graphOutput);

    // Show stats
    const stats = getGraphStats(graph);
    if (useColors) {
      console.log(`\n\x1b[2mLoaded in ${loadTimeMs}ms\x1b[0m`);
      if (args.limit && stats.totalCommits > args.limit) {
        console.log(`\x1b[2mShowing ${args.limit} of ${stats.totalCommits} commits. Use -a to show all.\x1b[0m`);
      }
    } else {
      console.log(`\nLoaded in ${loadTimeMs}ms`);
      if (args.limit && stats.totalCommits > args.limit) {
        console.log(`Showing ${args.limit} of ${stats.totalCommits} commits. Use -a to show all.`);
      }
    }
  }
}

// Run main
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
