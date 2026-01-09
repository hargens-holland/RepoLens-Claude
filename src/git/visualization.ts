/**
 * Visualization data structures and lane assignment
 *
 * Transforms a RepositoryGraph into layout-ready coordinates for rendering.
 * The algorithm assigns horizontal "lanes" to commits to show parallel branches.
 */

import type { CommitHash, GitRef, RepositoryGraph, RefType } from './types.js';

// ============================================
// VISUALIZATION DATA STRUCTURES
// ============================================

/**
 * A ref label to render alongside a commit
 */
export interface VisualRef {
  readonly name: string;
  readonly type: RefType;
  readonly isHead: boolean;
  readonly isProtected: boolean;
}

/**
 * Edge type affects how the edge should be rendered
 */
export type EdgeType = 'straight' | 'merge' | 'fork';

/**
 * An edge connecting a commit to its parent
 */
export interface VisualEdge {
  readonly id: string;
  readonly fromHash: CommitHash;
  readonly toHash: CommitHash;
  readonly fromRow: number;
  readonly fromLane: number;
  readonly toRow: number;
  readonly toLane: number;
  readonly type: EdgeType;
  /** For merge commits, index indicates first vs subsequent parent */
  readonly parentIndex: number;
}

/**
 * A commit positioned for rendering
 */
export interface VisualCommit {
  readonly hash: CommitHash;
  /** Vertical position (0 = most recent) */
  readonly row: number;
  /** Horizontal lane (0 = leftmost) */
  readonly lane: number;
  /** Commit has 2+ parents */
  readonly isMerge: boolean;
  /** Commit has refs pointing to it */
  readonly isBranchTip: boolean;
  /** Commit has no parents (in our set) */
  readonly isRoot: boolean;
  /** Is this the current HEAD commit */
  readonly isHead: boolean;
  /** References (branches/tags) at this commit */
  readonly refs: readonly VisualRef[];
  /** IDs of edges from this commit to its parents */
  readonly edgeIds: readonly string[];
}

/**
 * Complete visualization-ready data
 */
export interface VisualGraph {
  /** Commits in row order (index = row) */
  readonly commits: readonly VisualCommit[];
  /** All edges between commits */
  readonly edges: readonly VisualEdge[];
  /** Total number of rows */
  readonly totalRows: number;
  /** Total number of lanes used */
  readonly totalLanes: number;
  /** Lookup commit by hash */
  readonly commitByHash: ReadonlyMap<CommitHash, VisualCommit>;
  /** Lookup commit by row */
  readonly commitByRow: ReadonlyMap<number, VisualCommit>;
  /** Lookup edge by id */
  readonly edgeById: ReadonlyMap<string, VisualEdge>;
  /** Active lanes at each row (for rendering lane lines) */
  readonly activeLanesAtRow: ReadonlyMap<number, readonly number[]>;
}

// ============================================
// LANE ASSIGNMENT ALGORITHM
// ============================================

/**
 * Options for layout calculation
 */
export interface LayoutOptions {
  /** Patterns for protected branches */
  readonly protectedBranches?: readonly string[];
}

/**
 * Internal state for lane assignment
 */
interface LaneState {
  /** Maps commit hash to its assigned lane */
  laneByCommit: Map<CommitHash, number>;
  /** Commits that are "active" (seen but parent not yet processed) at each lane */
  activeLanes: Map<number, CommitHash>;
  /** Lanes available for reuse */
  freeLanes: number[];
  /** Highest lane number used */
  maxLane: number;
}

/**
 * Create a visual graph with lane assignments from a repository graph
 *
 * Algorithm:
 * 1. Process commits in reverse topological order (newest first)
 * 2. If a commit was reserved by a child, use that lane
 * 3. Otherwise, allocate a new lane (or reuse a free one)
 * 4. Reserve lanes for parents:
 *    - First parent continues in the same lane
 *    - Additional parents get new/reused lanes
 * 5. When a commit has no more children, free its lane
 */
