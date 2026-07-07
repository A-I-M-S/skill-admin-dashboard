import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
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
import { hashPhoneForAudit } from '../src/lib/phone-hash';

const RUNTIME_ROOT = join(process.cwd(), 'runtime', 'tmp');

const isChatbotAdminCall = (call: { command: string; args: string[] }): boolean =>
  /chatbot-admin$/.test(call.command);

const isHandoffQueue = (call: { args: string[] }): boolean =>
  call.args[0] === 'handoff-queue';

const isAdminSend = (call: { args: string[] }): boolean =>
  call.args[0] === 'admin-send';

function readLastAuditLine(auditPath: string): Record<string, unknown> {
  const text = readFileSync(auditPath, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>;
}

describe('Chatbot handoff + send (Issue #15)', () => {
  let app: FastifyInstance;
  let mock: MockSubprocessHandle;
  const tmpRoot = mkdtempSync(join(RUNTIME_ROOT, `chatbot-hs-${randomUUID()}-`));
  const auditPath = join(tmpRoot, 'audit.log');
  let fakeBin: string;

  beforeAll(async () => {
    process.env.AUTH_AUDIT_LOG = auditPath;
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

  async function csrfFromPage(cookie: string, path: string): Promise<string> {
    const res = await request(app.server).get(path).set('Cookie', cookie);
    const m = /name="_csrf"\s+value="([^"]+)"/.exec(res.text);
    if (!m) throw new Error('csrf not found');
    return m[1] ?? '';
  }

  describe('GET /chatbot/handoff', () => {
    it('redirects unauthenticated GET to /login', async () => {
      const res = await request(app.server).get('/chatbot/handoff').redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/login');
    });

    it('renders the handoff queue from a mocked wrapper response', async () => {
      mock.whenMatch(
        (call) => isChatbotAdminCall(call) && isHandoffQueue(call),
        () => ({
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            queue: [
              {
                phone: '+6591234567',
                reason: 'complaint',
                summary: 'Customer reports overcharge on last tour.',
                since: '2026-07-06T15:00:00Z',
                is_fallback: false,
                last_message_at: '2026-07-06T15:25:00Z',
                language: 'en',
              },
            ],
            count: 1,
          }),
          stderr: '',
        }),
      );
      const cookie = await login();
      const res = await request(app.server).get('/chatbot/handoff').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.text).toContain('+6591234567');
      expect(res.text).toContain('complaint');
      expect(res.text).toContain('Customer reports overcharge');
      expect(res.text).toMatch(/\/chatbot\/conversations\/\+6591234567|\/chatbot\/conversations\/%2B6591234567/);
      expect(res.text).toMatch(/\/chatbot\/send\?to=\+6591234567|\/chatbot\/send\?to=%2B6591234567/);
    });

    it('returns 503 + Retry-After when wrapper is missing', async () => {
      const saved = process.env.CHATBOT_ADMIN_BIN;
      delete process.env.CHATBOT_ADMIN_BIN;
      rmSync(fakeBin, { force: true });
      try {
        const cookie = await login();
        const res = await request(app.server).get('/chatbot/handoff').set('Cookie', cookie);
        expect(res.status).toBe(503);
        expect(res.headers['retry-after']).toBe('60');
        expect(res.text).toContain('wrapper not installed');
      } finally {
        writeFileSync(fakeBin, '#!/bin/sh\n');
        process.env.CHATBOT_ADMIN_BIN = saved ?? fakeBin;
      }
    });

    it('renders an empty-state card when queue is []', async () => {
      mock.whenMatch(
        (call) => isChatbotAdminCall(call) && isHandoffQueue(call),
        () => ({ code: 0, stdout: JSON.stringify({ ok: true, queue: [] }), stderr: '' }),
      );
      const cookie = await login();
      const res = await request(app.server).get('/chatbot/handoff').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.text).toContain('No handoffs currently open');
    });
  });

  describe('GET /chatbot/send', () => {
    it('renders the form with a CSRF token', async () => {
      const cookie = await login();
      const res = await request(app.server).get('/chatbot/send').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.text).toContain('name="_csrf"');
      expect(res.text).toContain('name="phone"');
      expect(res.text).toContain('name="text"');
      expect(res.text).toContain('name="confirm"');
      expect(res.text).toContain('maxlength="4096"');
    });
  });

  describe('POST /chatbot/send', () => {
    it('403s without a CSRF token', async () => {
      const cookie = await login();
      const res = await request(app.server)
        .post('/chatbot/send')
        .type('form')
        .set('Cookie', cookie)
        .send({
          phone: '+6591234567',
          text: 'admin follow-up',
          confirm: '1',
        });
      expect(res.status).toBe(403);
    });

    it('400s when the confirm checkbox is unchecked', async () => {
      const cookie = await login();
      const csrf = await csrfFromPage(cookie, '/chatbot/send');
      const res = await request(app.server)
        .post('/chatbot/send')
        .type('form')
        .set('Cookie', cookie)
        .send({
          _csrf: csrf,
          phone: '+6591234567',
          text: 'admin follow-up',
          confirm: '',
        });
      expect(res.status).toBe(400);
      expect(res.text).toContain('confirm');
    });

    it('400s on an invalid phone', async () => {
      const cookie = await login();
      const csrf = await csrfFromPage(cookie, '/chatbot/send');
      const res = await request(app.server)
        .post('/chatbot/send')
        .type('form')
        .set('Cookie', cookie)
        .send({
          _csrf: csrf,
          phone: 'not-a-phone',
          text: 'admin follow-up',
          confirm: '1',
        });
      expect(res.status).toBe(400);
      expect(res.text).toContain('Phone number');
    });

    it('400s on an empty body', async () => {
      const cookie = await login();
      const csrf = await csrfFromPage(cookie, '/chatbot/send');
      const res = await request(app.server)
        .post('/chatbot/send')
        .type('form')
        .set('Cookie', cookie)
        .send({
          _csrf: csrf,
          phone: '+6591234567',
          text: '',
          confirm: '1',
        });
      expect(res.status).toBe(400);
      expect(res.text).toContain('Message body is required');
    });

    it('303s on success, calls admin-send, writes privacy-preserving audit', async () => {
      const phone = '+6591234567';
      const text = 'human follow-up — please call back after 6pm';
      let observedArgs: string[] | null = null;
      mock.whenMatch(
        (call) => isChatbotAdminCall(call) && isAdminSend(call),
        (call) => {
          observedArgs = [...call.args];
          return {
            code: 0,
            stdout: JSON.stringify({
              ok: true,
              phone,
              message_id: 'wa-msg-xyz',
              sent_at: '2026-07-07T07:00:00Z',
              actor: 'admin',
              audit_ref: 'state_log:42',
            }),
            stderr: '',
          };
        },
      );
      const cookie = await login();
      const csrf = await csrfFromPage(cookie, '/chatbot/send');
      const res = await request(app.server)
        .post('/chatbot/send')
        .type('form')
        .set('Cookie', cookie)
        .send({
          _csrf: csrf,
          phone,
          text,
          confirm: '1',
        });
      expect(res.status).toBe(303);
      expect(res.headers.location).toBe('/chatbot/send?ok=1');
      expect(observedArgs).not.toBeNull();
      // The text was passed via argv (Risk #5 mirror: no shell, no
      // echo). Phone comes first.
      expect(observedArgs![0]).toBe('admin-send');
      expect(observedArgs![1]).toBe(phone);
      expect(observedArgs).toContain('--text');
      expect(observedArgs).toContain('--actor');
      expect(observedArgs).toContain('--json');

      const last = readLastAuditLine(auditPath);
      expect(last.action).toBe('chatbot.send');
      expect(last.user).toBe('admin');
      expect(last.outcome).toBe('success');
      // PRIVACY: phone hash, never the raw phone.
      expect(last.phoneHash).toBe(hashPhoneForAudit(phone));
      expect(last.phoneHash).not.toContain(phone);
      expect(last.phoneHash).not.toContain('6591234567');
      expect(last.length).toBe(text.length);
      expect(last.detail).toContain('bridge_id=wa-msg-xyz');
      expect(last.detail).toContain('audit_ref=state_log:42');
    });

    it('forwards --reply-to when supplied', async () => {
      const phone = '+6591234567';
      const text = 'replying to your last message';
      let observedArgs: string[] | null = null;
      mock.whenMatch(
        (call) => isChatbotAdminCall(call) && isAdminSend(call),
        (call) => {
          observedArgs = [...call.args];
          return {
            code: 0,
            stdout: JSON.stringify({
              ok: true,
              phone,
              message_id: 'wa-msg-zzz',
              sent_at: '2026-07-07T07:00:00Z',
              actor: 'admin',
              audit_ref: 'state_log:43',
            }),
            stderr: '',
          };
        },
      );
      const cookie = await login();
      const csrf = await csrfFromPage(cookie, '/chatbot/send');
      const res = await request(app.server)
        .post('/chatbot/send')
        .type('form')
        .set('Cookie', cookie)
        .send({
          _csrf: csrf,
          phone,
          text,
          replyTo: 'm1',
          confirm: '1',
        });
      expect(res.status).toBe(303);
      expect(observedArgs).toContain('--reply-to');
      expect(observedArgs![observedArgs!.indexOf('--reply-to') + 1]).toBe('m1');
    });

    it('502s and audit-logs failure when the wrapper returns an error envelope', async () => {
      mock.whenMatch(
        (call) => isChatbotAdminCall(call) && isAdminSend(call),
        () => ({
          code: 3,
          stdout: JSON.stringify({ ok: false, error: 'bridge_unreachable', code: 3 }),
          stderr: '',
        }),
      );
      const cookie = await login();
      const csrf = await csrfFromPage(cookie, '/chatbot/send');
      const res = await request(app.server)
        .post('/chatbot/send')
        .type('form')
        .set('Cookie', cookie)
        .send({
          _csrf: csrf,
          phone: '+6591234567',
          text: 'admin follow-up',
          confirm: '1',
        });
      expect(res.status).toBe(502);
      const last = readLastAuditLine(auditPath);
      expect(last.action).toBe('chatbot.send');
      expect(last.outcome).toBe('failure');
      expect(last.phoneHash).toBe(hashPhoneForAudit('+6591234567'));
      expect(last.reason).toBe('bridge_unreachable');
    });

    it('503s + audit-logs failure when wrapper is missing', async () => {
      const saved = process.env.CHATBOT_ADMIN_BIN;
      delete process.env.CHATBOT_ADMIN_BIN;
      rmSync(fakeBin, { force: true });
      try {
        const cookie = await login();
        const csrf = await csrfFromPage(cookie, '/chatbot/send');
        const res = await request(app.server)
          .post('/chatbot/send')
          .type('form')
          .set('Cookie', cookie)
          .send({
            _csrf: csrf,
            phone: '+6591234567',
            text: 'admin follow-up',
            confirm: '1',
          });
        expect(res.status).toBe(503);
        expect(res.headers['retry-after']).toBe('60');
        const last = readLastAuditLine(auditPath);
        expect(last.action).toBe('chatbot.send');
        expect(last.outcome).toBe('failure');
        expect(last.phoneHash).toBe(hashPhoneForAudit('+6591234567'));
        expect(last.reason).toBe('wrapper_missing');
      } finally {
        writeFileSync(fakeBin, '#!/bin/sh\n');
        process.env.CHATBOT_ADMIN_BIN = saved ?? fakeBin;
      }
    });

    it('rejects bodies > 4096 chars (400)', async () => {
      const cookie = await login();
      const csrf = await csrfFromPage(cookie, '/chatbot/send');
      const huge = 'x'.repeat(4097);
      const res = await request(app.server)
        .post('/chatbot/send')
        .type('form')
        .set('Cookie', cookie)
        .send({
          _csrf: csrf,
          phone: '+6591234567',
          text: huge,
          confirm: '1',
        });
      expect(res.status).toBe(400);
      expect(res.text).toContain('4096');
    });

    it('audit hash is a deterministic 12-hex prefix of sha256(phone)', async () => {
      const phone = '+6599999999';
      const expected =
        createHash('sha256').update(phone, 'utf8').digest('hex').slice(0, 12);
      mock.whenMatch(
        (call) => isChatbotAdminCall(call) && isAdminSend(call),
        () => ({
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            phone,
            message_id: 'wa-msg-q',
            sent_at: '2026-07-07T07:00:00Z',
            actor: 'admin',
            audit_ref: 'state_log:99',
          }),
          stderr: '',
        }),
      );
      const cookie = await login();
      const csrf = await csrfFromPage(cookie, '/chatbot/send');
      const res = await request(app.server)
        .post('/chatbot/send')
        .type('form')
        .set('Cookie', cookie)
        .send({
          _csrf: csrf,
          phone,
          text: 'short message',
          confirm: '1',
        });
      expect(res.status).toBe(303);
      const last = readLastAuditLine(auditPath);
      expect(last.phoneHash).toBe(expected);
      expect(last.phoneHash).toMatch(/^[0-9a-f]{12}$/);
    });
  });
});