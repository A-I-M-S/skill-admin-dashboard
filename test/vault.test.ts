import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { FastifyInstance } from 'fastify';

// Env is set in test/setup-env.ts (vitest setupFiles) — runs BEFORE the
// server module is loaded, so config.ts picks up the test values.
import { buildServer } from '../src/server';
import { getSessionCookieName } from '../src/auth/session';
import { mockSubprocess, type MockSubprocessHandle } from './helpers/mock-subprocess';

// Mock the subprocess module so production code (bin-secret, openclaw-bin)
// calls our scripted fake instead of the real node:child_process.spawn.
// vitest hoists `vi.mock` calls to the top of the file, so this is in effect
// before any import below triggers loading of the production modules.
vi.mock('../src/lib/subprocess', async () => {
  const helper = await import('./helpers/mock-subprocess');
  const actual = await vi.importActual<typeof import('../src/lib/subprocess')>(
    '../src/lib/subprocess',
  );
  return { ...actual, runSubprocess: helper.mockRunSubprocess };
});

const COOKIE_NAME = getSessionCookieName();

const RUNTIME_ROOT = join(process.cwd(), 'runtime', 'tmp');
mkdirSync(RUNTIME_ROOT, { recursive: true });
const TEST_TMP_ROOT = mkdtempSync(join(RUNTIME_ROOT, `vault-test-${randomUUID()}-`));

function setCookieFromResponse(res: request.Response): string {
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) return '';
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  return arr
    .map((c) => (Array.isArray(c) ? c.join('; ') : c))
    .filter((c) => c.startsWith(`${COOKIE_NAME}=`))
    .join('; ');
}

async function loginAndGetCookies(
  app: FastifyInstance,
  username: string,
  password: string,
): Promise<request.Response> {
  return request(app.server)
    .post('/login')
    .type('form')
    .send({ username, password })
    .redirects(0);
}

async function fetchCsrfFromAuthenticatedPage(app: FastifyInstance, cookie: string): Promise<string> {
  const res = await request(app.server).get('/').set('Cookie', cookie);
  const match = /name="_csrf"\s+value="([^"]+)"/.exec(res.text);
  if (!match) throw new Error('csrf token not found on authenticated page');
  return match[1] ?? '';
}

