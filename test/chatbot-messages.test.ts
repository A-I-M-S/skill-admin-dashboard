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

const isListMessagesCall = (phone: string) =>
  (call: { args: string[] }): boolean =>
    call.args[0] === 'list-messages' && call.args[1] === phone;

describe('Chatbot per-phone messages (Issue #14)', () => {
  let app: FastifyInstance;
  let mock: MockSubprocessHandle;
  const tmpRoot = mkdtempSync(join(RUNTIME_ROOT, `chatbot-msg-${randomUUID()}-`));
  let fakeBin: string;

  beforeAll(async () => {
    process.env.AUTH_AUDIT_LOG = join(tmpRoot, 'audit.log');
    fakeBin = join(tmpRoot, 'chatbot-admin');
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

  it('redirects unauthenticated GET /chatbot/conversations/:phone to /login', async () => {
    const res = await request(app.server)
      .get('/chatbot/conversations/+6591234567')
      .redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('GET /chatbot/conversations/:phone renders the last-50 list', async () => {
    const phone = '+6591234567';
    let observedArgs: string[] | null = null;
    mock.whenMatch(
      (call) => isChatbotAdminCall(call) && isListMessagesCall(phone)(call),
      (call) => {
        observedArgs = [...call.args];
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            phone,
            messages: [
              {
                message_id: 'm1',
                direction: 'inbound',
                text: 'hello',
                timestamp: '2026-07-06T15:30:00Z',
                tool: 'faq',
                flow_at_send: 'idle',
                is_fallback: false,
                is_admin: false,
              },
              {
                message_id: 'm2',
                direction: 'outbound',
                text: 'Got the photo.',
                timestamp: '2026-07-06T15:30:01Z',
                tool: 'image_ack',
                flow_at_send: 'idle',
                is_fallback: false,
                is_admin: false,
              },
              {
                message_id: 'm3',
                direction: 'admin_send',
                text: 'human follow-up',
                timestamp: '2026-07-06T15:31:00Z',
                tool: 'admin_send',
                flow_at_send: 'admin_send',
                is_fallback: false,
                is_admin: true,
              },
            ],
            count: 3,
          }),
          stderr: '',
        };
      },
    );
    const cookie = await login();
    const res = await request(app.server)
      .get(`/chatbot/conversations/${encodeURIComponent(phone)}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('hello');
    expect(res.text).toContain('Got the photo.');
    expect(res.text).toContain('human follow-up');
    expect(res.text).toContain('dir-inbound');
    expect(res.text).toContain('dir-outbound');
    expect(res.text).toContain('dir-admin_send');
    expect(res.text).toContain('msg:m1');
    // The wrapper was invoked with --limit 50 and --include-admin 1.
    expect(observedArgs).not.toBeNull();
    expect(observedArgs).toContain('--limit');
    expect(observedArgs![observedArgs!.indexOf('--limit') + 1]).toBe('50');
    expect(observedArgs).toContain('--include-admin');
  });

  it('GET /chatbot/conversations/:phone 400s on invalid phones', async () => {
    const cookie = await login();
    const res = await request(app.server)
      .get('/chatbot/conversations/not-a-phone')
      .set('Cookie', cookie);
    expect(res.status).toBe(400);
    expect(res.text).toContain('Invalid phone number');
  });

  it('GET /chatbot/conversations/:phone returns 503 when wrapper is missing', async () => {
    const saved = process.env.CHATBOT_ADMIN_BIN;
    delete process.env.CHATBOT_ADMIN_BIN;
    rmSync(fakeBin, { force: true });
    try {
      const cookie = await login();
      const res = await request(app.server)
        .get('/chatbot/conversations/+6591234567')
        .set('Cookie', cookie);
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('60');
      expect(res.text).toContain('wrapper not installed');
    } finally {
      writeFileSync(fakeBin, '#!/bin/sh\n');
      process.env.CHATBOT_ADMIN_BIN = saved ?? fakeBin;
    }
  });

  it('GET /chatbot/conversations/:phone 404s when upstream returns phone_not_found', async () => {
    const phone = '+6599999999';
    mock.whenMatch(
      (call) => isChatbotAdminCall(call) && isListMessagesCall(phone)(call),
      () => ({
        code: 5,
        stdout: JSON.stringify({ ok: false, error: 'phone_not_found', code: 5 }),
        stderr: '',
      }),
    );
    const cookie = await login();
    const res = await request(app.server)
      .get(`/chatbot/conversations/${encodeURIComponent(phone)}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(404);
  });

  it('GET /chatbot/conversations/:phone renders empty-state when wrapper returns []', async () => {
    const phone = '+6590000000';
    mock.whenMatch(
      (call) => isChatbotAdminCall(call) && isListMessagesCall(phone)(call),
      () => ({ code: 0, stdout: JSON.stringify({ ok: true, phone, messages: [] }), stderr: '' }),
    );
    const cookie = await login();
    const res = await request(app.server)
      .get(`/chatbot/conversations/${encodeURIComponent(phone)}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('No messages found');
  });
});