export function createVisualGraph(
  graph: RepositoryGraph,
  options: LayoutOptions = {}
): VisualGraph {
  const state: LaneState = {
    laneByCommit: new Map(),
    activeLanes: new Map(),
    freeLanes: [],
    maxLane: -1,
  };

  const commits: VisualCommit[] = [];
  const edges: VisualEdge[] = [];
  const commitByHash = new Map<CommitHash, VisualCommit>();
  const commitByRow = new Map<number, VisualCommit>();
  const edgeById = new Map<string, VisualEdge>();
  const activeLanesAtRow = new Map<number, number[]>();

  // Process in reverse topological order (children before parents)
  // Git's topo order is parents-before-children, so we reverse it
  const orderedHashes = [...graph.topologicalOrder].reverse();

  for (let row = 0; row < orderedHashes.length; row++) {
    const hash = orderedHashes[row]!;
    const commit = graph.commits.get(hash);
    if (!commit) continue;

    // Determine this commit's lane
    let lane: number;
    if (state.laneByCommit.has(hash)) {
      // Lane was reserved by a child commit
      lane = state.laneByCommit.get(hash)!;
    } else {
      // New branch point - allocate a lane
      lane = allocateLane(state);
    }

    // Mark this lane as occupied by this commit
    state.activeLanes.set(lane, hash);

    // Get refs at this commit
    const refsAtCommit = graph.refsByCommit.get(hash) ?? [];
    const visualRefs = refsAtCommit.map((ref) => toVisualRef(ref, options));

    // Create edges to parents and reserve their lanes
    const edgeIds: string[] = [];

    for (let parentIndex = 0; parentIndex < commit.parents.length; parentIndex++) {
      const parentHash = commit.parents[parentIndex]!;
      const isFirstParent = parentIndex === 0;

      let parentLane: number;

      if (state.laneByCommit.has(parentHash)) {
        // Parent already has a reserved lane (from another child)
        parentLane = state.laneByCommit.get(parentHash)!;
      } else if (isFirstParent) {
        // First parent continues in same lane
        parentLane = lane;
        state.laneByCommit.set(parentHash, parentLane);
      } else {
        // Additional parent (merge) gets a new lane
        parentLane = allocateLane(state);
        state.laneByCommit.set(parentHash, parentLane);
      }

      // Determine edge type
      let edgeType: EdgeType;
      if (commit.parents.length > 1 && parentIndex > 0) {
        edgeType = 'merge';
      } else if (lane !== parentLane) {
        edgeType = 'fork';
      } else {
        edgeType = 'straight';
      }

      const edgeId = `${hash}-${parentHash}-${parentIndex}`;
      const edge: VisualEdge = {
        id: edgeId,
        fromHash: hash,
        toHash: parentHash,
        fromRow: row,
        fromLane: lane,
        toRow: -1, // Will be filled when we process parent
        toLane: parentLane,
        type: edgeType,
        parentIndex,
      };

      edges.push(edge);
      edgeIds.push(edgeId);
      edgeById.set(edgeId, edge);
    }

    // Check if this commit's lane should be freed
    // A lane is freed when the commit has no children using it
    const children = graph.children.get(hash) ?? [];
    const hasChildInSameLane = children.some(
      (childHash) => commitByHash.get(childHash)?.lane === lane
    );

    if (children.length === 0 || !hasChildInSameLane) {
      // This is a tip or no child continues this lane
      // Only free lane if it's not being used by a parent reservation
      const isLaneReservedForParent = commit.parents.some(
        (p) => state.laneByCommit.get(p) === lane
      );
      if (!isLaneReservedForParent && lane > 0) {
        freeLane(state, lane);
      }
    }

    // Record active lanes at this row
    const currentActiveLanes = Array.from(state.activeLanes.keys()).sort((a, b) => a - b);
    activeLanesAtRow.set(row, currentActiveLanes);

    // Remove this commit from active lanes (it's been processed)
    if (state.activeLanes.get(lane) === hash) {
      state.activeLanes.delete(lane);
    }

    // Create visual commit
    const visualCommit: VisualCommit = {
      hash,
      row,
      lane,
      isMerge: commit.parents.length > 1,
      isBranchTip: refsAtCommit.length > 0,
      isRoot: commit.parents.length === 0 ||
        commit.parents.every((p) => !graph.commits.has(p)),
      isHead: hash === graph.head,
      refs: visualRefs,
      edgeIds,
    };

    commits.push(visualCommit);
    commitByHash.set(hash, visualCommit);
    commitByRow.set(row, visualCommit);
  }

  // Second pass: fill in edge toRow values
  for (const edge of edges) {
    const parentCommit = commitByHash.get(edge.toHash);
    if (parentCommit) {
      // TypeScript doesn't allow direct mutation of readonly, so we reconstruct
      const updatedEdge: VisualEdge = {
        ...edge,
        toRow: parentCommit.row,
      };
      edgeById.set(edge.id, updatedEdge);
      // Update in array
      const idx = edges.indexOf(edge);
      if (idx !== -1) {
        (edges as VisualEdge[])[idx] = updatedEdge;
      }
    }
  }

  return {
    commits,
    edges,
    totalRows: commits.length,
    totalLanes: state.maxLane + 1,
    commitByHash,
    commitByRow,
    edgeById,
    activeLanesAtRow,
  };
}

