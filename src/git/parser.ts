/**
 * Git output parsers
 *
 * Transforms raw git command output into typed data structures.
 * All parsers are pure functions with no side effects.
 */

import type {
  Commit,
  CommitHash,
  GitRef,
  Branch,
  Tag,
} from './types.js';
import { unsafeCommitHash } from './types.js';

// ============================================
// COMMIT PARSING
// ============================================

/**
 * Field separator in git log format (NULL byte)
 */
const FIELD_SEPARATOR = '\x00';

/**
 * Record separator in git log format (NULL byte with different value)
 */
const RECORD_SEPARATOR = '\x01';

/**
 * Expected number of fields per commit record
 * hash, parents, author name, author email, author date,
 * committer name, committer email, commit date, subject, body
 */
const EXPECTED_FIELDS = 10;

/**
 * Result of parsing commits
 */
export interface ParseCommitsResult {
  readonly commits: Commit[];
  readonly errors: ParseError[];
}

/**
 * A parsing error with context
 */
export interface ParseError {
  readonly type: 'malformed_record' | 'invalid_hash' | 'invalid_date';
  readonly message: string;
  readonly record?: string;
  readonly field?: string;
}

/**
 * Parse git log output into Commit objects
 *
 * Expects output from:
 * git log --format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%b%x01
 *
 * @param raw - Raw stdout from git log command
 * @returns Parsed commits and any errors encountered
 */
export function parseCommits(raw: string): ParseCommitsResult {
  const commits: Commit[] = [];
  const errors: ParseError[] = [];

  if (!raw || raw.trim().length === 0) {
    return { commits, errors };
  }

  // Split on record separator, filter empty records
  const records = raw.split(RECORD_SEPARATOR).filter((r) => r.trim().length > 0);

  for (const record of records) {
    const result = parseCommitRecord(record);
    if (result.ok) {
      commits.push(result.commit);
    } else {
      errors.push(result.error);
    }
  }

  return { commits, errors };
}

/**
 * Parse a single commit record
 */
function parseCommitRecord(
  record: string
): { ok: true; commit: Commit } | { ok: false; error: ParseError } {
  const fields = record.split(FIELD_SEPARATOR);

  // We need at least 9 fields (body may be empty and not present)
  if (fields.length < EXPECTED_FIELDS - 1) {
    return {
      ok: false,
      error: {
        type: 'malformed_record',
        message: `Expected at least ${EXPECTED_FIELDS - 1} fields, got ${fields.length}`,
        record: record.substring(0, 100),
      },
    };
  }

  const [
    hashRaw,
    parentsRaw,
    authorName,
    authorEmail,
    authorDateRaw,
    committerName,
    committerEmail,
    commitDateRaw,
    subject,
    ...bodyParts
  ] = fields;

  // Validate and normalize hash
  const hash = hashRaw?.trim();
  if (!hash || !isValidHash(hash)) {
    return {
      ok: false,
      error: {
        type: 'invalid_hash',
        message: `Invalid commit hash: ${hash}`,
        field: 'hash',
        record: record.substring(0, 100),
      },
    };
  }

  // Parse parent hashes (space-separated, may be empty for root commits)
  const parents = parseParentHashes(parentsRaw ?? '');

  // Parse dates
  const authoredAt = parseDate(authorDateRaw ?? '');
  const committedAt = parseDate(commitDateRaw ?? '');

  if (!authoredAt) {
    return {
      ok: false,
      error: {
        type: 'invalid_date',
        message: `Invalid author date: ${authorDateRaw}`,
        field: 'authoredAt',
        record: record.substring(0, 100),
      },
    };
  }

  if (!committedAt) {
    return {
      ok: false,
      error: {
        type: 'invalid_date',
        message: `Invalid commit date: ${commitDateRaw}`,
        field: 'committedAt',
        record: record.substring(0, 100),
      },
    };
  }

  // Body is everything after subject, joined back together
  // (body itself may contain NULL bytes in rare cases)
  const body = bodyParts.join(FIELD_SEPARATOR).trim();

  const commit: Commit = {
    hash: unsafeCommitHash(hash),
    parents,
    author: { name: authorName ?? '', email: authorEmail ?? '' },
    committer: { name: committerName ?? '', email: committerEmail ?? '' },
    authoredAt,
    committedAt,
    subject: subject ?? '',
    body,
  };

  return { ok: true, commit };
}

/**
 * Validate a git hash (40 hex characters)
 */
function isValidHash(value: string): boolean {
  return /^[a-f0-9]{40}$/i.test(value);
}

/**
 * Parse space-separated parent hashes
 */
function parseParentHashes(raw: string): CommitHash[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  return trimmed
    .split(/\s+/)
    .filter((h) => h.length > 0)
    .filter((h) => isValidHash(h))
    .map((h) => unsafeCommitHash(h.toLowerCase()));
}

/**
 * Parse an ISO 8601 date string
 */
function parseDate(raw: string): Date | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }

  const date = new Date(trimmed);
  if (isNaN(date.getTime())) {
    return null;
  }

  return date;
}

// ============================================
// REF PARSING
// ============================================

/**
 * Result of parsing refs
 */
export interface ParseRefsResult {
  readonly refs: GitRef[];
  readonly branches: Branch[];
  readonly tags: Tag[];
  readonly errors: ParseError[];
}

/**
 * Options for ref parsing
 */
export interface ParseRefsOptions {
  /** Current HEAD branch name (to mark isHead) */
  readonly headBranch?: string | null;
  /** Patterns for protected branches (glob-style) */
  readonly protectedPatterns?: readonly string[];
}

