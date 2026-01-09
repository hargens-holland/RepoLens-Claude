/**
 * Graph builder
 *
 * Constructs a RepositoryGraph from parsed commits and refs.
 * The graph provides efficient traversal and lookup structures.
 */

import type {
  Commit,
  CommitHash,
  GitRef,
  RepositoryGraph,
  GitResult,
  ExecuteOptions,
} from './types.js';
import { ok, err } from './types.js';
import type { GitExecutor } from './executor.js';
import { GitCommands } from './executor.js';
import { parseCommits, parseRefs, parseHead } from './parser.js';

// ============================================
// GRAPH BUILDING
// ============================================

/**
 * Options for building a repository graph
 */
export interface BuildGraphOptions {
  /** Mark these branch patterns as protected */
  readonly protectedBranches?: readonly string[];
}

/**
 * Build a RepositoryGraph from parsed commits and refs
 *
 * This is a pure function that constructs all the indices needed
 * for efficient graph traversal and visualization.
 *
 * @param commits - Parsed commits (should be in topological order from git log)
 * @param refs - Parsed refs (branches and tags)
 * @param headCommit - Current HEAD commit hash
 * @param headRef - Current HEAD branch name (null if detached)
 * @returns Complete repository graph with indices
 */
export function buildGraph(
  commits: readonly Commit[],
  refs: readonly GitRef[],
  headCommit: CommitHash | null,
  headRef: string | null
): RepositoryGraph {
  // Index commits by hash for O(1) lookup
  const commitMap = new Map<CommitHash, Commit>();
  for (const commit of commits) {
    commitMap.set(commit.hash, commit);
  }

  // Build child index (inverse of parent relationship)
  // For each commit, track which commits have it as a parent
  const childrenMap = new Map<CommitHash, CommitHash[]>();
  for (const commit of commits) {
    for (const parentHash of commit.parents) {
      let children = childrenMap.get(parentHash);
      if (!children) {
        children = [];
        childrenMap.set(parentHash, children);
      }
      children.push(commit.hash);
    }
  }

  // Convert to readonly arrays
  const children = new Map<CommitHash, readonly CommitHash[]>();
  for (const [hash, childList] of childrenMap) {
    children.set(hash, childList);
  }

  // Build ref indices
  const commitsByRef = new Map<string, CommitHash>();
  const refsByCommitMap = new Map<CommitHash, GitRef[]>();

  for (const ref of refs) {
    commitsByRef.set(ref.name, ref.commitHash);
    commitsByRef.set(ref.fullName, ref.commitHash);

    let refList = refsByCommitMap.get(ref.commitHash);
    if (!refList) {
      refList = [];
      refsByCommitMap.set(ref.commitHash, refList);
    }
    refList.push(ref);
  }

  // Convert to readonly arrays
  const refsByCommit = new Map<CommitHash, readonly GitRef[]>();
  for (const [hash, refList] of refsByCommitMap) {
    refsByCommit.set(hash, refList);
  }

  // Find root commits (commits with no parents, or parents not in our set)
  const roots: CommitHash[] = [];
  for (const commit of commits) {
    if (commit.parents.length === 0) {
      roots.push(commit.hash);
    } else {
      // Also count as root if all parents are outside our commit set
      const hasKnownParent = commit.parents.some((p) => commitMap.has(p));
      if (!hasKnownParent) {
        roots.push(commit.hash);
      }
    }
  }

  // Topological order: git log --topo-order gives us parents before children
  // We store as-is since that's what git provides
  const topologicalOrder = commits.map((c) => c.hash);

  return {
    commits: commitMap,
    refs,
    head: headCommit,
    headRef,
    children,
    commitsByRef,
    refsByCommit,
    roots,
    topologicalOrder,
  };
}

// ============================================
// REPOSITORY LOADING
// ============================================

/**
 * Options for loading a repository
 */
export interface LoadRepositoryOptions {
  /** Path to the repository */
  readonly path: string;
  /** Maximum number of commits to load */
  readonly maxCommits?: number;
  /** Only load commits after this date */
  readonly since?: Date;
  /** Only load commits before this date */
  readonly until?: Date;
  /** Branch patterns to mark as protected */
  readonly protectedBranches?: readonly string[];
}

/**
 * Result of loading a repository
 */
export interface LoadRepositoryResult {
  readonly graph: RepositoryGraph;
  /** Warnings encountered during loading (non-fatal) */
  readonly warnings: readonly string[];
  /** Time taken to load in milliseconds */
  readonly loadTimeMs: number;
}

/**
 * Load a repository and build its graph
 *
 * This is the high-level entry point that orchestrates:
 * 1. Executing git commands
 * 2. Parsing output
 * 3. Building the graph
 *
 * @param executor - GitExecutor instance
 * @param options - Loading options
 * @returns Repository graph or error
 */