/**
 * Allocate a lane (reuse free lane or create new one)
 */
function allocateLane(state: LaneState): number {
  if (state.freeLanes.length > 0) {
    // Prefer lower-numbered free lanes for compact layout
    state.freeLanes.sort((a, b) => a - b);
    return state.freeLanes.shift()!;
  }
  state.maxLane++;
  return state.maxLane;
}

/**
 * Mark a lane as free for reuse
 */
function freeLane(state: LaneState, lane: number): void {
  if (!state.freeLanes.includes(lane)) {
    state.freeLanes.push(lane);
  }
  state.activeLanes.delete(lane);
}

/**
 * Convert a GitRef to a VisualRef
 */
function toVisualRef(ref: GitRef, options: LayoutOptions): VisualRef {
  const isProtected = matchesProtectedPattern(ref.name, options.protectedBranches ?? []);
  return {
    name: ref.name,
    type: ref.type,
    isHead: ref.isHead,
    isProtected,
  };
}

/**
 * Check if a name matches any protected pattern
 */
function matchesProtectedPattern(name: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === name) return true;
    // Simple glob: * matches any characters
    const regex = new RegExp(
      '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
    );
    if (regex.test(name)) return true;
  }
  return false;
}

// ============================================
// LAYOUT UTILITIES
// ============================================

/**
 * Get commits visible in a row range (for virtualized rendering)
 */
export function getVisibleCommits(
  graph: VisualGraph,
  startRow: number,
  endRow: number
): VisualCommit[] {
  const result: VisualCommit[] = [];
  for (let row = startRow; row <= endRow && row < graph.totalRows; row++) {
    const commit = graph.commitByRow.get(row);
    if (commit) {
      result.push(commit);
    }
  }
  return result;
}

/**
 * Get edges that are visible in a row range
 * An edge is visible if it starts, ends, or passes through the range
 */
export function getVisibleEdges(
  graph: VisualGraph,
  startRow: number,
  endRow: number
): VisualEdge[] {
  const result: VisualEdge[] = [];
  const seen = new Set<string>();

  for (const edge of graph.edges) {
    if (seen.has(edge.id)) continue;

    const minRow = Math.min(edge.fromRow, edge.toRow);
    const maxRow = Math.max(edge.fromRow, edge.toRow);

    // Edge is visible if it overlaps with the range
    if (maxRow >= startRow && minRow <= endRow) {
      result.push(edge);
      seen.add(edge.id);
    }
  }

  return result;
}

/**
 * Calculate the bounding box for the visible area
 */
export interface BoundingBox {
  readonly minRow: number;
  readonly maxRow: number;
  readonly minLane: number;
  readonly maxLane: number;
}

export function getBoundingBox(
  commits: readonly VisualCommit[],
  edges: readonly VisualEdge[]
): BoundingBox {
  if (commits.length === 0) {
    return { minRow: 0, maxRow: 0, minLane: 0, maxLane: 0 };
  }

  let minRow = Infinity;
  let maxRow = -Infinity;
  let minLane = Infinity;
  let maxLane = -Infinity;

  for (const commit of commits) {
    minRow = Math.min(minRow, commit.row);
    maxRow = Math.max(maxRow, commit.row);
    minLane = Math.min(minLane, commit.lane);
    maxLane = Math.max(maxLane, commit.lane);
  }

  // Edges might extend beyond commit lanes
  for (const edge of edges) {
    minLane = Math.min(minLane, edge.fromLane, edge.toLane);
    maxLane = Math.max(maxLane, edge.fromLane, edge.toLane);
  }

  return { minRow, maxRow, minLane, maxLane };
}

