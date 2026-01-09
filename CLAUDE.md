# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

RepoLens is a Git repository visualization and control platform. It transforms Git repositories into an interactive visual workspace for exploring commits, branches, and history.

**Current Phase:** Phase 1 - Repository Parsing & Visualization (Read-Only)

## Build & Development Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to dist/
npm run dev          # Watch mode compilation
npm run start        # Run CLI on current directory
npm test             # Run tests in watch mode
npm run test:run     # Run tests once
npm run typecheck    # Type check without emitting
npm run lint         # Run ESLint
```

Run CLI:
```bash
node dist/cli/index.js [options] [path]
node dist/cli/index.js -n 50           # Show last 50 commits
node dist/cli/index.js --ascii         # Use ASCII instead of Unicode
node dist/cli/index.js -a              # Show all commits
```

Run a single test file:
```bash
npx vitest run src/git/executor.test.ts
```

## Architecture

### Core Layers

```
src/
  git/
    types.ts         # Core data types (Commit, Branch, GitRef, RepositoryGraph)
    executor.ts      # Safe Git command execution with allowlist
    parser.ts        # Pure functions to parse git output into typed structures
    graph.ts         # Graph building and traversal utilities
    visualization.ts # Lane assignment and DAG layout for rendering
    index.ts         # Module exports
  cli/
    index.ts         # CLI entry point with argument parsing
    render.ts        # Terminal DAG renderer (ASCII/Unicode with colors)
  index.ts           # Library entry point
```

### Key Design Decisions

1. **Command Safety**: `GitExecutor` only allows read-only Git commands via an explicit allowlist. Dangerous subcommands (`push`, `reset`, `checkout`) and flags (`--delete`, `--force`) are rejected before execution.

2. **Branded Types**: `CommitHash` is a branded string type to prevent mixing with regular strings.

3. **Result Types**: All Git operations return `GitResult<T>` which is either `{ ok: true, value: T }` or `{ ok: false, error: GitError }`.

4. **Separation of Concerns**:
   - `GitExecutor` handles process spawning and safety validation
   - `GitCommands` provides type-safe command builders
   - Parsers (`parseCommits`, `parseRefs`, `parseHead`) transform raw git output to typed structures
   - `buildGraph` constructs `RepositoryGraph` with indices for efficient traversal
   - `loadRepository` orchestrates the full pipeline: execute → parse → build

5. **Parser Design**: Parsers use NULL byte delimiters (`\x00` for fields, `\x01` for records) to safely handle commit messages with newlines. All parsers are pure functions that return both parsed data and any errors encountered, allowing partial success.

6. **Graph Traversal**: The graph module provides utilities for common operations: `getAncestors`, `getDescendants`, `findMergeBase`, `isAncestor`, `getCommitsBetween`. All traversals use BFS and return results in distance order.

7. **Visualization Layout**: `createVisualGraph` transforms a `RepositoryGraph` into `VisualGraph` with lane assignments. The algorithm processes commits in reverse topological order, keeps first parents in the same lane, and assigns merge parents to new lanes. Includes utilities for virtualized rendering (`getVisibleCommits`, `getVisibleEdges`) and SVG path generation.

### Safety Boundaries

The executor enforces these rules:
- Only allowlisted subcommands can run
- Dangerous flags are blocked even on safe commands
- `git config` only allowed with read flags (`--get`, `--list`)
- `git remote` only allowed for listing, not modification
- Commands timeout after 30 seconds
- Output capped at 50MB to prevent memory issues
