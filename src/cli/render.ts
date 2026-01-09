/**
 * Terminal renderer for git DAG visualization
 *
 * Renders a VisualGraph as ASCII/Unicode art in the terminal.
 */

import type { VisualGraph, VisualCommit, VisualEdge } from '../git/visualization.js';

// ============================================
// RENDERING OPTIONS
// ============================================

export interface RenderOptions {
  /** Use Unicode box-drawing characters (default: true) */
  readonly unicode?: boolean;
  /** Use colors (default: true) */
  readonly colors?: boolean;
  /** Maximum width for commit message (default: 50) */
  readonly maxMessageWidth?: number;
  /** Show full commit hash (default: false, shows 7 chars) */
  readonly fullHash?: boolean;
  /** Number of commits to show (default: all) */
  readonly limit?: number;
}

// ============================================
// ANSI COLOR CODES
// ============================================

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',

  // Foreground colors
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',

  // Bright foreground
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
} as const;

// Lane colors cycle
const LANE_COLORS = [
  COLORS.brightGreen,
  COLORS.brightYellow,
  COLORS.brightBlue,
  COLORS.brightMagenta,
  COLORS.brightCyan,
  COLORS.brightRed,
];

// ============================================
// GRAPH CHARACTERS
// ============================================

interface GraphChars {
  commit: string;
  commitHead: string;
  commitMerge: string;
  vertical: string;
  horizontal: string;
  cornerDownRight: string;
  cornerDownLeft: string;
  cornerUpRight: string;
  cornerUpLeft: string;
  teeRight: string;
  teeLeft: string;
  cross: string;
}

const UNICODE_CHARS: GraphChars = {
  commit: '●',
  commitHead: '◉',
  commitMerge: '◆',
  vertical: '│',
  horizontal: '─',
  cornerDownRight: '╭',
  cornerDownLeft: '╮',
  cornerUpRight: '╰',
  cornerUpLeft: '╯',
  teeRight: '├',
  teeLeft: '┤',
  cross: '┼',
};

const ASCII_CHARS: GraphChars = {
  commit: '*',
  commitHead: '@',
  commitMerge: '*',
  vertical: '|',
  horizontal: '-',
  cornerDownRight: '/',
  cornerDownLeft: '\\',
  cornerUpRight: '\\',
  cornerUpLeft: '/',
  teeRight: '|',
  teeLeft: '|',
  cross: '+',
};

// ============================================
// RENDERER
// ============================================

/**
 * Render a visual graph to terminal output
 */
export function renderGraph(graph: VisualGraph, options: RenderOptions = {}): string {
  const {
    unicode = true,
    colors = true,
    maxMessageWidth = 50,
    fullHash = false,
    limit,
  } = options;

  const chars = unicode ? UNICODE_CHARS : ASCII_CHARS;
  const lines: string[] = [];

  // Calculate how many commits to show
  const commitsToShow = limit
    ? graph.commits.slice(0, limit)
    : graph.commits;

  // Build a map of active edges at each row for drawing vertical lines
  const activeEdgesAtRow = buildActiveEdgesMap(graph, commitsToShow.length);

  for (const commit of commitsToShow) {
    const line = renderCommitLine(
      commit,
      graph,
      activeEdgesAtRow.get(commit.row) ?? [],
      chars,
      colors,
      maxMessageWidth,
      fullHash
    );
    lines.push(line);

    // Render connecting lines between this commit and the next
    if (commit.row < commitsToShow.length - 1) {
      const connectingLines = renderConnectingLines(
        commit,
        graph,
        activeEdgesAtRow,
        chars,
        colors
      );
      lines.push(...connectingLines);
    }
  }

  return lines.join('\n');
}

/**
 * Build a map of which edges are "active" (passing through) at each row
 */
function buildActiveEdgesMap(
  graph: VisualGraph,
  maxRow: number
): Map<number, VisualEdge[]> {
  const result = new Map<number, VisualEdge[]>();

  for (let row = 0; row < maxRow; row++) {
    const activeEdges: VisualEdge[] = [];

    for (const edge of graph.edges) {
      // Edge is active at this row if it spans across it
      const minRow = Math.min(edge.fromRow, edge.toRow);
      const maxEdgeRow = Math.max(edge.fromRow, edge.toRow);

      if (minRow <= row && row <= maxEdgeRow) {
        activeEdges.push(edge);
      }
    }

    result.set(row, activeEdges);
  }

  return result;
}

/**
 * Render a single commit line
 */
