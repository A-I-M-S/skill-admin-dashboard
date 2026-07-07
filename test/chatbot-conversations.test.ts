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

const isChatbotAdminCall = (call: { command: string; args: string[] }): boolean =>
  /chatbot-admin$/.test(call.command);

describe('Chatbot conversations list (Issue #13)', () => {
  let app: FastifyInstance;
  let mock: MockSubprocessHandle;
  const tmpRoot = mkdtempSync(join(RUNTIME_ROOT, `chatbot-${randomUUID()}-`));
  let fakeBin: string;

  beforeAll(async () => {
    process.env.AUTH_AUDIT_LOG = join(tmpRoot, 'audit.log');
    fakeBin = join(tmpRoot, 'chatbot-admin');
    // `existsSync` check on the wrapper path must succeed for the
    // `isChatbotAdminAvailable` gate to pass. We don't actually exec it;
    // the subprocess mock intercepts `runSubprocess` calls.
    writeFileSync(fakeBin, '#!/bin/sh\n');
    process.env.CHATBOT_ADMIN_BIN = fakeBin;
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.CHATBOT_ADMIN_BIN;
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

  it('redirects unauthenticated GET /chatbot/conversations to /login', async () => {
    const res = await request(app.server).get('/chatbot/conversations').redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('GET /chatbot/conversations renders the table from a mocked wrapper response', async () => {
    mock.whenMatch(
      (call) => isChatbotAdminCall(call) && call.args[0] === 'list-conversations',
      () => ({
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          conversations: [
            {
              phone: '+6591234567',
              last_message_id: 'ABC123',
              last_message_at: '2026-07-06T15:30:00Z',
              flow: 'idle',
              language: 'en',
              message_count_24h: 12,
              handoff_open: false,
            },
            {
              phone: '+6597654321',
              last_message_id: 'DEF456',
              last_message_at: '2026-07-06T15:35:00Z',
              flow: 'handoff',
              language: 'en',
              message_count_24h: 4,
              handoff_open: true,
              handoff_reason: 'complaint',
              handoff_since: '2026-07-06T15:00:00Z',
            },
          ],
          count: 2,
        }),
      }),
    );
    const cookie = await login();
    const res = await request(app.server).get('/chatbot/conversations').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('+6591234567');
    expect(res.text).toContain('+6597654321');
    expect(res.text).toContain('ABC123');
    expect(res.text).toContain('complaint');
    expect(res.text).toMatch(/\/chatbot\/conversations\/\+6591234567|\/chatbot\/conversations\/%2B6591234567/);
  });

  it('GET /chatbot/conversations?phone=659 passes --phone-prefix to wrapper', async () => {
    let observedArgs: string[] | null = null;
    mock.whenMatch(
      (call) => isChatbotAdminCall(call) && call.args[0] === 'list-conversations',
      (call) => {
        observedArgs = [...call.args];
        return { code: 0, stdout: JSON.stringify({ ok: true, conversations: [] }), stderr: '' };
      },
    );
    const cookie = await login();
    const res = await request(app.server)
      .get('/chatbot/conversations')
      .query({ phone: '659' })
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(observedArgs).not.toBeNull();
    expect(observedArgs).toContain('--phone-prefix');
    const idx = observedArgs!.indexOf('--phone-prefix');
    expect(observedArgs![idx + 1]).toBe('659');
    expect(observedArgs).toContain('--json');
  });

  it('GET /chatbot/conversations?phone=65912&phone=<script> rejects malformed filter', async () => {
    const cookie = await login();
    const res = await request(app.server)
      .get('/chatbot/conversations')
      .query({ phone: '<script>' })
      .set('Cookie', cookie);
    // The route silently drops an invalid filter (no --phone-prefix) and
    // still renders a 200 with no rows. Crucially: no XSS, no error.
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<script>');
  });

  it('GET /chatbot/conversations returns 503 + Retry-After when wrapper is missing', async () => {
    // Save + clear the env so the wrapper is "missing".
    const saved = process.env.CHATBOT_ADMIN_BIN;
    delete process.env.CHATBOT_ADMIN_BIN;
    rmSync(fakeBin, { force: true });
    try {
      const cookie = await login();
      const res = await request(app.server)
        .get('/chatbot/conversations')
        .set('Cookie', cookie);
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('60');
      expect(res.text).toContain('wrapper not installed');
      expect(res.text).toContain('phase-4-chatbot-contract');
    } finally {
      writeFileSync(fakeBin, '#!/bin/sh\n');
      if (saved !== undefined) process.env.CHATBOT_ADMIN_BIN = saved;
      else process.env.CHATBOT_ADMIN_BIN = fakeBin;
    }
  });

  it('GET /chatbot/conversations renders an empty-state card when the wrapper returns []', async () => {
    mock.whenMatch(
      (call) => isChatbotAdminCall(call) && call.args[0] === 'list-conversations',
      () => ({ code: 0, stdout: JSON.stringify({ ok: true, conversations: [] }), stderr: '' }),
    );
    const cookie = await login();
    const res = await request(app.server).get('/chatbot/conversations').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('No conversations match');
  });

  it('GET /chatbot/conversations surfaces wrapper 4xx/5xx envelopes', async () => {
    mock.whenMatch(
      (call) => isChatbotAdminCall(call) && call.args[0] === 'list-conversations',
      () => ({
        code: 4,
        stdout: JSON.stringify({ ok: false, error: 'db_uninitialized', code: 4 }),
        stderr: '',
      }),
    );
    const cookie = await login();
    const res = await request(app.server).get('/chatbot/conversations').set('Cookie', cookie);
    expect(res.status).toBe(502);
    expect(res.text).toContain('invalid json'); // upstream code 4 → interpretUpstreamError → invalid_json
  });
});