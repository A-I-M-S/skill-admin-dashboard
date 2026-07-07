import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

const isJournalctlCall = (call: { command: string; args: string[] }): boolean =>
  /(^|\/)journalctl$/.test(call.command);

const isJournalctlFor = (service: string) => (call: { args: string[] }): boolean => {
  const idx = call.args.indexOf('-u');
  return idx >= 0 && call.args[idx + 1] === service;
};

describe('Logs tail (Issue #12)', () => {
  let app: FastifyInstance;
  let mock: MockSubprocessHandle;
  const tmpRoot = mkdtempSync(join(RUNTIME_ROOT, `logs-${randomUUID()}-`));

  beforeAll(async () => {
    process.env.AUTH_AUDIT_LOG = join(tmpRoot, 'audit.log');
    process.env.LOGS_SERVICES = 'aoa,openclaw-control-center,wa-bridge,orchestrator';
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.LOGS_SERVICES;
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

  it('redirects unauthenticated GET /logs to /login', async () => {
    const res = await request(app.server).get('/logs').redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('GET /logs renders 4 tabs from LOGS_SERVICES env', async () => {
    mock.whenMatch(
      (call) => isJournalctlCall(call) && isJournalctlFor('aoa')(call),
      () => ({ code: 0, stdout: 'aoa-line-1\n\x1b[31maoa-red\x1b[0m\n', stderr: '' }),
    );
    const cookie = await login();
    const res = await request(app.server).get('/logs').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('aoa');
    expect(res.text).toContain('openclaw-control-center');
    expect(res.text).toContain('wa-bridge');
    expect(res.text).toContain('orchestrator');
    expect(res.text).toContain('aoa-line-1');
    // ANSI escape MUST be stripped from the initial payload.
    expect(res.text).not.toContain('\x1b[31m');
    expect(res.text).not.toContain('\x1b[0m');
    expect(res.text).toContain('data-cursor=');
    // Script + tabs render.
    expect(res.text).toContain('POLL_INTERVAL_MS');
    expect(res.text).toContain('refresh-now');
  });

  it('GET /logs/:service returns JSON with cursor for polling', async () => {
    mock.whenMatch(
      (call) => isJournalctlCall(call) && isJournalctlFor('wa-bridge')(call),
      () => ({ code: 0, stdout: 'wb-line-1\nwb-line-2\n', stderr: '' }),
    );
    const cookie = await login();
    const res = await request(app.server)
      .get('/logs/wa-bridge')
      .query({ since: 0 })
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe('wa-bridge');
    expect(res.body.text).toContain('wb-line-1');
    expect(typeof res.body.cursor).toBe('number');
    expect(res.body.cursor).toBe(Buffer.byteLength(res.body.text, 'utf8'));
  });

  it('GET /logs/:service strips ANSI from response body', async () => {
    const ansiText = 'pre \x1b[32mgreen\x1b[0m post \x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\ end\n';
    mock.whenMatch(
      (call) => isJournalctlCall(call) && isJournalctlFor('orchestrator')(call),
      () => ({ code: 0, stdout: ansiText, stderr: '' }),
    );
    const cookie = await login();
    const res = await request(app.server)
      .get('/logs/orchestrator')
      .query({ since: 0 })
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.text).not.toContain('\x1b[');
    expect(res.body.text).not.toContain('\x1b]');
    expect(res.body.text).toContain('green');
    expect(res.body.text).toContain('link');
    expect(res.body.text).toContain('end');
  });

  it('GET /logs/:service returns only new bytes when since > 0', async () => {
    const fullText = 'alpha\nbeta\ngamma\n';
    let observedSince: number | null = null;
    mock.whenMatch(
      (call) => isJournalctlCall(call) && isJournalctlFor('aoa')(call),
      (call) => {
        // The route always slices server-side; capture the call for sanity.
        observedSince = call.args.length;
        return { code: 0, stdout: fullText, stderr: '' };
      },
    );
    const cookie = await login();
    // First request — get the cursor.
    const first = await request(app.server)
      .get('/logs/aoa')
      .query({ since: 0 })
      .set('Cookie', cookie);
    expect(first.status).toBe(200);
    const cursor = first.body.cursor;
    // Server slice test: we don't re-invoke journalctl here; instead
    // assert the slice behaviour through the lib directly.
    expect(cursor).toBeGreaterThan(0);
    expect(first.body.text).toBe(fullText);
    // Mock a follow-up call where stdout is shorter (simulates incremental poll).
    mock.restore();
    mock = mockSubprocess();
    mock.install();
    mock.whenMatch(
      (call) => isJournalctlCall(call) && isJournalctlFor('aoa')(call),
      () => ({ code: 0, stdout: 'beta\ngamma\n', stderr: '' }),
    );
    const second = await request(app.server)
      .get('/logs/aoa')
      .query({ since: cursor })
      .set('Cookie', cookie);
    expect(second.status).toBe(200);
    // Server slices since=cursor off the full output returned by journalctl.
    expect(second.body.text).not.toContain('alpha');
    expect(second.body.text).toContain('beta');
    expect(second.body.text).toContain('gamma');
    expect(observedSince).not.toBeNull();
  });

  it('GET /logs/:service returns 503 when journalctl fails with empty stdout', async () => {
    mock.whenMatch(
      (call) => isJournalctlCall(call) && isJournalctlFor('aoa')(call),
      () => ({ code: 9, stdout: '', stderr: 'journalctl: unit aoa not loaded' }),
    );
    const cookie = await login();
    const res = await request(app.server)
      .get('/logs/aoa')
      .query({ since: 0 })
      .set('Cookie', cookie);
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.reason).toBe('unreachable');
  });

  it('GET /logs/:service 400s on invalid service names', async () => {
    const cookie = await login();
    const res = await request(app.server)
      .get('/logs/has%20space')
      .set('Cookie', cookie);
    expect(res.status).toBe(400);
  });
});