/**
 * Find the commit at a specific position (for click handling)
 */
export function findCommitAtPosition(
  graph: VisualGraph,
  row: number,
  lane: number,
  tolerance: number = 0.5
): VisualCommit | null {
  const commit = graph.commitByRow.get(row);
  if (commit && Math.abs(commit.lane - lane) <= tolerance) {
    return commit;
  }
  return null;
}

/**
 * Get the path of an edge as a series of points
 * This can be used for SVG path rendering
 */
export interface Point {
  readonly row: number;
  readonly lane: number;
}

export function getEdgePath(edge: VisualEdge): readonly Point[] {
  const points: Point[] = [
    { row: edge.fromRow, lane: edge.fromLane },
  ];

  // For edges that change lanes, add intermediate points
  if (edge.fromLane !== edge.toLane) {
    if (edge.type === 'merge') {
      // Merge edges: go horizontal first, then vertical
      points.push({ row: edge.fromRow, lane: edge.toLane });
    } else {
      // Fork edges: go vertical first, then horizontal
      // Use a midpoint for smoother curves
      const midRow = Math.floor((edge.fromRow + edge.toRow) / 2);
      points.push({ row: midRow, lane: edge.fromLane });
      points.push({ row: midRow, lane: edge.toLane });
    }
  }

  points.push({ row: edge.toRow, lane: edge.toLane });

  return points;
}

/**
 * Convert edge path to SVG path data
 */
export function edgePathToSvg(
  points: readonly Point[],
  rowHeight: number,
  laneWidth: number,
  useCurves: boolean = true
): string {
  if (points.length < 2) return '';

  const toCoords = (p: Point) => ({
    x: p.lane * laneWidth + laneWidth / 2,
    y: p.row * rowHeight + rowHeight / 2,
  });

  const start = toCoords(points[0]!);
  let path = `M ${start.x} ${start.y}`;

  if (useCurves && points.length > 2) {
    // Use quadratic curves for smoother appearance
    for (let i = 1; i < points.length; i++) {
      const curr = toCoords(points[i]!);

      if (i === points.length - 1) {
        // Last segment: straight line to end
        path += ` L ${curr.x} ${curr.y}`;
      } else {
        // Intermediate: curve toward next point
        const next = toCoords(points[i + 1]!);
        const midX = (curr.x + next.x) / 2;
        const midY = (curr.y + next.y) / 2;
        path += ` Q ${curr.x} ${curr.y} ${midX} ${midY}`;
      }
    }
  } else {
    // Simple line segments
    for (let i = 1; i < points.length; i++) {
      const p = toCoords(points[i]!);
      path += ` L ${p.x} ${p.y}`;
    }
  }

  return path;
}

// ============================================
// LANE OPTIMIZATION
// ============================================

/**
 * Optimize lane assignments to minimize crossings
 * This is a post-processing step that can improve layout quality
 */
export function optimizeLanes(graph: VisualGraph): VisualGraph {
  // Count crossings for each edge pair
  const crossings = countCrossings(graph.edges);

  if (crossings === 0) {
    return graph; // Already optimal
  }

  // Try swapping adjacent lanes to reduce crossings
  // This is a greedy heuristic, not guaranteed optimal
  let improved = true;
  const laneMapping = new Map<number, number>();

  // Initialize identity mapping
  for (let i = 0; i < graph.totalLanes; i++) {
    laneMapping.set(i, i);
  }

  while (improved) {
    improved = false;

    for (let lane = 0; lane < graph.totalLanes - 1; lane++) {
      // Try swapping lane and lane+1
      const newMapping = new Map(laneMapping);
      const a = laneMapping.get(lane)!;
      const b = laneMapping.get(lane + 1)!;
      newMapping.set(lane, b);
      newMapping.set(lane + 1, a);

      const newEdges = remapEdgeLanes(graph.edges, newMapping);
      const newCrossings = countCrossings(newEdges);

      if (newCrossings < crossings) {
        laneMapping.set(lane, b);
        laneMapping.set(lane + 1, a);
        improved = true;
      }
    }
  }

  // If no improvement found, return original
  if (Array.from(laneMapping.entries()).every(([k, v]) => k === v)) {
    return graph;
  }

  // Apply the optimized mapping
  return applyLaneMapping(graph, laneMapping);
}

