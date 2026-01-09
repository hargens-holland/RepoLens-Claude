import { describe, it, expect } from 'vitest';
import { parseCommits, parseRefs, parseHead, isValidHash } from './parser.js';

describe('parseCommits', () => {
  // Field separator (NULL byte)
  const F = '\x00';
  // Record separator
  const R = '\x01';

  const makeCommitRecord = (
    hash: string,
    parents: string,
    authorName: string,
    authorEmail: string,
    authorDate: string,
    committerName: string,
    committerEmail: string,
    commitDate: string,
    subject: string,
    body: string = ''
  ): string => {
    return [
      hash,
      parents,
      authorName,
      authorEmail,
      authorDate,
      committerName,
      committerEmail,
      commitDate,
      subject,
      body,
    ].join(F);
  };

  it('parses a single commit', () => {
    const raw = makeCommitRecord(
      'a'.repeat(40),
      '',
      'Alice',
      'alice@example.com',
      '2024-01-15T10:30:00Z',
      'Alice',
      'alice@example.com',
      '2024-01-15T10:30:00Z',
      'Initial commit',
      'This is the body'
    );

    const result = parseCommits(raw);

    expect(result.errors).toHaveLength(0);
    expect(result.commits).toHaveLength(1);

    const commit = result.commits[0]!;
    expect(commit.hash).toBe('a'.repeat(40));
    expect(commit.parents).toHaveLength(0);
    expect(commit.author.name).toBe('Alice');
    expect(commit.author.email).toBe('alice@example.com');
    expect(commit.subject).toBe('Initial commit');
    expect(commit.body).toBe('This is the body');
  });

  it('parses multiple commits', () => {
    const commit1 = makeCommitRecord(
      'a'.repeat(40),
      '',
      'Alice',
      'alice@example.com',
      '2024-01-15T10:00:00Z',
      'Alice',
      'alice@example.com',
      '2024-01-15T10:00:00Z',
      'First commit'
    );

    const commit2 = makeCommitRecord(
      'b'.repeat(40),
      'a'.repeat(40),
      'Bob',
      'bob@example.com',
      '2024-01-15T11:00:00Z',
      'Bob',
      'bob@example.com',
      '2024-01-15T11:00:00Z',
      'Second commit'
    );

    const raw = commit1 + R + commit2;
    const result = parseCommits(raw);

    expect(result.errors).toHaveLength(0);
    expect(result.commits).toHaveLength(2);
    expect(result.commits[0]!.subject).toBe('First commit');
    expect(result.commits[1]!.subject).toBe('Second commit');
  });

  it('parses commit with single parent', () => {
    const parentHash = 'a'.repeat(40);
    const raw = makeCommitRecord(
      'b'.repeat(40),
      parentHash,
      'Alice',
      'alice@example.com',
      '2024-01-15T10:30:00Z',
      'Alice',
      'alice@example.com',
      '2024-01-15T10:30:00Z',
      'Child commit'
    );

    const result = parseCommits(raw);

    expect(result.commits[0]!.parents).toHaveLength(1);
    expect(result.commits[0]!.parents[0]).toBe(parentHash);
  });

  it('parses merge commit with multiple parents', () => {
    const parent1 = 'a'.repeat(40);
    const parent2 = 'b'.repeat(40);
    const raw = makeCommitRecord(
      'c'.repeat(40),
      `${parent1} ${parent2}`,
      'Alice',
      'alice@example.com',
      '2024-01-15T10:30:00Z',
      'Alice',
      'alice@example.com',
      '2024-01-15T10:30:00Z',
      'Merge branch feature'
    );

    const result = parseCommits(raw);

    expect(result.commits[0]!.parents).toHaveLength(2);
    expect(result.commits[0]!.parents[0]).toBe(parent1);
    expect(result.commits[0]!.parents[1]).toBe(parent2);
  });

  it('handles empty input', () => {
    expect(parseCommits('').commits).toHaveLength(0);
    expect(parseCommits('   ').commits).toHaveLength(0);
    expect(parseCommits('\n\n').commits).toHaveLength(0);
  });

  it('handles commit with empty body', () => {
    const raw = makeCommitRecord(
      'a'.repeat(40),
      '',
      'Alice',
      'alice@example.com',
      '2024-01-15T10:30:00Z',
      'Alice',
      'alice@example.com',
      '2024-01-15T10:30:00Z',
      'No body commit',
      ''
    );

    const result = parseCommits(raw);

    expect(result.commits[0]!.body).toBe('');
  });

  it('handles multiline body', () => {
    const body = 'Line 1\nLine 2\n\nLine 4';
    const raw = makeCommitRecord(
      'a'.repeat(40),
      '',
      'Alice',
      'alice@example.com',
      '2024-01-15T10:30:00Z',
      'Alice',
      'alice@example.com',
      '2024-01-15T10:30:00Z',
      'Commit with long body',
      body
    );

    const result = parseCommits(raw);

    expect(result.commits[0]!.body).toBe(body);
  });

  it('normalizes hash to lowercase', () => {
    const raw = makeCommitRecord(
      'A'.repeat(40),
      'B'.repeat(40),
      'Alice',
      'alice@example.com',
      '2024-01-15T10:30:00Z',
      'Alice',
      'alice@example.com',
      '2024-01-15T10:30:00Z',
      'Test'
    );

    const result = parseCommits(raw);

    expect(result.commits[0]!.hash).toBe('a'.repeat(40));
    expect(result.commits[0]!.parents[0]).toBe('b'.repeat(40));
  });

  it('reports error for invalid hash', () => {
    const raw = makeCommitRecord(
      'not-a-valid-hash',
      '',
      'Alice',
      'alice@example.com',
      '2024-01-15T10:30:00Z',
      'Alice',
      'alice@example.com',
      '2024-01-15T10:30:00Z',
      'Test'
    );

    const result = parseCommits(raw);

    expect(result.commits).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.type).toBe('invalid_hash');
  });

  it('reports error for invalid date', () => {
    const raw = makeCommitRecord(
      'a'.repeat(40),
      '',
      'Alice',
      'alice@example.com',
      'not-a-date',
      'Alice',
      'alice@example.com',
      '2024-01-15T10:30:00Z',
      'Test'
    );

    const result = parseCommits(raw);

    expect(result.commits).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.type).toBe('invalid_date');
  });

  it('reports error for malformed record', () => {
    const raw = 'not enough fields';

    const result = parseCommits(raw);

    expect(result.commits).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.type).toBe('malformed_record');
  });

  it('continues parsing after error', () => {
    const badCommit = 'bad-hash' + F + 'not enough';
    const goodCommit = makeCommitRecord(
      'a'.repeat(40),
      '',
      'Alice',
      'alice@example.com',
      '2024-01-15T10:30:00Z',
      'Alice',
      'alice@example.com',
      '2024-01-15T10:30:00Z',
      'Good commit'
    );

    const raw = badCommit + R + goodCommit;
    const result = parseCommits(raw);

    expect(result.commits).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.commits[0]!.subject).toBe('Good commit');
  });

  it('filters invalid parent hashes', () => {
    const raw = makeCommitRecord(
      'a'.repeat(40),
      'invalid-parent ' + 'b'.repeat(40),
      'Alice',
      'alice@example.com',
      '2024-01-15T10:30:00Z',
      'Alice',
      'alice@example.com',
      '2024-01-15T10:30:00Z',
      'Test'
    );

    const result = parseCommits(raw);

    // Only valid parent should be included
    expect(result.commits[0]!.parents).toHaveLength(1);
    expect(result.commits[0]!.parents[0]).toBe('b'.repeat(40));
  });
});

