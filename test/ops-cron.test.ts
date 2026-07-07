import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { FastifyInstance } from 'fastify';

vi.mock('../src/lib/subprocess', async () => {
  const helper = await import('./helpers/mock-subprocess');
  const actual = await vi.importActual<typeof import('../src/lib/subprocess')>(
    '../src/lib/subprocess',
  );
  return { ...actual, runSubprocess: helper.mockRunSubprocess };
});

import { buildServer } from '../src/server';
import { mockSubprocess, type MockSubprocessHandle } from './helpers/mock-subprocess';

const RUNTIME_ROOT = join(process.cwd(), 'runtime', 'tmp');
mkdtempSync(join(RUNTIME_ROOT, `cron-test-${randomUUID()}-`));

const isCronCall = (call: { command: string }): boolean =>
  /(^|\/)cron$/.test(call.command);

describe('Cron list + pause + resume + run + remove (Issue #10)', () => {
  let app: FastifyInstance;
  let mock: MockSubprocessHandle;
  const tmpRoot = mkdtempSync(join(RUNTIME_ROOT, `cron-${randomUUID()}-`));

  beforeAll(async () => {
    process.env.AUTH_AUDIT_LOG = join(tmpRoot, 'audit.log');
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    mock = mockSubprocess();
    mock.install();
  });

  afterEach(() => {
    mock.restore();
  });

  async function login(): Promise<string> {
    const r = await request(app.server)
      .post('/login')
      .type('form')
      .send({ username: 'admin', password: 'correct-horse-battery-staple' });
    const sc = r.headers['set-cookie'];
    const arr = Array.isArray(sc) ? sc : [sc];
    return arr
      .map((c: unknown) => (Array.isArray(c) ? c.join('; ') : c))
      .filter((c: unknown) => typeof c === 'string' && c.startsWith('sad.sid='))
      .join('; ');
  }

  async function csrfFromPage(cookie: string, path: string): Promise<string> {
    const res = await request(app.server).get(path).set('Cookie', cookie);
    const m = /name="_csrf"\s+value="([^"]+)"/.exec(res.text);
    if (!m) throw new Error('csrf not found');
    return m[1] ?? '';
  }

  it('redirects unauthenticated GET /cron to /login', async () => {
    const res = await request(app.server).get('/cron').redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('GET /cron renders the table from a mocked cron list', async () => {
    mock.whenMatch(
      (call) => isCronCall(call) && call.args[0] === 'list',
      () => ({
        code: 0,
        stdout: JSON.stringify({
          jobs: [
            {
              id: 'rotate-logs',
              name: 'rotate logs nightly',
              schedule: '0 3 * * *',
              last_run_at: '2026-07-06T03:00:00Z',
              enabled: true,
            },
            {
              id: 'snapshot-qdrant',
              name: 'qdrant snapshot',
              schedule: '@hourly',
              last_run_at: '2026-07-06T10:00:00Z',
              enabled: false,
              paused: true,
            },
          ],
        }),
      }),
    );
    const cookie = await login();
    const res = await request(app.server).get('/cron').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('rotate-logs');
    expect(res.text).toContain('snapshot-qdrant');
    expect(res.text).toContain('0 3 * * *');
    expect(res.text).toContain('@hourly');
    expect(res.text).toContain('/cron/rotate-logs/pause');
    expect(res.text).toContain('/cron/snapshot-qdrant/resume');
    expect(res.text).toContain('/cron/rotate-logs/run');
    expect(res.text).toContain('/cron/rotate-logs/remove');
    const csrfCount = (res.text.match(/name="_csrf"\s+value="[^"]+"/g) ?? []).length;
    expect(csrfCount).toBeGreaterThanOrEqual(4);
  });

  it('GET /cron surfaces graceful cron-tool-unreachable when binary is missing', async () => {
    mock.whenMatch(
      (call) => isCronCall(call) && call.args[0] === 'list',
      () => ({ code: 9, stdout: '', stderr: 'ERROR: cron tool not installed' }),
    );
    const cookie = await login();
    const res = await request(app.server).get('/cron').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('cron tool unreachable');
    expect(res.text).not.toContain('Internal Server Error');
  });

  it.each([
    { action: 'pause' },
    { action: 'resume' },
    { action: 'run' },
    { action: 'remove' },
  ])('POST /cron/:id/$action calls cron CLI + writes audit + 303', async ({ action }) => {
    let observedArgs: string[] | null = null;
    mock.whenMatch(
      (call) => isCronCall(call) && call.args[0] === action,
      (call) => {
        observedArgs = [...call.args];
        return { code: 0, stdout: JSON.stringify({ ok: true, job_id: 'rotate-logs', action }) };
      },
    );
    const cookie = await login();
    const csrf = await csrfFromPage(cookie, '/cron');
    const res = await request(app.server)
      .post(`/cron/rotate-logs/${action}`)
      .type('form')
      .set('Cookie', cookie)
      .send({ _csrf: csrf });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/cron');
    expect(observedArgs).not.toBeNull();
    expect(observedArgs![0]).toBe(action);
    expect(observedArgs![1]).toBe('rotate-logs');
    expect(observedArgs).toContain('--json');

    const auditPath = process.env.AUTH_AUDIT_LOG as string;
    const text = await readFile(auditPath, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>;
    expect(last.action).toBe(`cron.${action}`);
    expect(last.user).toBe('admin');
    expect(last.jobId).toBe('rotate-logs');
    expect(last.outcome).toBe('success');
  });

  it('POST /cron/:id/pause 400s on invalid job ids with shell metachars', async () => {
    const cookie = await login();
    const csrf = await csrfFromPage(cookie, '/cron');
    const res = await request(app.server)
      .post('/cron/has%20space/pause')
      .type('form')
      .set('Cookie', cookie)
      .send({ _csrf: csrf });
    expect(res.status).toBe(400);
  });

  it('POST /cron/:id/pause without CSRF = 403', async () => {
    const cookie = await login();
    const res = await request(app.server)
      .post('/cron/rotate-logs/pause')
      .type('form')
      .set('Cookie', cookie)
      .send({});
    expect(res.status).toBe(403);
  });

  it('Cron action failure writes a failure audit entry', async () => {
    mock.whenMatch(
      (call) => isCronCall(call) && call.args[0] === 'pause',
      () => ({ code: 1, stdout: '{"ok":false,"reason":"already_paused"}', stderr: '' }),
    );
    const cookie = await login();
    const csrf = await csrfFromPage(cookie, '/cron');
    const res = await request(app.server)
      .post('/cron/rotate-logs/pause')
      .type('form')
      .set('Cookie', cookie)
      .send({ _csrf: csrf });
    expect(res.status).toBe(502);

    const auditPath = process.env.AUTH_AUDIT_LOG as string;
    const text = await readFile(auditPath, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>;
    expect(last.action).toBe('cron.pause');
    expect(last.outcome).toBe('failure');
    expect(last.jobId).toBe('rotate-logs');
  });
});
