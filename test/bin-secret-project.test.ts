import { describe, expect, it } from 'vitest';
import {
  projectSecretMetadata,
  projectSecretList,
} from '../src/lib/bin-secret';
import { filterVaultItems } from '../src/routes/vault/list';
import { validateSecretId } from '../src/routes/vault/show';

describe('projectSecretMetadata (Issue #5 hardening)', () => {
  it('strips any plaintext-typical fields from upstream JSON', () => {
    const raw = {
      id: 'alpha',
      name: 'Alpha note',
      mtime: '2026-07-01T00:00:00Z',
      kind: 'note',
      tags: ['prod', 'db'],
      sha: 'deadbeef',
      preview: 'first 8 chars',
      content: 'TOP-SECRET-CONTENT',
      plaintext: 'SHOULD-NOT-LEAK',
      secret: 'ANOTHER-VALUE',
      value: 'p4ssw0rd',
      body: 'hello world',
      apiKey: 'AKIA-PRIVATE',
    };
    const projected = projectSecretMetadata(raw);
    expect(projected).not.toBeNull();
    expect(projected).toEqual({
      id: 'alpha',
      name: 'Alpha note',
      mtime: '2026-07-01T00:00:00Z',
      kind: 'note',
      tags: ['prod', 'db'],
      sha: 'deadbeef',
      preview: 'first 8 chars',
    });
    expect(projected).not.toHaveProperty('content');
    expect(projected).not.toHaveProperty('plaintext');
    expect(projected).not.toHaveProperty('secret');
    expect(projected).not.toHaveProperty('value');
    expect(projected).not.toHaveProperty('body');
    expect(projected).not.toHaveProperty('apiKey');
  });

  it('returns null when id is missing or empty', () => {
    expect(projectSecretMetadata({})).toBeNull();
    expect(projectSecretMetadata({ id: '' })).toBeNull();
    expect(projectSecretMetadata({ id: 42 })).toBeNull();
  });

  it('coerces non-string tags/values to safe defaults', () => {
    const projected = projectSecretMetadata({
      id: 'a',
      tags: ['ok', 42, null, 'still-ok', { hidden: 'leak' }],
      name: 1234,
      mtime: null,
    });
    expect(projected).not.toBeNull();
    expect(projected!.tags).toEqual(['ok', 'still-ok']);
    expect(projected!.name).toBeUndefined();
    expect(projected!.mtime).toBeUndefined();
  });
});

describe('projectSecretList', () => {
  it('drops items with missing ids', () => {
    const raw = {
      items: [
        { id: 'good', name: 'G' },
        { name: 'no-id' },
        null,
        'not-an-object',
        { id: 'also-good' },
      ],
    };
    expect(projectSecretList(raw).map((i) => i.id)).toEqual(['good', 'also-good']);
  });

  it('returns [] for unexpected shapes', () => {
    expect(projectSecretList(null)).toEqual([]);
    expect(projectSecretList({ items: 'not-an-array' })).toEqual([]);
    expect(projectSecretList({ notItems: [] })).toEqual([]);
  });
});

describe('validateSecretId (Issue #5 hardening)', () => {
  it('accepts [A-Za-z0-9._-] up to 128 chars', () => {
    expect(validateSecretId('alpha-beta_1.0')).toBe('alpha-beta_1.0');
    expect(validateSecretId('x'.repeat(128))).toBe('x'.repeat(128));
  });

  it('rejects anything not in [A-Za-z0-9._-]', () => {
    expect(validateSecretId('has space')).toBeNull();
    expect(validateSecretId('/etc/passwd')).toBeNull();
    expect(validateSecretId('a$b')).toBeNull();
    expect(validateSecretId('a;b')).toBeNull();
    expect(validateSecretId('a`b')).toBeNull();
    expect(validateSecretId('$(whoami)')).toBeNull();
    expect(validateSecretId('foo"bar')).toBeNull();
  });

  it('rejects empty / whitespace-only ids', () => {
    expect(validateSecretId('')).toBeNull();
    expect(validateSecretId('   ')).toBeNull();
  });

  it('rejects ids over 128 chars', () => {
    expect(validateSecretId('x'.repeat(129))).toBeNull();
  });
});

describe('filterVaultItems (Issue #5 search)', () => {
  const items = [
    { id: 'alpha-secret', name: 'Production DB', kind: 'note', tags: ['db', 'prod'] },
    { id: 'beta-secret', name: 'Sandbox', kind: 'note' },
    { id: 'gamma-token', name: 'CI token', kind: 'token', sha: 'deadbeefcafe' },
  ];

  it('returns all items when query is empty / whitespace', () => {
    expect(filterVaultItems(items, '')).toHaveLength(3);
    expect(filterVaultItems(items, '   ')).toHaveLength(3);
  });

  it('filters by id (case-insensitive substring)', () => {
    expect(filterVaultItems(items, 'ALPHA')).toHaveLength(1);
    expect(filterVaultItems(items, 'beta')).toHaveLength(1);
    expect(filterVaultItems(items, 'token')).toHaveLength(1);
  });

  it('filters by tag (and distinguishes substring in name vs tag)', () => {
    // 'Production' contains 'prod' (substring), and 'prod' is also a tag.
    // Both tag and name contain the needle, so item 0 matches via both;
    // items 1 (Sandbox) and 2 (CI token) don't contain 'prod' anywhere.
    expect(filterVaultItems(items, 'prod')).toHaveLength(1);
    expect(filterVaultItems(items, 'rod')).toHaveLength(1);
    expect(filterVaultItems(items, 'token')).toHaveLength(1);
  });

  it('filters by sha', () => {
    expect(filterVaultItems(items, 'cafe')).toHaveLength(1);
  });

  it('returns [] when nothing matches', () => {
    expect(filterVaultItems(items, 'nonexistent')).toHaveLength(0);
  });
});