describe('/ status dashboard + bin/secret subprocess wrapper (Issue #4)', () => {
  let app: FastifyInstance;
  let workdir: string;
  let mock: MockSubprocessHandle;
  let savedKmsBackend: string | undefined;
  let savedKmsProjectUrl: string | undefined;
  let savedKmsApiBlob: string | undefined;
  let savedKmsPassphrase: string | undefined;

  beforeAll(async () => {
    workdir = mkdtempSync(join(TEST_TMP_ROOT, 'case-'));
    process.env.AUTH_AUDIT_LOG = join(workdir, 'audit.log');
    // Pre-set the skill-secret env so the dashboard can claim "configured".
    savedKmsBackend = process.env.SKILL_SECRET_KMS_BACKEND;
    savedKmsProjectUrl = process.env.SKILL_SECRET_KMS_PROJECT_URL;
    savedKmsApiBlob = process.env.SKILL_SECRET_KMS_API_BLOB;
    savedKmsPassphrase = process.env.SKILL_SECRET_PASSPHRASE;
    process.env.SKILL_SECRET_KMS_BACKEND = 'supabase';
    process.env.SKILL_SECRET_KMS_PROJECT_URL = 'https://example.supabase.co';
    process.env.SKILL_SECRET_KMS_API_BLOB = 'deadbeef-base64-blob';
    process.env.SKILL_SECRET_PASSPHRASE = 'integration-test-passphrase';

    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (savedKmsBackend === undefined) delete process.env.SKILL_SECRET_KMS_BACKEND;
    else process.env.SKILL_SECRET_KMS_BACKEND = savedKmsBackend;
    if (savedKmsProjectUrl === undefined) delete process.env.SKILL_SECRET_KMS_PROJECT_URL;
    else process.env.SKILL_SECRET_KMS_PROJECT_URL = savedKmsProjectUrl;
    if (savedKmsApiBlob === undefined) delete process.env.SKILL_SECRET_KMS_API_BLOB;
    else process.env.SKILL_SECRET_KMS_API_BLOB = savedKmsApiBlob;
    if (savedKmsPassphrase === undefined) delete process.env.SKILL_SECRET_PASSPHRASE;
    else process.env.SKILL_SECRET_PASSPHRASE = savedKmsPassphrase;
    rmSync(TEST_TMP_ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    mock = mockSubprocess();
    mock.install();
  });

  afterEach(() => {
    mock.restore();
  });

  describe('GET /', () => {
    it('redirects to /login for unauthenticated requests', async () => {
      const res = await request(app.server).get('/').redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/login');
    });

    it('returns 200 with the status dashboard for an authenticated user', async () => {
      mock.whenMatch(
        (call) => call.command.endsWith('bin/secret') && call.args[0] === 'whoami',
        () => ({
          code: 0,
          stdout: JSON.stringify({
            project_url: 'https://example.supabase.co',
            anon_key_id: 'eyJabcde…',
            region: 'us-east-1',
            auth_status: 'authenticated',
            backend: 'supabase',
          }),
        }),
      );
      mock.whenMatch(
        (call) => call.command.endsWith('bin/secret') && call.args[0] === 'list',
        () => ({
          code: 0,
          stdout: JSON.stringify({
            items: [
              { id: 'n1', mtime: '2026-07-01T10:00:00Z', kind: 'note' },
              { id: 'n2', mtime: '2026-07-02T10:00:00Z', kind: 'note' },
            ],
          }),
        }),
      );
      mock.setDefault((call) => {
        if (/(^|\/)cron$/.test(call.command)) {
          return { code: 0, stdout: JSON.stringify({ jobs: [{}, {}] }) };
        }
        if (/(^|\/)sessions_list$/.test(call.command)) {
          return { code: 0, stdout: JSON.stringify({ sessions: [{}, {}, {}] }) };
        }
        return { code: 0, stdout: '{}' };
      });

      const login = await loginAndGetCookies(app, 'admin', 'correct-horse-battery-staple');
      const cookie = setCookieFromResponse(login);

      const res = await request(app.server).get('/').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.text).toContain('Overview');
      expect(res.text).toContain('Vault (skill-secret)');
      expect(res.text).toContain('Recent secrets');
      expect(res.text).toContain('Cron jobs');
      expect(res.text).toContain('Active agent sessions');
      expect(res.text).toContain('supabase');
      expect(res.text).toContain('us-east-1');
    });
  });

  describe('bin/secret env inheritance (Risk #4)', () => {
    it('subprocess inherits SKILL_SECRET_KMS_* from the dashboard env, not the request body', async () => {
      let whoamiCall: { env: NodeJS.ProcessEnv; args: string[] } | null = null;
      let listCall: { env: NodeJS.ProcessEnv; args: string[] } | null = null;

      mock.whenMatch(
        (call) => call.command.endsWith('bin/secret') && call.args[0] === 'whoami',
        (call) => {
          whoamiCall = { env: call.env, args: call.args };
          return {
            code: 0,
            stdout: JSON.stringify({
              project_url: 'https://example.supabase.co',
              anon_key_id: 'eyJabcde…',
              region: 'us-east-1',
              auth_status: 'authenticated',
              backend: 'supabase',
            }),
          };
        },
      );
      mock.whenMatch(
        (call) => call.command.endsWith('bin/secret') && call.args[0] === 'list',
        (call) => {
          listCall = { env: call.env, args: call.args };
          return { code: 0, stdout: JSON.stringify({ items: [] }) };
        },
      );
      mock.setDefault((call) => {
        if (/(^|\/)cron$/.test(call.command)) {
          return { code: 0, stdout: JSON.stringify({ jobs: [] }) };
        }
        if (/(^|\/)sessions_list$/.test(call.command)) {
          return { code: 0, stdout: JSON.stringify({ sessions: [] }) };
        }
        return { code: 0, stdout: '{}' };
      });

      const login = await loginAndGetCookies(app, 'admin', 'correct-horse-battery-staple');
      const cookie = setCookieFromResponse(login);

      // Fetch the dashboard so the route spawns the subprocess. The /logout
      // form (or any subsequent mutating request) is the threat vector: a
      // malicious client could try to inject env vars into the body. The
      // dashboard MUST ignore body fields and inherit env from process.env
      // (which the systemd unit populates from .env via EnvironmentFile=).
      await request(app.server).get('/').set('Cookie', cookie);

      // Now fire a subsequent /logout attempt with an injected body to
      // ensure the CSRF gate rejects the env-override attempt entirely.
      const csrf = await fetchCsrfFromAuthenticatedPage(app, cookie);
      await request(app.server)
        .post('/logout')
        .set('Cookie', cookie)
        .type('form')
        .send({
          _csrf: csrf,
          SKILL_SECRET_KMS_BACKEND: 'attacker-supabase',
          SKILL_SECRET_KMS_API_BLOB: 'attacker-blob',
        })
        .redirects(0);

      // After the failed /logout, the same session can still fetch /; re-fetch
      // to confirm the env-override attempt did not reach the subprocess.
      await request(app.server).get('/').set('Cookie', cookie);

      expect(whoamiCall).not.toBeNull();
      expect(listCall).not.toBeNull();
      expect(whoamiCall!.env.SKILL_SECRET_KMS_BACKEND).toBe('supabase');
      expect(whoamiCall!.env.SKILL_SECRET_KMS_PROJECT_URL).toBe('https://example.supabase.co');
      expect(whoamiCall!.env.SKILL_SECRET_KMS_API_BLOB).toBe('deadbeef-base64-blob');
      expect(listCall!.env.SKILL_SECRET_KMS_BACKEND).toBe('supabase');
      expect(listCall!.env.SKILL_SECRET_KMS_PROJECT_URL).toBe('https://example.supabase.co');
      expect(listCall!.env.SKILL_SECRET_KMS_API_BLOB).toBe('deadbeef-base64-blob');
      // The malicious request body must NOT have leaked into the subprocess env.
      expect(whoamiCall!.env.SKILL_SECRET_KMS_API_BLOB).not.toBe('attacker-blob');
      expect(listCall!.env.SKILL_SECRET_KMS_API_BLOB).not.toBe('attacker-blob');
    });

    it('whoami is invoked via the resolved SKILL_SECRET_BIN path', async () => {
      const expectedPath = process.env.SKILL_SECRET_BIN ?? '/root/.openclaw/workspace/dev/projects/skill-secret/bin/secret';
      mock.whenMatch(
        (call) => call.command.endsWith('bin/secret') && call.args[0] === 'whoami',
        () => ({
          code: 0,
          stdout: JSON.stringify({ backend: 'supabase', anon_key_id: 'eyJabcde…' }),
        }),
      );
      mock.whenMatch(
        (call) => call.command.endsWith('bin/secret') && call.args[0] === 'list',
        () => ({ code: 0, stdout: JSON.stringify({ items: [] }) }),
      );
      mock.setDefault((call) => {
        if (/(^|\/)cron$/.test(call.command)) {
          return { code: 0, stdout: JSON.stringify({ jobs: [] }) };
        }
        if (/(^|\/)sessions_list$/.test(call.command)) {
          return { code: 0, stdout: JSON.stringify({ sessions: [] }) };
        }
        return { code: 0, stdout: '{}' };
      });

      const login = await loginAndGetCookies(app, 'admin', 'correct-horse-battery-staple');
      const cookie = setCookieFromResponse(login);
      await request(app.server).get('/').set('Cookie', cookie);

      const whoamiCalls = mock.calls.filter(
        (c) => c.command.endsWith('bin/secret') && c.args[0] === 'whoami',
      );
      expect(whoamiCalls.length).toBe(1);
      expect(whoamiCalls[0]!.command).toBe(expectedPath);
      expect(whoamiCalls[0]!.args).toEqual(['whoami']);
    });
  });

  describe('non-zero exit + empty stdout → "vault unreachable" (Risk #1)', () => {
    it('GET / still returns 200 with a vault-unreachable badge when bin/secret fails', async () => {
      mock.whenMatch(
        (call) => call.command.endsWith('bin/secret') && call.args[0] === 'whoami',
        () => ({ code: 4, stdout: '', stderr: 'ERROR: Not initialized. Run init first.' }),
      );
      mock.whenMatch(
        (call) => call.command.endsWith('bin/secret') && call.args[0] === 'list',
        () => ({ code: 4, stdout: '', stderr: 'ERROR: Not initialized. Run init first.' }),
      );
      mock.setDefault((call) => {
        if (/(^|\/)cron$/.test(call.command)) {
          return { code: 0, stdout: JSON.stringify({ jobs: [] }) };
        }
        if (/(^|\/)sessions_list$/.test(call.command)) {
          return { code: 0, stdout: JSON.stringify({ sessions: [] }) };
        }
        return { code: 0, stdout: '{}' };
      });

      const login = await loginAndGetCookies(app, 'admin', 'correct-horse-battery-staple');
      const cookie = setCookieFromResponse(login);
      const res = await request(app.server).get('/').set('Cookie', cookie);

      expect(res.status).toBe(200);
      // "unreachable" badge is rendered for the vault status, NOT a 500.
      expect(res.text).toContain('unreachable');
      expect(res.text).toContain('vault unreachable');
    });

    it('invalid JSON surfaces as invalid_json, not 500', async () => {
      mock.whenMatch(
        (call) => call.command.endsWith('bin/secret') && call.args[0] === 'whoami',
        () => ({ code: 0, stdout: 'not-json-at-all' }),
      );
      mock.whenMatch(
        (call) => call.command.endsWith('bin/secret') && call.args[0] === 'list',
        () => ({ code: 0, stdout: 'not-json-at-all' }),
      );
      mock.setDefault((call) => {
        if (/(^|\/)cron$/.test(call.command)) {
          return { code: 0, stdout: JSON.stringify({ jobs: [] }) };
        }
        if (/(^|\/)sessions_list$/.test(call.command)) {
          return { code: 0, stdout: JSON.stringify({ sessions: [] }) };
        }
        return { code: 0, stdout: '{}' };
      });

      const login = await loginAndGetCookies(app, 'admin', 'correct-horse-battery-staple');
      const cookie = setCookieFromResponse(login);
      const res = await request(app.server).get('/').set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.text).toContain('invalid json');
    });
  });

  describe('bin/secret subprocess direct calls (lib/bin-secret.ts)', () => {
    it('whoami passes through JSON stdout', async () => {
      mock.setDefault((call) => {
        if (call.command.endsWith('bin/secret') && call.args[0] === 'whoami') {
          return {
            code: 0,
            stdout: JSON.stringify({ backend: 'supabase', anon_key_id: 'eyJabcde…' }),
          };
        }
        return { code: 0, stdout: '{}' };
      });
      const { whoami } = await import('../src/lib/bin-secret');
      const result = await whoami();
      expect(result.ok).toBe(true);
      expect(result.data).toEqual({ backend: 'supabase', anon_key_id: 'eyJabcde…' });
    });

    it('list returns projected metadata items (no .items wrapper)', async () => {
      mock.setDefault((call) => {
        if (call.command.endsWith('bin/secret') && call.args[0] === 'list') {
          return {
            code: 0,
            stdout: JSON.stringify({
              items: [{ id: 'x', mtime: '2026-07-06T00:00:00Z', kind: 'note' }],
            }),
          };
        }
        return { code: 0, stdout: '{}' };
      });
      const { list } = await import('../src/lib/bin-secret');
      const result = await list();
      expect(result.ok).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(result.data?.[0]?.id).toBe('x');
      expect(result.data?.[0]?.mtime).toBe('2026-07-06T00:00:00Z');
    });

    it('non-zero exit + empty stdout returns vault_unreachable (no throw, no 500)', async () => {
      mock.setDefault(() => ({ code: 4, stdout: '', stderr: 'ERROR: not initialized' }));
      const { whoami } = await import('../src/lib/bin-secret');
      const result = await whoami();
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('vault_unreachable');
      expect(result.data).toBeNull();
    });
  });

  describe('/vault list + search (Issue #5)', () => {
    /**
     * Helper: log in once and grab the cookie jar + csrf token for a follow-up
     * GET /vault. Most /vault tests are read-only and don't need CSRF.
     */
    async function login(): Promise<string> {
      const loginRes = await loginAndGetCookies(app, 'admin', 'correct-horse-battery-staple');
      return setCookieFromResponse(loginRes);
    }

    it('redirects unauthenticated GET /vault to /login', async () => {
      const res = await request(app.server).get('/vault').redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/login');
    });

    it('renders a table of secrets for an authenticated user', async () => {
      mock.whenMatch(
        (call) => call.command.endsWith('bin/secret') && call.args[0] === 'list',
        () => ({
          code: 0,
          stdout: JSON.stringify({
            items: [
              { id: 'alpha', name: 'Alpha note', mtime: '2026-07-05T00:00:00Z', kind: 'note', tags: ['rotating'] },
              { id: 'beta', name: 'Beta note', mtime: '2026-07-06T00:00:00Z', kind: 'note' },
            ],
          }),
        }),
      );
      const cookie = await login();
      const res = await request(app.server).get('/vault').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.text).toContain('alpha');
      expect(res.text).toContain('beta');
      expect(res.text).toContain('<table');
      expect(res.text).toContain('/vault/alpha');
    });

    it('filters by ?q= against id, name, kind, sha, tags (case-insensitive substring)', async () => {
      mock.whenMatch(
        (call) => call.command.endsWith('bin/secret') && call.args[0] === 'list',
        () => ({
          code: 0,
          stdout: JSON.stringify({
            items: [
              { id: 'alpha-secret', name: 'Production DB', kind: 'note', tags: ['db', 'prod'] },
              { id: 'beta-secret', name: 'Sandbox', kind: 'note' },
              { id: 'gamma-token', name: 'CI token', kind: 'token', sha: 'deadbeefcafe' },
            ],
          }),
        }),
      );
      const cookie = await login();
      const resById = await request(app.server).get('/vault').query({ q: 'ALPHA' }).set('Cookie', cookie);
      expect(resById.text).toContain('alpha-secret');
      expect(resById.text).not.toContain('beta-secret');
      expect(resById.text).not.toContain('gamma-token');

      const resByTag = await request(app.server).get('/vault').query({ q: 'prod' }).set('Cookie', cookie);
      expect(resByTag.text).toContain('alpha-secret');
      expect(resByTag.text).not.toContain('beta-secret');

      const resBySha = await request(app.server).get('/vault').query({ q: 'CAFE' }).set('Cookie', cookie);
      expect(resBySha.text).toContain('gamma-token');
      expect(resBySha.text).not.toContain('alpha-secret');
    });

    it('NEVER exposes plaintext content in the /vault response body (fuzz)', async () => {
      const PLAINTEXTS = [
        'hunter2-supersecret-password',
        'sk-test-1234567890abcdef-fed-cannot-leak',
        '\u{1F47B}ghost-marker-emoji',
        '<script>alert(1)</script>',
        'AKIA9999999999999999',
        'sqlite3-url-with-creds',
      ];
      mock.whenMatch(
        (call) => call.command.endsWith('bin/secret') && call.args[0] === 'list',
        () => ({
          code: 0,
          // Worst-case upstream response: includes plaintext `content` /
          // `plaintext` / `secret` fields that MUST be stripped.
          stdout: JSON.stringify({
            items: PLAINTEXTS.map((value, i) => ({
              id: `n${i}`,
              content: value,
              plaintext: value,
              secret: value,
              value,
              body: value,
              mtime: '2026-07-06T00:00:00Z',
              kind: 'note',
            })),
          }),
        }),
      );
      const cookie = await login();
      const res = await request(app.server).get('/vault').set('Cookie', cookie);
      expect(res.status).toBe(200);
      for (const value of PLAINTEXTS) {
        expect(res.text).not.toContain(value);
      }
    });

    it('NEVER exposes plaintext in GET /vault/:id either (fuzz)', async () => {
      const PLAINTEXTS = [
        'top-secret-content-xyz',
        '\n<script>steal()</script>',
        'BEGIN PRIVATE KEY abcdef',
      ];
      mock.whenMatch(
        (call) => call.command.endsWith('bin/secret') && call.args[0] === 'get' && call.args[1] === 'alpha',
        () => ({
          code: 0,
          stdout: JSON.stringify({
            id: 'alpha',
            name: 'Alpha',
            content: PLAINTEXTS[0],
            plaintext: PLAINTEXTS[1],
            secret: PLAINTEXTS[2],
            value: PLAINTEXTS[0],
            mtime: '2026-07-06T00:00:00Z',
          }),
        }),
      );
      const cookie = await login();
      const res = await request(app.server).get('/vault/alpha').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.text).toContain('alpha');
      for (const value of PLAINTEXTS) {
        expect(res.text).not.toContain(value);
      }
    });

    it('GET /vault/:id rejects ids containing shell metacharacters', async () => {
      const cookie = await login();
      // /vault/:id matches a single segment; URLs with embedded '/' go to a
      // different route and return 404 from Fastify's matcher (separate case).
      // For this test we restrict to single-segment paths that decoders are
      // allowed to send but our validator rejects.
      const cases = [
        '/vault/%20', // whitespace-only id
        // (Fastify's default maxParamLength is 100, so we can't test a
        // 128-char-overflow at the URL layer without bumping it server-side;
        // the validator's length check is unit-tested separately.)
        '/vault/dollar$sign', // $ rejected by [A-Za-z0-9._-]
        '/vault/abc`rm', // backtick rejected (shell metachar; supertest
        //   forwards it through to Fastify's path parser).
        '/vault/bang!hash', // ! rejected
      ];
      for (const path of cases) {
        const res = await request(app.server).get(path).set('Cookie', cookie);
        expect(res.status).toBe(200);
        // Either "not found" (id failed validation) or "invalid" id.
        expect(res.text).toMatch(/not found|invalid id/);
      }
    });

    it('GET /vault/:id surfaces "vault unreachable" not 500 when bin/secret fails', async () => {
      mock.whenMatch(
        (call) => call.command.endsWith('bin/secret') && call.args[0] === 'get',
        () => ({ code: 7, stdout: '', stderr: 'ERROR: not initialised' }),
      );
      mock.whenMatch(
        (call) => call.command.endsWith('bin/secret') && call.args[0] === 'whoami',
        () => ({ code: 0, stdout: '{"backend":"supabase","region":"ap-southeast-1"}' }),
      );
      const cookie = await login();
      const res = await request(app.server).get('/vault/alpha').set('Cookie', cookie);
      expect(res.status).toBe(200);
      // Should NOT 500; should render the "vault unreachable" badge.
      expect(res.text).toContain('vault unreachable');
      expect(res.text).toContain('Could not fetch this secret');
    });

    it('GET /vault itself surfaces "vault unreachable" not 500 when bin/secret list fails', async () => {
      mock.whenMatch(
        (call) => call.command.endsWith('bin/secret') && call.args[0] === 'list',
        () => ({ code: 9, stdout: '', stderr: 'ERROR: vault unreachable' }),
      );
      const cookie = await login();
      const res = await request(app.server).get('/vault').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.text).toContain('vault unreachable');
    });

    it('GET /vault shows empty-state hint when list returns []', async () => {
      mock.whenMatch(
        (call) => call.command.endsWith('bin/secret') && call.args[0] === 'list',
        () => ({ code: 0, stdout: JSON.stringify({ items: [] }) }),
      );
      const cookie = await login();
      const res = await request(app.server).get('/vault').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.text).toContain('No secrets');
    });
  });

  describe('/vault/init form + audit log (Issue #6)', () => {
    /**
     * Issue #6 — the form is mutating and should be CSRF-protected. We need a
     * helper to fetch the CSRF token from the GET /vault/init page, then
     * submit POST /vault/init with the token in the body.
     */
    async function openInitFormAndCsrf(cookie: string): Promise<string> {
      const res = await request(app.server).get('/vault/init').set('Cookie', cookie);
      const match = /name="_csrf"\s+value="([^"]+)"/.exec(res.text);
      if (!match) throw new Error('csrf token not found on /vault/init');
      return match[1] ?? '';
    }

    it('redirects unauthenticated GET /vault/init to /login', async () => {
      const res = await request(app.server).get('/vault/init').redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/login');
    });

    it('renders the init form for an authenticated user (with CSRF token)', async () => {
      mock.setDefault(() => ({ code: 0, stdout: '{}' }));
      const cookie = (await loginAndGetCookies(app, 'admin', 'correct-horse-battery-staple').then(setCookieFromResponse));
      const res = await request(app.server).get('/vault/init').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.text).toContain('name="url"');
      expect(res.text).toContain('name="apiKey"');
      expect(res.text).toContain('name="confirm"');
      expect(res.text).toMatch(/name="_csrf"\s+value="[^"]+"/);
    });

    it('POST /vault/init WITHOUT csrf token returns 403', async () => {
      const cookie = (await loginAndGetCookies(app, 'admin', 'correct-horse-battery-staple').then(setCookieFromResponse));
      const res = await request(app.server)
        .post('/vault/init')
        .type('form')
        .set('Cookie', cookie)
        .send({
          url: 'https://abcdefghijkl.supabase.co',
          apiKey: 'a'.repeat(20),
          confirm: 'on',
        });
      expect(res.status).toBe(403);
      expect(res.text.toLowerCase()).toContain('csrf');
    });

    it('POST /vault/init happy path: invokes bin/secret with --api-key-file and writes audit', async () => {
      // Capture bin/secret invocation args.
      let capturedInitCall: { args: string[]; env: NodeJS.ProcessEnv } | null = null;

      mock.whenMatch(
        (call) => call.command.endsWith('bin/secret') && call.args[0] === 'init',
        (call) => {
          capturedInitCall = { args: [...call.args], env: { ...call.env } };
          // Real bin/secret slurps the file; the harness can't see the file
          // because the route writes it via fs.promises inside the temp dir.
          // We just confirm the flag shape from spawn args.
          return {
            code: 0,
            stdout: JSON.stringify({ ok: true, url: 'https://abcdefghijkl.supabase.co' }),
          };
        },
      );

      // Read the audit log after submission to confirm shape.
      const cookie = (await loginAndGetCookies(app, 'admin', 'correct-horse-battery-staple').then(setCookieFromResponse));
      const csrf = await openInitFormAndCsrf(cookie);
      const apiKey = 'a'.repeat(40);
      const res = await request(app.server)
        .post('/vault/init')
        .type('form')
        .set('Cookie', cookie)
        .send({
          _csrf: csrf,
          url: 'https://abcdefghijkl.supabase.co',
          apiKey,
          confirm: 'on',
        });
      expect(res.status).toBe(303);
      expect(res.headers.location).toBe('/vault/init?flash=ok');

      // Args shape — must include --url and --api-key-file; the API key
      // MUST NOT appear as a literal in the args (Risk #4).
      expect(capturedInitCall).not.toBeNull();
      const args = capturedInitCall!.args;
      expect(args[0]).toBe('init');
      expect(args).toContain('--url');
      expect(args[args.indexOf('--url') + 1]).toBe('https://abcdefghijkl.supabase.co');
      expect(args).toContain('--api-key-file');
      const keyFilePath = args[args.indexOf('--api-key-file') + 1];
      expect(keyFilePath).toMatch(/runtime\/tmp\/.*\/key$/);
      // The apiKey body MUST NOT have ended up as an arg token.
      expect(args.join('\n')).not.toContain(apiKey);
      expect(args.join('\n')).not.toContain('a'.repeat(8));

      // Audit log entry.
      const auditPath = process.env.AUTH_AUDIT_LOG as string;
      const auditText = await readFile(auditPath, 'utf8');
      // Last line is the vault.init entry.
      const lines = auditText.split('\n').filter(Boolean);
      const lastLine = lines[lines.length - 1] ?? '';
      const parsed = JSON.parse(lastLine) as Record<string, unknown>;
      expect(parsed.action).toBe('vault.init');
      expect(parsed.user).toBe('admin');
      expect(parsed.vault).toBe('skill-secret');
      expect(typeof parsed.urlHash).toBe('string');
      expect((parsed.urlHash as string)).toHaveLength(12);
      expect(parsed.outcome).toBe('success');
      // No apiKey bytes in the audit line.
      expect(lastLine).not.toContain(apiKey);
      expect(lastLine).not.toContain('a'.repeat(8));

      // Temp file is gone.
      const { stat } = await import('node:fs/promises');
      await expect(stat(keyFilePath)).rejects.toThrow();

      // Persisted state assertion: apiKey not echoed in the response.
      // The redirect body is empty (303), but if anything was logged via
      // pino we want to assert no leak. Vitest captures pino via the
      // LOG_LEVEL=silent test env.
    });

    it('POST /vault/init still cleans up temp file when bin/secret fails', async () => {
      let observedArgs: string[] | null = null;
      mock.whenMatch(
        (call) => call.command.endsWith('bin/secret') && call.args[0] === 'init',
        (call) => {
          observedArgs = [...call.args];
          return { code: 9, stdout: '{"ok":false,"reason":"invalid_key"}', stderr: 'ERROR: invalid api key' };
        },
      );
      const cookie = (await loginAndGetCookies(app, 'admin', 'correct-horse-battery-staple').then(setCookieFromResponse));
      const csrf = await openInitFormAndCsrf(cookie);
      const res = await request(app.server)
        .post('/vault/init')
        .type('form')
        .set('Cookie', cookie)
        .send({
          _csrf: csrf,
          url: 'https://abcdefghijkl.supabase.co',
          apiKey: 'b'.repeat(40),
          confirm: 'on',
        });
      expect(res.status).toBe(502);
      expect(res.text).toContain('Vault init failed');
      expect(observedArgs).not.toBeNull();
      const keyFilePath = observedArgs![observedArgs!.indexOf('--api-key-file') + 1];
      const { stat } = await import('node:fs/promises');
      await expect(stat(keyFilePath)).rejects.toThrow();

      // Audit log records the failure.
      const auditPath = process.env.AUTH_AUDIT_LOG as string;
      const text = await readFile(auditPath, 'utf8');
      const last = (text.split('\n').filter(Boolean).pop() ?? '');
      const parsed = JSON.parse(last) as Record<string, unknown>;
      expect(parsed.action).toBe('vault.init');
      expect(parsed.outcome).toBe('failure');
      expect(parsed.detail).toBe('non_zero_exit');
      expect(last).not.toContain('b'.repeat(40));
    });

    it('rejects invalid URLs and apiKey bodies without invoking bin/secret', async () => {
      let binSecretCalled = false;
      mock.whenMatch(
        (call) => call.command.endsWith('bin/secret') && call.args[0] === 'init',
        () => {
          binSecretCalled = true;
          return { code: 0, stdout: '{}' };
        },
      );
      const cookie = (await loginAndGetCookies(app, 'admin', 'correct-horse-battery-staple').then(setCookieFromResponse));
      const csrf = await openInitFormAndCsrf(cookie);

      const cases = [
        { body: { _csrf: csrf, url: 'http://insecure.example.com', apiKey: 'a'.repeat(40), confirm: 'on' }, label: 'http not https' },
        { body: { _csrf: csrf, url: 'https://evil.example.com', apiKey: 'a'.repeat(40), confirm: 'on' }, label: 'non-supabase host' },
        { body: { _csrf: csrf, url: 'https://abc.supabase.co', apiKey: 'short', confirm: 'on' }, label: 'too-short api key' },
        { body: { _csrf: csrf, url: 'https://abc.supabase.co', apiKey: '', confirm: 'on' }, label: 'empty api key' },
        { body: { _csrf: csrf, url: 'https://abc.supabase.co', apiKey: 'a'.repeat(40), confirm: '' }, label: 'no confirm' },
      ];
      for (const c of cases) {
        const res = await request(app.server)
          .post('/vault/init')
          .type('form')
          .set('Cookie', cookie)
          .send(c.body);
        expect(res.status).toBe(400);
        expect(res.text).toContain('Vault init failed');
      }
      expect(binSecretCalled).toBe(false);
    });
  });
});