export async function loadRepository(
  executor: GitExecutor,
  options: LoadRepositoryOptions
): Promise<GitResult<LoadRepositoryResult>> {
  const startTime = Date.now();
  const warnings: string[] = [];
  const execOptions: ExecuteOptions = { cwd: options.path };

  // 1. Verify this is a git repository
  const verifyResult = await executor.execute(GitCommands.verifyRepo(), execOptions);
  if (!verifyResult.ok) {
    return err(verifyResult.error);
  }
  if (verifyResult.value.exitCode !== 0) {
    return err({
      type: 'not_a_repo',
      message: `Not a git repository: ${options.path}`,
      stderr: verifyResult.value.stderr,
    });
  }

  // 2. Get HEAD state
  const [headRefResult, headCommitResult] = await Promise.all([
    executor.execute(GitCommands.headRef(), execOptions),
    executor.execute(GitCommands.headCommit(), execOptions),
  ]);

  // Parse HEAD - may fail if repo is empty
  const headRefOutput = headRefResult.ok && headRefResult.value.exitCode === 0
    ? headRefResult.value.stdout
    : null;
  const headCommitOutput = headCommitResult.ok && headCommitResult.value.exitCode === 0
    ? headCommitResult.value.stdout
    : null;

  const { headRef, headCommit } = parseHead(headRefOutput, headCommitOutput);

  // 3. Handle empty repository
  if (!headCommit) {
    return ok({
      graph: buildGraph([], [], null, null),
      warnings: ['Repository has no commits'],
      loadTimeMs: Date.now() - startTime,
    });
  }

  // 4. Load commits and refs in parallel
  const logArgs = GitCommands.log({
    maxCount: options.maxCommits,
    since: options.since,
    until: options.until,
    all: true,
  });

  const [logResult, refsResult] = await Promise.all([
    executor.execute(logArgs, execOptions),
    executor.execute(GitCommands.refs(), execOptions),
  ]);

  // 5. Handle log errors
  if (!logResult.ok) {
    return err(logResult.error);
  }
  if (logResult.value.exitCode !== 0) {
    return err({
      type: 'command_failed',
      message: 'Failed to read git log',
      command: 'git',
      args: logArgs,
      stderr: logResult.value.stderr,
      exitCode: logResult.value.exitCode,
    });
  }

  // 6. Parse commits
  const { commits, errors: commitErrors } = parseCommits(logResult.value.stdout);

  for (const error of commitErrors) {
    warnings.push(`Commit parse error: ${error.message}`);
  }

  // 7. Parse refs (may fail if no refs exist yet)
  let refs: GitRef[] = [];
  if (refsResult.ok && refsResult.value.exitCode === 0) {
    const refsParseResult = parseRefs(refsResult.value.stdout, {
      headBranch: headRef,
      protectedPatterns: options.protectedBranches,
    });

    refs = [...refsParseResult.refs];

    for (const error of refsParseResult.errors) {
      warnings.push(`Ref parse error: ${error.message}`);
    }
  }

  // 8. Build graph
  const graph = buildGraph(commits, refs, headCommit, headRef);

  return ok({
    graph,
    warnings,
    loadTimeMs: Date.now() - startTime,
  });
}

// ============================================
// GRAPH TRAVERSAL UTILITIES
// ============================================

/**
 * Get all ancestors of a commit (parents, grandparents, etc.)
 * Returns commits in BFS order (closest ancestors first)
 */