/**
 * Count edge crossings in the graph
 */
function countCrossings(edges: readonly VisualEdge[]): number {
  let crossings = 0;

  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      if (edgesCross(edges[i]!, edges[j]!)) {
        crossings++;
      }
    }
  }

  return crossings;
}

/**
 * Check if two edges cross
 */
function edgesCross(e1: VisualEdge, e2: VisualEdge): boolean {
  // Edges can only cross if their row ranges overlap
  const e1MinRow = Math.min(e1.fromRow, e1.toRow);
  const e1MaxRow = Math.max(e1.fromRow, e1.toRow);
  const e2MinRow = Math.min(e2.fromRow, e2.toRow);
  const e2MaxRow = Math.max(e2.fromRow, e2.toRow);

  if (e1MaxRow <= e2MinRow || e2MaxRow <= e1MinRow) {
    return false; // No row overlap
  }

  // Check if lanes cross
  // Edges cross if one goes left-to-right while the other goes right-to-left
  const e1Dir = e1.toLane - e1.fromLane;
  const e2Dir = e2.toLane - e2.fromLane;

  if (e1Dir === 0 || e2Dir === 0) {
    return false; // Straight edges don't cross
  }

  // Check if they actually intersect
  const e1Left = Math.min(e1.fromLane, e1.toLane);
  const e1Right = Math.max(e1.fromLane, e1.toLane);
  const e2Left = Math.min(e2.fromLane, e2.toLane);
  const e2Right = Math.max(e2.fromLane, e2.toLane);

  if (e1Right <= e2Left || e2Right <= e1Left) {
    return false; // No lane overlap
  }

  // They overlap in both dimensions - check for actual crossing
  return (e1Dir > 0) !== (e2Dir > 0);
}

/**
 * Remap edge lanes according to a mapping
 */
function remapEdgeLanes(
  edges: readonly VisualEdge[],
  mapping: Map<number, number>
): VisualEdge[] {
  return edges.map((e) => ({
    ...e,
    fromLane: mapping.get(e.fromLane) ?? e.fromLane,
    toLane: mapping.get(e.toLane) ?? e.toLane,
  }));
}

/**
 * Apply lane mapping to entire graph
 */
function applyLaneMapping(
  graph: VisualGraph,
  mapping: Map<number, number>
): VisualGraph {
  const newCommits = graph.commits.map((c) => ({
    ...c,
    lane: mapping.get(c.lane) ?? c.lane,
  }));

  const newEdges = graph.edges.map((e) => ({
    ...e,
    fromLane: mapping.get(e.fromLane) ?? e.fromLane,
    toLane: mapping.get(e.toLane) ?? e.toLane,
  }));

  const newCommitByHash = new Map<CommitHash, VisualCommit>();
  const newCommitByRow = new Map<number, VisualCommit>();
  const newEdgeById = new Map<string, VisualEdge>();

  for (const commit of newCommits) {
    newCommitByHash.set(commit.hash, commit);
    newCommitByRow.set(commit.row, commit);
  }

  for (const edge of newEdges) {
    newEdgeById.set(edge.id, edge);
  }

  // Recalculate active lanes at each row
  const newActiveLanesAtRow = new Map<number, number[]>();
  for (const [row, lanes] of graph.activeLanesAtRow) {
    newActiveLanesAtRow.set(
      row,
      lanes.map((l) => mapping.get(l) ?? l).sort((a, b) => a - b)
    );
  }

  return {
    commits: newCommits,
    edges: newEdges,
    totalRows: graph.totalRows,
    totalLanes: graph.totalLanes,
    commitByHash: newCommitByHash,
    commitByRow: newCommitByRow,
    edgeById: newEdgeById,
    activeLanesAtRow: newActiveLanesAtRow,
  };
}
