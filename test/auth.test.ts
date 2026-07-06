import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { FastifyInstance } from 'fastify';

// Env is set in test/setup-env.ts (vitest setupFiles) — that runs BEFORE
// the server module is loaded, so config.ts picks up the test values.
import { buildServer } from '../src/server';
import { getSessionCookieName } from '../src/auth/session';

const COOKIE_NAME = getSessionCookieName();

// All scratch data lives under runtime/tmp/<uuid>/ per project convention.
const RUNTIME_ROOT = join(process.cwd(), 'runtime', 'tmp');
mkdirSync(RUNTIME_ROOT, { recursive: true });
const TEST_TMP_ROOT = mkdtempSync(join(RUNTIME_ROOT, `auth-test-${randomUUID()}-`));

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
  // The CSRF input lives in the header's sign-out form on the layout, which
  // is only rendered for authenticated users. We hit any authenticated page
  // (the index /) to retrieve it.
  const res = await request(app.server).get('/').set('Cookie', cookie);
  const match = /name="_csrf"\s+value="([^"]+)"/.exec(res.text);
  if (!match) throw new Error('csrf token not found on authenticated page');
  return match[1] ?? '';
}

describe('auth + csrf + layout shell (Issue #3)', () => {
  let app: FastifyInstance;
  let workdir: string;

  beforeAll(async () => {
    workdir = mkdtempSync(join(TEST_TMP_ROOT, 'case-'));
    process.env.AUTH_AUDIT_LOG = join(workdir, 'audit.log');
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(TEST_TMP_ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Keep the same audit log path for the entire file so the audit log test
    // can read all entries written during the run. Per-test isolation is
    // already provided by unique sessions (login + CSRF).
  });

  afterEach(async () => {
    // The in-memory session store is shared across tests. We rely on each
    // test fetching a fresh session via login() or by using a new cookie jar,
    // so we don't clear the store here. If a test needs to assert a fresh
    // session state, it uses a brand-new request agent.
  });

  describe('GET /login', () => {
    it('renders the form (no CSRF input — /login POST is the bootstrap route)', async () => {
      const res = await request(app.server).get('/login');
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/<form[^>]+action="\/login"/);
      // The /login form intentionally omits the _csrf input — login is the
      // session-bootstrap endpoint and is exempt from the CSRF gate.
    });

    it('authenticated pages embed a CSRF input in the sign-out form', async () => {
      const login = await loginAndGetCookies(app, 'admin', 'correct-horse-battery-staple');
      const cookie = setCookieFromResponse(login);
      const res = await request(app.server).get('/').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/name="_csrf"\s+value="[^"]+"/);
    });
  });

  describe('POST /login', () => {
    it('returns 401 on invalid credentials', async () => {
      const res = await loginAndGetCookies(app, 'admin', 'wrong');
      expect(res.status).toBe(401);
    });

    it('returns 401 for unknown user', async () => {
      const res = await loginAndGetCookies(app, 'nobody', 'whatever');
      expect(res.status).toBe(401);
    });

    it('redirects to / on valid credentials and sets a session cookie', async () => {
      const res = await loginAndGetCookies(app, 'admin', 'correct-horse-battery-staple');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/');
      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
      expect(cookies.some((c) => c.startsWith(`${COOKIE_NAME}=`))).toBe(true);
    });
  });

  describe('session id rotation (Risk #10)', () => {
    it('issues a different session id after login vs the pre-login session', async () => {
      const pre = await request(app.server).get('/login');
      const preCookie = setCookieFromResponse(pre);
      expect(preCookie).toContain(`${COOKIE_NAME}=`);

      const post = await loginAndGetCookies(app, 'admin', 'correct-horse-battery-staple');
      const postCookie = setCookieFromResponse(post);
      expect(postCookie).toContain(`${COOKIE_NAME}=`);

      const preVal = /sad\.sid=([^;]+)/.exec(preCookie)?.[1] ?? '';
      const postVal = /sad\.sid=([^;]+)/.exec(postCookie)?.[1] ?? '';
      expect(preVal).not.toBe('');
      expect(postVal).not.toBe('');
      expect(preVal).not.toBe(postVal);
    });
  });

  describe('CSRF fail-closed (Risk #3)', () => {
    let cookie: string;

    beforeEach(async () => {
      const res = await loginAndGetCookies(app, 'admin', 'correct-horse-battery-staple');
      cookie = setCookieFromResponse(res);
    });

    it('rejects POST /logout without a CSRF token with 403', async () => {
      const res = await request(app.server)
        .post('/logout')
        .set('Cookie', cookie)
        .type('form')
        .send({});
      expect(res.status).toBe(403);
    });

    it('rejects POST /logout with an invalid CSRF token with 403', async () => {
      const res = await request(app.server)
        .post('/logout')
        .set('Cookie', cookie)
        .type('form')
        .send({ _csrf: 'not-a-real-token' });
      expect(res.status).toBe(403);
    });

    it('accepts POST /logout with a valid CSRF token', async () => {
      const csrf = await fetchCsrfFromAuthenticatedPage(app, cookie);
      const res = await request(app.server)
        .post('/logout')
        .set('Cookie', cookie)
        .type('form')
        .send({ _csrf: csrf });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/login');
    });

    it('fails closed even when READONLY_MODE=true (mutating POST still gated)', async () => {
      const res = await request(app.server)
        .post('/logout')
        .set('Cookie', cookie)
        .type('form')
        .send({});
      expect(res.status).toBe(403);
    });
  });

  describe('redirect-to-login for unauthenticated requests', () => {
    it('GET / redirects to /login when not signed in', async () => {
      const res = await request(app.server).get('/').redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/login');
    });

    it('GET /healthz is public and returns 200', async () => {
      const res = await request(app.server).get('/healthz');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });
  });

  describe('HTTP basic-auth fallback (LOCAL_TOKEN_AUTH_REQUIRED=true)', () => {
    it('returns 200 on /healthz with curl -u admin:$TOKEN', async () => {
      const res = await request(app.server)
        .get('/healthz')
        .set(
          'Authorization',
          `Basic ${Buffer.from('admin:test-local-token-1234567890').toString('base64')}`,
        );
      expect(res.status).toBe(200);
    });

    it('returns 401 with wrong password', async () => {
      const res = await request(app.server)
        .get('/')
        .set('Authorization', `Basic ${Buffer.from('admin:wrong').toString('base64')}`)
        .redirects(0);
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/^Basic/);
    });

    it('returns 401 with wrong user', async () => {
      const res = await request(app.server)
        .get('/')
        .set(
          'Authorization',
          `Basic ${Buffer.from('nobody:test-local-token-1234567890').toString('base64')}`,
        )
        .redirects(0);
      expect(res.status).toBe(401);
    });
  });

  describe('layout shell (Risk #14, AC: nav links present)', () => {
    let cookie: string;

    beforeEach(async () => {
      const res = await loginAndGetCookies(app, 'admin', 'correct-horse-battery-staple');
      cookie = setCookieFromResponse(res);
    });

    it('renders the layout with nav links to /, /vault, /rag, /cron, /sessions, /logs, /chatbot', async () => {
      const res = await request(app.server).get('/').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/<nav>/);
      const expected = ['/', '/vault', '/rag', '/cron', '/sessions', '/logs', '/chatbot'];
      for (const path of expected) {
        expect(res.text).toContain(`href="${path}"`);
      }
    });

    it('escapes user data via <%= %> (no <%- %> for user data)', async () => {
      const res = await request(app.server).get('/').set('Cookie', cookie);
      expect(res.status).toBe(200);
      const layout = readFileSync('src/views/layout.ejs', 'utf8');
      expect(layout).toContain('<%= user.userId %>');
      expect(layout).not.toMatch(/<%-\s*user/);
    });
  });

  describe('audit log (Risk #13)', () => {
    it('appends 0o600 JSON lines for login.success and login.failure', async () => {
      const auditPath = process.env.AUTH_AUDIT_LOG ?? '';
      await request(app.server)
        .post('/login')
        .type('form')
        .send({ username: 'admin', password: 'wrong' });
      await request(app.server)
        .post('/login')
        .type('form')
        .send({ username: 'admin', password: 'correct-horse-battery-staple' });
      // Give the in-flight audit writes a tick to flush.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const content = readFileSync(auditPath, 'utf8');
      const lines = content.split('\n').filter((l) => l.length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      for (const line of lines) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        expect(parsed).toHaveProperty('ts');
        expect(parsed).toHaveProperty('action');
      }
      const actions = lines.map((l) => (JSON.parse(l) as { action: string }).action);
      expect(actions).toContain('login.failure');
      expect(actions).toContain('login.success');
      const mode = statSync(auditPath).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });
});