export function getAncestors(
  graph: RepositoryGraph,
  commitHash: CommitHash,
  maxDepth: number = Infinity
): CommitHash[] {
  const ancestors: CommitHash[] = [];
  const visited = new Set<CommitHash>();
  const queue: Array<{ hash: CommitHash; depth: number }> = [];

  const commit = graph.commits.get(commitHash);
  if (!commit) {
    return ancestors;
  }

  // Start with immediate parents
  for (const parent of commit.parents) {
    if (!visited.has(parent)) {
      visited.add(parent);
      queue.push({ hash: parent, depth: 1 });
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (current.depth > maxDepth) {
      continue;
    }

    ancestors.push(current.hash);

    const currentCommit = graph.commits.get(current.hash);
    if (currentCommit) {
      for (const parent of currentCommit.parents) {
        if (!visited.has(parent)) {
          visited.add(parent);
          queue.push({ hash: parent, depth: current.depth + 1 });
        }
      }
    }
  }

  return ancestors;
}

/**
 * Get all descendants of a commit (children, grandchildren, etc.)
 * Returns commits in BFS order (closest descendants first)
 */
export function getDescendants(
  graph: RepositoryGraph,
  commitHash: CommitHash,
  maxDepth: number = Infinity
): CommitHash[] {
  const descendants: CommitHash[] = [];
  const visited = new Set<CommitHash>();
  const queue: Array<{ hash: CommitHash; depth: number }> = [];

  const children = graph.children.get(commitHash) ?? [];
  for (const child of children) {
    if (!visited.has(child)) {
      visited.add(child);
      queue.push({ hash: child, depth: 1 });
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (current.depth > maxDepth) {
      continue;
    }

    descendants.push(current.hash);

    const currentChildren = graph.children.get(current.hash) ?? [];
    for (const child of currentChildren) {
      if (!visited.has(child)) {
        visited.add(child);
        queue.push({ hash: child, depth: current.depth + 1 });
      }
    }
  }

  return descendants;
}

/**
 * Find the merge base (common ancestor) of two commits
 * Returns null if no common ancestor exists
 */
export function findMergeBase(
  graph: RepositoryGraph,
  hash1: CommitHash,
  hash2: CommitHash
): CommitHash | null {
  // Get all ancestors of hash1
  const ancestors1 = new Set<CommitHash>([hash1]);
  const queue1: CommitHash[] = [hash1];

  while (queue1.length > 0) {
    const current = queue1.shift()!;
    const commit = graph.commits.get(current);
    if (commit) {
      for (const parent of commit.parents) {
        if (!ancestors1.has(parent)) {
          ancestors1.add(parent);
          queue1.push(parent);
        }
      }
    }
  }

  // BFS from hash2, find first commit that's in ancestors1
  const visited = new Set<CommitHash>();
  const queue2: CommitHash[] = [hash2];
  visited.add(hash2);

  // Check if hash2 itself is an ancestor of hash1
  if (ancestors1.has(hash2)) {
    return hash2;
  }

  while (queue2.length > 0) {
    const current = queue2.shift()!;
    const commit = graph.commits.get(current);

    if (commit) {
      for (const parent of commit.parents) {
        if (ancestors1.has(parent)) {
          return parent;
        }
        if (!visited.has(parent)) {
          visited.add(parent);
          queue2.push(parent);
        }
      }
    }
  }

  return null;
}

/**
 * Check if one commit is an ancestor of another
 */
export function isAncestor(
  graph: RepositoryGraph,
  potentialAncestor: CommitHash,
  commit: CommitHash
): boolean {
  if (potentialAncestor === commit) {
    return false; // A commit is not its own ancestor
  }

  const visited = new Set<CommitHash>();
  const queue: CommitHash[] = [commit];
  visited.add(commit);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentCommit = graph.commits.get(current);

    if (currentCommit) {
      for (const parent of currentCommit.parents) {
        if (parent === potentialAncestor) {
          return true;
        }
        if (!visited.has(parent)) {
          visited.add(parent);
          queue.push(parent);
        }
      }
    }
  }

  return false;
}

/**
 * Get commits reachable from a ref but not from another
 * Useful for finding "commits on branch X not on branch Y"
 */
export function getCommitsBetween(
  graph: RepositoryGraph,
  includeRef: CommitHash,
  excludeRef: CommitHash
): CommitHash[] {
  // Get all ancestors of excludeRef (including itself)
  const excluded = new Set<CommitHash>([excludeRef]);
  const queue1: CommitHash[] = [excludeRef];

  while (queue1.length > 0) {
    const current = queue1.shift()!;
    const commit = graph.commits.get(current);
    if (commit) {
      for (const parent of commit.parents) {
        if (!excluded.has(parent)) {
          excluded.add(parent);
          queue1.push(parent);
        }
      }
    }
  }

  // Get commits reachable from includeRef that aren't in excluded
  const result: CommitHash[] = [];
  const visited = new Set<CommitHash>();
  const queue2: CommitHash[] = [includeRef];
  visited.add(includeRef);

  if (!excluded.has(includeRef)) {
    result.push(includeRef);
  }

  while (queue2.length > 0) {
    const current = queue2.shift()!;
    const commit = graph.commits.get(current);

    if (commit) {
      for (const parent of commit.parents) {
        if (!visited.has(parent)) {
          visited.add(parent);
          if (!excluded.has(parent)) {
            result.push(parent);
            queue2.push(parent);
          }
        }
      }
    }
  }

  return result;
}

/**
 * Get statistics about the repository graph
 */
export interface GraphStats {
  readonly totalCommits: number;
  readonly totalBranches: number;
  readonly totalTags: number;
  readonly totalRoots: number;
  readonly mergeCommits: number;
  readonly maxParents: number;
  readonly oldestCommit: Date | null;
  readonly newestCommit: Date | null;
}

export function getGraphStats(graph: RepositoryGraph): GraphStats {
  let mergeCommits = 0;
  let maxParents = 0;
  let oldestCommit: Date | null = null;
  let newestCommit: Date | null = null;

  for (const commit of graph.commits.values()) {
    if (commit.parents.length > 1) {
      mergeCommits++;
    }
    if (commit.parents.length > maxParents) {
      maxParents = commit.parents.length;
    }

    if (!oldestCommit || commit.committedAt < oldestCommit) {
      oldestCommit = commit.committedAt;
    }
    if (!newestCommit || commit.committedAt > newestCommit) {
      newestCommit = commit.committedAt;
    }
  }

  const branches = graph.refs.filter((r) => r.type === 'local' || r.type === 'remote');
  const tags = graph.refs.filter((r) => r.type === 'tag');

  return {
    totalCommits: graph.commits.size,
    totalBranches: branches.length,
    totalTags: tags.length,
    totalRoots: graph.roots.length,
    mergeCommits,
    maxParents,
    oldestCommit,
    newestCommit,
  };
}
