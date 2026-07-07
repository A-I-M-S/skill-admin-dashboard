import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

    it('list returns structured items', async () => {
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
      expect(result.data?.items).toHaveLength(1);
      expect(result.data?.items[0]?.id).toBe('x');
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
});
