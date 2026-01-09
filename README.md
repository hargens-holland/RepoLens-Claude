# RepoLens

A Git repository visualization and management tool that transforms Git history into an interactive visual workspace.

## Features

- **DAG Visualization**: View commit history as a directed acyclic graph with lane assignments
- **ASCII/Unicode Rendering**: Terminal-based visualization with color support
- **Branch Management**: List and delete branches with protection rules
- **Safe Execution**: Read-only Git commands with explicit allowlist for safety
- **Type-Safe**: Built with TypeScript using branded types and Result patterns

## Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/RepoLens-Claude.git
cd RepoLens-Claude

# Install dependencies
npm install

# Build the project
npm run build
```

## Usage

### Visualize Repository History

```bash
# Visualize current directory
node dist/cli/index.js

# Visualize a specific repository
node dist/cli/index.js ~/projects/myrepo

# Show last 50 commits
node dist/cli/index.js -n 50

# Show all commits
node dist/cli/index.js -a

# Use ASCII characters (for terminals without Unicode support)
node dist/cli/index.js --ascii

# Disable colors
node dist/cli/index.js --no-color

# Show full commit hashes
node dist/cli/index.js --full-hash

# Simple output mode
node dist/cli/index.js --simple
```

### Branch Management

```bash
# List all branches
node dist/cli/index.js branch list

# Delete a specific branch
node dist/cli/index.js branch delete feature-branch

# Interactive branch deletion (select from list)
node dist/cli/index.js branch delete

# Force delete an unmerged branch
node dist/cli/index.js branch delete -f feature-branch

# Skip confirmation prompt
node dist/cli/index.js branch delete -y feature-branch
```

## Development

```bash
# Install dependencies
npm install

# Build (compile TypeScript)
npm run build

# Watch mode (rebuild on changes)
npm run dev

# Run tests in watch mode
npm test

# Run tests once
npm run test:run

# Run a specific test file
npx vitest run src/git/executor.test.ts

# Type check without emitting
npm run typecheck

# Run linter
npm run lint
```

## Architecture

```
src/
  git/
    types.ts         # Core data types (Commit, Branch, GitRef, RepositoryGraph)
    executor.ts      # Safe Git command execution with allowlist
    parser.ts        # Pure functions to parse git output into typed structures
    graph.ts         # Graph building and traversal utilities
    visualization.ts # Lane assignment and DAG layout for rendering
    mutations.ts     # Branch/tag deletion with validation
    index.ts         # Module exports
  cli/
    index.ts         # CLI entry point with argument parsing
    render.ts        # Terminal DAG renderer (ASCII/Unicode with colors)
    branch.ts        # Interactive branch management commands
  index.ts           # Library entry point
```

### Key Design Decisions

1. **Command Safety**: `GitExecutor` only allows read-only Git commands via an explicit allowlist. Dangerous subcommands (`push`, `reset`, `checkout`) and flags (`--delete`, `--force`) are rejected.

2. **Branded Types**: `CommitHash` is a branded string type to prevent mixing with regular strings.

3. **Result Types**: All Git operations return `GitResult<T>` - either `{ ok: true, value: T }` or `{ ok: false, error: GitError }`.

4. **Pure Parsers**: Parsers use NULL byte delimiters to safely handle commit messages with newlines.

5. **Protected Branches**: Configurable branch protection patterns (default: `main`, `master`, `develop`, `release/*`, `production`).

## Configuration

Protected branches can be configured when using the library programmatically:

```typescript
import { loadRepository, createGitExecutor } from 'repolens';

const executor = createGitExecutor();
const result = await loadRepository(executor, {
  path: '/path/to/repo',
  maxCommits: 100,
  protectedBranches: ['main', 'master', 'release/*'],
});
```

## License

MIT