function renderCommitLine(
  commit: VisualCommit,
  _graph: VisualGraph,
  activeEdges: VisualEdge[],
  chars: GraphChars,
  useColors: boolean,
  _maxMessageWidth: number,
  fullHash: boolean
): string {
  const parts: string[] = [];

  // Determine the lanes we need to draw
  const maxLane = Math.max(
    commit.lane,
    ...activeEdges.map((e) => Math.max(e.fromLane, e.toLane))
  );

  // Draw each lane column
  for (let lane = 0; lane <= maxLane; lane++) {
    const laneColor = useColors ? LANE_COLORS[lane % LANE_COLORS.length]! : '';
    const reset = useColors ? COLORS.reset : '';

    if (lane === commit.lane) {
      // This is the commit's lane - draw the commit node
      let nodeChar: string;
      if (commit.isHead) {
        nodeChar = chars.commitHead;
      } else if (commit.isMerge) {
        nodeChar = chars.commitMerge;
      } else {
        nodeChar = chars.commit;
      }
      parts.push(`${laneColor}${nodeChar}${reset}`);
    } else {
      // Check if there's an edge passing through this lane at this row
      const edgeInLane = activeEdges.find(
        (e) =>
          (e.fromLane === lane || e.toLane === lane) &&
          e.fromRow !== commit.row // Don't draw vertical for edge starting here
      );

      if (edgeInLane) {
        parts.push(`${laneColor}${chars.vertical}${reset}`);
      } else {
        parts.push(' ');
      }
    }
    parts.push(' '); // Space between lanes
  }

  // Add commit info
  const hashStr = fullHash ? commit.hash : commit.hash.slice(0, 7);
  const hashColor = useColors ? COLORS.yellow : '';
  const reset = useColors ? COLORS.reset : '';

  parts.push(` ${hashColor}${hashStr}${reset}`);

  // Add refs
  if (commit.refs.length > 0) {
    const refStrs = commit.refs.map((ref) => {
      let color = '';
      let prefix = '';

      if (useColors) {
        if (ref.isHead) {
          color = COLORS.brightCyan + COLORS.bold;
          prefix = 'HEAD -> ';
        } else if (ref.type === 'local') {
          color = COLORS.brightGreen;
        } else if (ref.type === 'remote') {
          color = COLORS.brightRed;
        } else if (ref.type === 'tag') {
          color = COLORS.brightYellow;
        }
      }

      return `${color}${prefix}${ref.name}${reset}`;
    });

    parts.push(` (${refStrs.join(', ')})`);
  }

  return parts.join('');
}

/**
 * Render connecting lines between commits
 */
function renderConnectingLines(
  commit: VisualCommit,
  _graph: VisualGraph,
  activeEdgesAtRow: Map<number, VisualEdge[]>,
  chars: GraphChars,
  useColors: boolean
): string[] {
  const lines: string[] = [];
  const nextRow = commit.row + 1;
  const activeEdges = activeEdgesAtRow.get(nextRow) ?? [];

  if (activeEdges.length === 0) {
    return lines;
  }

  // Determine max lane for this connecting section
  const maxLane = Math.max(...activeEdges.map((e) => Math.max(e.fromLane, e.toLane)));

  // Build the connecting line
  const lineParts: string[] = [];
  const reset = useColors ? COLORS.reset : '';

  for (let lane = 0; lane <= maxLane; lane++) {
    const laneColor = useColors ? LANE_COLORS[lane % LANE_COLORS.length]! : '';

    // Find edges that involve this lane
    const edgesInLane = activeEdges.filter(
      (e) => e.fromLane === lane || e.toLane === lane
    );

    if (edgesInLane.length === 0) {
      lineParts.push(' ');
    } else {
      // Check if this is a lane change point
      const changingEdge = edgesInLane.find(
        (e) => e.fromLane !== e.toLane && e.fromRow === commit.row
      );

      if (changingEdge) {
        // This edge is changing lanes at this point
        if (changingEdge.fromLane < changingEdge.toLane && lane === changingEdge.fromLane) {
          lineParts.push(`${laneColor}${chars.cornerUpRight}${reset}`);
        } else if (changingEdge.fromLane > changingEdge.toLane && lane === changingEdge.fromLane) {
          lineParts.push(`${laneColor}${chars.cornerUpLeft}${reset}`);
        } else {
          lineParts.push(`${laneColor}${chars.vertical}${reset}`);
        }
      } else {
        // Normal vertical line
        lineParts.push(`${laneColor}${chars.vertical}${reset}`);
      }
    }
    lineParts.push(' '); // Space between lanes
  }

  lines.push(lineParts.join(''));

  return lines;
}

/**
 * Render a summary header for the graph
 */
export function renderHeader(
  graph: VisualGraph,
  repoPath: string,
  useColors: boolean = true
): string {
  const reset = useColors ? COLORS.reset : '';
  const bold = useColors ? COLORS.bold : '';
  const dim = useColors ? COLORS.dim : '';
  const cyan = useColors ? COLORS.cyan : '';

  const lines = [
    `${bold}${cyan}RepoLens${reset} ${dim}─ Git Repository Visualization${reset}`,
    `${dim}Repository: ${reset}${repoPath}`,
    `${dim}Commits: ${reset}${graph.totalRows}${dim}, Lanes: ${reset}${graph.totalLanes}`,
    '',
  ];

  return lines.join('\n');
}

/**
 * Simple render for when we just want basic output
 */
export function renderSimple(graph: VisualGraph, options: RenderOptions = {}): string {
  const { limit } = options;
  const lines: string[] = [];

  const commitsToShow = limit ? graph.commits.slice(0, limit) : graph.commits;

  for (const commit of commitsToShow) {
    // Build graph portion
    const graphPart = buildSimpleGraphLine(commit, graph);

    // Build info portion
    const hash = commit.hash.slice(0, 7);
    const refs = commit.refs.length > 0
      ? ` (${commit.refs.map((r) => r.name).join(', ')})`
      : '';

    lines.push(`${graphPart} ${hash}${refs}`);
  }

  return lines.join('\n');
}

/**
 * Build a simple graph line (just showing lane structure)
 */
function buildSimpleGraphLine(commit: VisualCommit, graph: VisualGraph): string {
  const parts: string[] = [];
  const maxLane = graph.totalLanes - 1;

  for (let lane = 0; lane <= maxLane; lane++) {
    if (lane === commit.lane) {
      parts.push(commit.isMerge ? '*' : commit.isHead ? '@' : '*');
    } else {
      // Check if there's activity in this lane around this commit
      const hasActivity = graph.edges.some((e) => {
        const minRow = Math.min(e.fromRow, e.toRow);
        const maxRow = Math.max(e.fromRow, e.toRow);
        return (e.fromLane === lane || e.toLane === lane) &&
          minRow <= commit.row && commit.row <= maxRow;
      });
      parts.push(hasActivity ? '|' : ' ');
    }
  }

  return parts.join(' ');
}