describe('parseRefs', () => {
  const makeRefLine = (hash: string, refname: string, objectType: string = 'commit'): string => {
    return `${hash} ${refname} ${objectType}`;
  };

  it('parses local branch', () => {
    const raw = makeRefLine('a'.repeat(40), 'refs/heads/main');
    const result = parseRefs(raw);

    expect(result.errors).toHaveLength(0);
    expect(result.refs).toHaveLength(1);
    expect(result.branches).toHaveLength(1);
    expect(result.tags).toHaveLength(0);

    const branch = result.branches[0]!;
    expect(branch.name).toBe('main');
    expect(branch.fullName).toBe('refs/heads/main');
    expect(branch.type).toBe('local');
    expect(branch.isHead).toBe(false);
    expect(branch.isProtected).toBe(false);
  });

  it('marks HEAD branch', () => {
    const raw = makeRefLine('a'.repeat(40), 'refs/heads/main');
    const result = parseRefs(raw, { headBranch: 'main' });

    expect(result.branches[0]!.isHead).toBe(true);
  });

  it('parses remote branch', () => {
    const raw = makeRefLine('a'.repeat(40), 'refs/remotes/origin/main');
    const result = parseRefs(raw);

    expect(result.branches).toHaveLength(1);

    const branch = result.branches[0]!;
    expect(branch.name).toBe('origin/main');
    expect(branch.type).toBe('remote');
    expect(branch.remoteName).toBe('origin');
  });

  it('skips remote HEAD refs', () => {
    const raw = makeRefLine('a'.repeat(40), 'refs/remotes/origin/HEAD');
    const result = parseRefs(raw);

    expect(result.refs).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('parses lightweight tag', () => {
    const raw = makeRefLine('a'.repeat(40), 'refs/tags/v1.0.0', 'commit');
    const result = parseRefs(raw);

    expect(result.tags).toHaveLength(1);

    const tag = result.tags[0]!;
    expect(tag.name).toBe('v1.0.0');
    expect(tag.type).toBe('tag');
    expect(tag.isAnnotated).toBe(false);
  });

  it('parses annotated tag', () => {
    const raw = makeRefLine('a'.repeat(40), 'refs/tags/v1.0.0', 'tag');
    const result = parseRefs(raw);

    expect(result.tags[0]!.isAnnotated).toBe(true);
  });

  it('parses multiple refs', () => {
    const lines = [
      makeRefLine('a'.repeat(40), 'refs/heads/main'),
      makeRefLine('b'.repeat(40), 'refs/heads/feature'),
      makeRefLine('c'.repeat(40), 'refs/remotes/origin/main'),
      makeRefLine('d'.repeat(40), 'refs/tags/v1.0.0'),
    ].join('\n');

    const result = parseRefs(lines);

    expect(result.refs).toHaveLength(4);
    expect(result.branches).toHaveLength(3);
    expect(result.tags).toHaveLength(1);
  });

  it('handles empty input', () => {
    expect(parseRefs('').refs).toHaveLength(0);
    expect(parseRefs('   ').refs).toHaveLength(0);
  });

  it('marks protected branches with exact match', () => {
    const raw = makeRefLine('a'.repeat(40), 'refs/heads/main');
    const result = parseRefs(raw, { protectedPatterns: ['main'] });

    expect(result.branches[0]!.isProtected).toBe(true);
  });

  it('marks protected branches with glob pattern', () => {
    const lines = [
      makeRefLine('a'.repeat(40), 'refs/heads/release/1.0'),
      makeRefLine('b'.repeat(40), 'refs/heads/release/2.0'),
      makeRefLine('c'.repeat(40), 'refs/heads/feature/foo'),
    ].join('\n');

    const result = parseRefs(lines, { protectedPatterns: ['release/*'] });

    expect(result.branches[0]!.isProtected).toBe(true);
    expect(result.branches[1]!.isProtected).toBe(true);
    expect(result.branches[2]!.isProtected).toBe(false);
  });

  it('marks protected branches with multiple patterns', () => {
    const lines = [
      makeRefLine('a'.repeat(40), 'refs/heads/main'),
      makeRefLine('b'.repeat(40), 'refs/heads/develop'),
      makeRefLine('c'.repeat(40), 'refs/heads/feature/foo'),
    ].join('\n');

    const result = parseRefs(lines, { protectedPatterns: ['main', 'develop'] });

    expect(result.branches[0]!.isProtected).toBe(true);
    expect(result.branches[1]!.isProtected).toBe(true);
    expect(result.branches[2]!.isProtected).toBe(false);
  });

  it('reports error for invalid hash', () => {
    const raw = 'invalid-hash refs/heads/main commit';
    const result = parseRefs(raw);

    expect(result.refs).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.type).toBe('invalid_hash');
  });

  it('reports error for malformed line', () => {
    const raw = 'only-one-field';
    const result = parseRefs(raw);

    expect(result.refs).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.type).toBe('malformed_record');
  });

  it('normalizes hash to lowercase', () => {
    const raw = makeRefLine('A'.repeat(40), 'refs/heads/main');
    const result = parseRefs(raw);

    expect(result.refs[0]!.commitHash).toBe('a'.repeat(40));
  });

  it('skips unknown ref types', () => {
    const raw = makeRefLine('a'.repeat(40), 'refs/unknown/something');
    const result = parseRefs(raw);

    expect(result.refs).toHaveLength(0);
    expect(result.errors).toHaveLength(0); // Silently skipped, not an error
  });
});

