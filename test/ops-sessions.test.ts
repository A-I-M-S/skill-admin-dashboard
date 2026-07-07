import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const isSessionsListCall = (call: { command: string; args: string[] }): boolean =>
  /(^|\/)sessions_list$/.test(call.command) && call.args[0] === '--json';

describe('Sessions list (Issue #11)', () => {
  let app: FastifyInstance;
  let mock: MockSubprocessHandle;
  const tmpRoot = mkdtempSync(join(RUNTIME_ROOT, `sessions-${randomUUID()}-`));

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

  it('redirects unauthenticated GET /sessions to /login', async () => {
    const res = await request(app.server).get('/sessions').redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('GET /sessions renders the table from a mocked sessions_list response', async () => {
    const transcriptPath = join(tmpRoot, 'transcript-1.jsonl');
    writeFileSync(transcriptPath, '{}\n', { mode: 0o600 });
    mock.whenMatch(
      (call) => isSessionsListCall(call),
      () => ({
        code: 0,
        stdout: JSON.stringify({
          sessions: [
            {
              key: 'main-telegram-1',
              kind: 'agent',
              channel: 'telegram',
              last_message: 'hello',
              started_at: '2026-07-06T10:00:00Z',
              updated_at: '2026-07-06T11:00:00Z',
              session_file: transcriptPath,
            },
            {
              key: 'main-discord-1',
              kind: 'agent',
              channel: 'discord',
              lastMessage: 'fallback field shape',
              startedAt: '2026-07-06T09:00:00Z',
              lastMessageAt: '2026-07-06T09:30:00Z',
              transcript_path: '/nonexistent/path/foo.jsonl',
            },
          ],
        }),
      }),
    );
    const cookie = await login();
    const res = await request(app.server).get('/sessions').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('main-telegram-1');
    expect(res.text).toContain('main-discord-1');
    expect(res.text).toContain('telegram');
    expect(res.text).toContain('discord');
    expect(res.text).toContain('hello');
    expect(res.text).toContain('fallback field shape');
    expect(res.text).toContain(transcriptPath);
    expect(res.text).toContain('file://' + transcriptPath);
    expect(res.text).toContain('/nonexistent/path/foo.jsonl');
    expect(res.text).toContain('(file not on disk)');
  });

  it('GET /sessions surfaces graceful sessions_list-unreachable when binary is missing', async () => {
    mock.whenMatch(
      (call) => isSessionsListCall(call),
      () => ({ code: 9, stdout: '', stderr: 'ERROR: sessions_list not installed' }),
    );
    const cookie = await login();
    const res = await request(app.server).get('/sessions').set('Cookie', cookie);
    expect(res.status).toBe(503);
    expect(res.text).toContain('sessions_list unreachable');
    expect(res.text).not.toContain('Internal Server Error');
  });

  it('GET /sessions handles invalid JSON gracefully (502)', async () => {
    mock.whenMatch(
      (call) => isSessionsListCall(call),
      () => ({ code: 0, stdout: 'not-json-at-all', stderr: '' }),
    );
    const cookie = await login();
    const res = await request(app.server).get('/sessions').set('Cookie', cookie);
    expect(res.status).toBe(502);
    expect(res.text).toContain('invalid json');
  });

  it('GET /sessions renders an empty-state card when list is empty', async () => {
    mock.whenMatch(
      (call) => isSessionsListCall(call),
      () => ({ code: 0, stdout: JSON.stringify({ sessions: [] }), stderr: '' }),
    );
    const cookie = await login();
    const res = await request(app.server).get('/sessions').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('No sessions reported.');
  });
});