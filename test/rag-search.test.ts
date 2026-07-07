import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { FastifyInstance } from 'fastify';

// Subprocess is mocked so production code calls the scripted fake.
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
mkdtempSync(join(RUNTIME_ROOT, `search-test-${randomUUID()}-`));

describe('RAG admin-only search (Issue #9)', () => {
  let app: FastifyInstance;
  let mock: MockSubprocessHandle;
  const tmpRoot = mkdtempSync(join(RUNTIME_ROOT, `search-${randomUUID()}-`));

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

  it('GET /rag/search shows the form', async () => {
    const cookie = await login();
    const res = await request(app.server).get('/rag/search').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/name="_csrf"\s+value="[^"]+"/);
    expect(res.text).toContain('name="question"');
  });

  it('POST /rag/search happy path: returns top-3 hits descending by score + audit', async () => {
    mock.whenMatch(
      (call) => call.command.endsWith('bin/rag') && call.args[0] === 'ask',
      () => ({
        code: 0,
        stdout: JSON.stringify({
          answer: 'It says hello world.',
          contexts: [
            { score: 0.91, text: 'first hit context', source: 'a.md', chunk_index: 0 },
            { score: 0.83, text: 'second hit context', source: 'b.md', chunk_index: 4 },
            { score: 0.50, text: 'third hit context', source: 'c.md', chunk_index: 1 },
            // 4th hit (low score) drops below topK=3.
            { score: 0.10, text: 'low-score hit', source: 'd.md', chunk_index: 9 },
            // Garbage hit (no score) MUST be dropped.
            { text: 'no score', source: 'bad.md' },
          ],
        }),
      }),
    );
    const cookie = await login();
    const csrf = await csrfFromPage(cookie, '/rag/search');
    const res = await request(app.server)
      .post('/rag/search')
      .type('form')
      .set('Cookie', cookie)
      .send({ _csrf: csrf, question: 'what does the doc say about the cat?' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('It says hello world.');
    expect(res.text).toContain('first hit context');
    // Hits should appear in descending order.
    const idx1 = res.text.indexOf('first hit context');
    const idx2 = res.text.indexOf('second hit context');
    const idx3 = res.text.indexOf('third hit context');
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
    // 4th hit (low-score) must NOT appear.
    expect(res.text).not.toContain('low-score hit');
    // Garbage hit (no score) must NOT appear.
    expect(res.text).not.toContain('bad.md');
    expect(res.text).not.toContain('no score');

    // Audit log entry.
    const auditPath = process.env.AUTH_AUDIT_LOG as string;
    const text = await readFile(auditPath, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>;
    expect(last.action).toBe('rag.search');
    expect(last.user).toBe('admin');
    expect(last.outcome).toBe('success');
    expect(last.topK).toBe(3);
    expect(typeof last.questionHash).toBe('string');
    expect((last.questionHash as string)).toHaveLength(12);
    // Question text MUST NOT appear in audit log (privacy).
    expect(text).not.toContain('what does the doc say about the cat?');
  });

  it('POST /rag/search returns 503 when rag is unavailable', async () => {
    mock.whenMatch(
      (call) => call.command.endsWith('bin/rag') && call.args[0] === 'ask',
      () => ({ code: 7, stdout: '', stderr: 'rag_unavailable: missing sibling' }),
    );
    const cookie = await login();
    const csrf = await csrfFromPage(cookie, '/rag/search');
    const res = await request(app.server)
      .post('/rag/search')
      .type('form')
      .set('Cookie', cookie)
      .send({ _csrf: csrf, question: 'any question goes here' });
    expect(res.status).toBe(503);
    expect(res.text).toContain('RAG unavailable');
    expect(res.text).toContain('SKILL_RAG_QDRANT_DIR');
  });

  it('POST /rag/search without CSRF = 403', async () => {
    const cookie = await login();
    const res = await request(app.server)
      .post('/rag/search')
      .type('form')
      .set('Cookie', cookie)
      .send({ question: 'no token' });
    expect(res.status).toBe(403);
  });

  it('POST /rag/search strips apiKey / payload fields from hit objects', async () => {
    mock.whenMatch(
      (call) => call.command.endsWith('bin/rag') && call.args[0] === 'ask',
      () => ({
        code: 0,
        stdout: JSON.stringify({
          answer: null,
          contexts: [
            {
              score: 0.81,
              text: 'leaked hit',
              source: 'safe.md',
              payload: { apiKey: 'AKIA-FATAL-LEAK' },
              vector: [1.0, 2.0, 3.0],
            },
          ],
        }),
      }),
    );
    const cookie = await login();
    const csrf = await csrfFromPage(cookie, '/rag/search');
    const res = await request(app.server)
      .post('/rag/search')
      .type('form')
      .set('Cookie', cookie)
      .send({ _csrf: csrf, question: 'private question' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('leaked hit');
    expect(res.text).not.toContain('AKIA-FATAL-LEAK');
    expect(res.text).not.toContain('vector');
  });

  it('POST /rag/search rejects empty / oversize questions', async () => {    const cookie = await login();
    const csrf = await csrfFromPage(cookie, '/rag/search');
    const res1 = await request(app.server)
      .post('/rag/search')
      .type('form')
      .set('Cookie', cookie)
      .send({ _csrf: csrf, question: '' });
    expect(res1.status).toBe(400);
    expect(res1.text).toContain('invalid input');

    const res2 = await request(app.server)
      .post('/rag/search')
      .type('form')
      .set('Cookie', cookie)
      .send({ _csrf: csrf, question: 'x'.repeat(1025) });
    expect(res2.status).toBe(400);
  });
});