/**
 * Parse git for-each-ref output into GitRef objects
 *
 * Expects output from:
 * git for-each-ref --format='%(objectname) %(refname) %(objecttype)' refs/heads refs/remotes refs/tags
 *
 * @param raw - Raw stdout from git for-each-ref command
 * @param options - Parsing options
 * @returns Parsed refs categorized by type
 */
export function parseRefs(raw: string, options: ParseRefsOptions = {}): ParseRefsResult {
  const refs: GitRef[] = [];
  const branches: Branch[] = [];
  const tags: Tag[] = [];
  const errors: ParseError[] = [];

  const { headBranch, protectedPatterns = [] } = options;

  if (!raw || raw.trim().length === 0) {
    return { refs, branches, tags, errors };
  }

  const lines = raw.split('\n').filter((line) => line.trim().length > 0);

  for (const line of lines) {
    const result = parseRefLine(line, headBranch, protectedPatterns);
    if (result.ok) {
      refs.push(result.ref);

      if (result.ref.type === 'local' || result.ref.type === 'remote') {
        branches.push(result.ref as Branch);
      } else if (result.ref.type === 'tag') {
        tags.push(result.ref as Tag);
      }
    } else if (result.error) {
      errors.push(result.error);
    }
    // Some lines may be intentionally skipped (result.skip)
  }

  return { refs, branches, tags, errors };
}

/**
 * Parse a single ref line
 */
function parseRefLine(
  line: string,
  headBranch: string | null | undefined,
  protectedPatterns: readonly string[]
): { ok: true; ref: GitRef } | { ok: false; error?: ParseError; skip?: boolean } {
  // Format: "hash refname objecttype"
  const parts = line.trim().split(/\s+/);

  if (parts.length < 2) {
    return {
      ok: false,
      error: {
        type: 'malformed_record',
        message: `Expected at least 2 parts in ref line, got ${parts.length}`,
        record: line,
      },
    };
  }

  const [hash, fullName, objectType] = parts;

  if (!hash || !isValidHash(hash)) {
    return {
      ok: false,
      error: {
        type: 'invalid_hash',
        message: `Invalid ref hash: ${hash}`,
        record: line,
      },
    };
  }

  if (!fullName) {
    return {
      ok: false,
      error: {
        type: 'malformed_record',
        message: 'Missing ref name',
        record: line,
      },
    };
  }

  const commitHash = unsafeCommitHash(hash.toLowerCase());

  // Parse based on ref prefix
  if (fullName.startsWith('refs/heads/')) {
    const name = fullName.slice('refs/heads/'.length);
    const branch: Branch = {
      name,
      fullName,
      commitHash,
      type: 'local',
      isHead: name === headBranch,
      isProtected: matchesProtectedPattern(name, protectedPatterns),
    };
    return { ok: true, ref: branch };
  }

  if (fullName.startsWith('refs/remotes/')) {
    const name = fullName.slice('refs/remotes/'.length);

    // Skip HEAD refs for remotes (e.g., refs/remotes/origin/HEAD)
    if (name.endsWith('/HEAD')) {
      return { ok: false, skip: true };
    }

    const remoteName = extractRemoteName(name);
    const branch: Branch = {
      name,
      fullName,
      commitHash,
      type: 'remote',
      isHead: false,
      remoteName,
      isProtected: matchesProtectedPattern(name, protectedPatterns),
    };
    return { ok: true, ref: branch };
  }

  if (fullName.startsWith('refs/tags/')) {
    const name = fullName.slice('refs/tags/'.length);
    // objectType === 'tag' means annotated tag, 'commit' means lightweight
    const isAnnotated = objectType === 'tag';
    const tag: Tag = {
      name,
      fullName,
      commitHash,
      type: 'tag',
      isHead: false,
      isAnnotated,
    };
    return { ok: true, ref: tag };
  }

  // Unknown ref type - skip silently
  return { ok: false, skip: true };
}

/**
 * Extract remote name from a remote branch name
 * e.g., "origin/main" -> "origin"
 */
function extractRemoteName(name: string): string {
  const slashIndex = name.indexOf('/');
  if (slashIndex === -1) {
    return name;
  }
  return name.substring(0, slashIndex);
}

/**
 * Check if a branch name matches any protected pattern
 * Supports simple glob patterns: * matches any characters
 */
function matchesProtectedPattern(name: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (matchGlob(name, pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Simple glob matching (* matches any sequence of characters)
 */
function matchGlob(value: string, pattern: string): boolean {
  // Exact match
  if (pattern === value) {
    return true;
  }

  // Convert glob pattern to regex
  // Escape regex special chars except *
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(value);
}

// ============================================
// HEAD PARSING
// ============================================

/**
 * Parse the current HEAD reference
 *
 * @param symbolicRefOutput - Output from `git symbolic-ref --short HEAD`
 * @param revParseOutput - Output from `git rev-parse HEAD`
 * @returns HEAD state (branch name and/or commit hash)
 */
export function parseHead(
  symbolicRefOutput: string | null,
  revParseOutput: string | null
): { headRef: string | null; headCommit: CommitHash | null } {
  let headRef: string | null = null;
  let headCommit: CommitHash | null = null;

  // Parse branch name (may fail if detached HEAD)
  if (symbolicRefOutput) {
    const trimmed = symbolicRefOutput.trim();
    if (trimmed.length > 0) {
      headRef = trimmed;
    }
  }

  // Parse commit hash
  if (revParseOutput) {
    const trimmed = revParseOutput.trim().toLowerCase();
    if (isValidHash(trimmed)) {
      headCommit = unsafeCommitHash(trimmed);
    }
  }

  return { headRef, headCommit };
}

// ============================================
// UTILITY EXPORTS
// ============================================

export { isValidHash };