describe('parseHead', () => {
  it('parses branch and commit', () => {
    const result = parseHead('main', 'a'.repeat(40));

    expect(result.headRef).toBe('main');
    expect(result.headCommit).toBe('a'.repeat(40));
  });

  it('handles detached HEAD (no branch)', () => {
    const result = parseHead(null, 'a'.repeat(40));

    expect(result.headRef).toBeNull();
    expect(result.headCommit).toBe('a'.repeat(40));
  });

  it('handles empty repository (no commit)', () => {
    const result = parseHead(null, null);

    expect(result.headRef).toBeNull();
    expect(result.headCommit).toBeNull();
  });

  it('trims whitespace', () => {
    const result = parseHead('  main\n', '  ' + 'a'.repeat(40) + '\n');

    expect(result.headRef).toBe('main');
    expect(result.headCommit).toBe('a'.repeat(40));
  });

  it('normalizes commit hash to lowercase', () => {
    const result = parseHead('main', 'A'.repeat(40));

    expect(result.headCommit).toBe('a'.repeat(40));
  });

  it('returns null for invalid commit hash', () => {
    const result = parseHead('main', 'not-a-hash');

    expect(result.headRef).toBe('main');
    expect(result.headCommit).toBeNull();
  });
});

describe('isValidHash', () => {
  it('accepts valid 40-char hex hash', () => {
    expect(isValidHash('a'.repeat(40))).toBe(true);
    expect(isValidHash('0123456789abcdef'.repeat(2) + '01234567')).toBe(true);
  });

  it('accepts uppercase hash', () => {
    expect(isValidHash('A'.repeat(40))).toBe(true);
  });

  it('rejects short hash', () => {
    expect(isValidHash('a'.repeat(39))).toBe(false);
    expect(isValidHash('a'.repeat(7))).toBe(false);
  });

  it('rejects long hash', () => {
    expect(isValidHash('a'.repeat(41))).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(isValidHash('g'.repeat(40))).toBe(false);
    expect(isValidHash('a'.repeat(39) + 'z')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidHash('')).toBe(false);
  });
});
