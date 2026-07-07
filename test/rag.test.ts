import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
mkdirSync(RUNTIME_ROOT, { recursive: true });
const TEST_TMP_ROOT = mkdtempSync(join(RUNTIME_ROOT, `rag-test-${randomUUID()}-`));

describe('RAG collection stats + source-file listing (Issue #7)', () => {
  let app: FastifyInstance;
  let mock: MockSubprocessHandle;

  beforeAll(async () => {
    const workdir = mkdtempSync(join(TEST_TMP_ROOT, 'case-'));
    process.env.AUTH_AUDIT_LOG = join(workdir, 'audit.log');
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(TEST_TMP_ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    mock = mockSubprocess();
    mock.install();
  });

  afterEach(() => {
    mock.restore();
  });

  it('redirects unauthenticated GET /rag to /login', async () => {
    const res = await request(app.server).get('/rag').redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('returns 200 with stats + source listing when bin/rag responds ok', async () => {
    mock.whenMatch(
      (call) => call.command.endsWith('bin/rag') && call.args[0] === 'stats',
      () => ({
        code: 0,
        stdout: JSON.stringify({
          points: 1234,
          dims: 384,
          collection: 'farm-docs',
          status: 'green',
          last_ingest_at: '2026-07-05T18:31:02Z',
        }),
      }),
    );
    mock.whenMatch(
      (call) => call.command.endsWith('bin/rag') && call.args[0] === 'list-sources',
      () => ({
        code: 0,
        stdout: JSON.stringify([
          { filename: 'farm-tour-rules.md', size: 12031, ingested_at: '2026-07-04T10:00:00Z' },
          { filename: 'rotational-grazing.pdf', size: 842100, ingested_at: '2026-07-05T18:31:02Z' },
        ]),
      }),
    );
    const cookie = (
      await request(app.server)
        .post('/login')
        .type('form')
        .send({ username: 'admin', password: 'correct-horse-battery-staple' })
        .then((res) => {
          const sc = res.headers['set-cookie'];
          const arr = Array.isArray(sc) ? sc : [sc];
          return arr
            .map((c: unknown) => (Array.isArray(c) ? c.join('; ') : c))
            .filter((c: unknown) => typeof c === 'string' && c.startsWith('sad.sid='))
            .join('; ');
        })
    );
    const res = await request(app.server).get('/rag').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('farm-docs');
    expect(res.text).toContain('1,234'); // points formatted with locale
    expect(res.text).toContain('384'); // dims
    expect(res.text).toContain('farm-tour-rules.md');
    expect(res.text).toContain('rotational-grazing.pdf');
    expect(res.text).not.toContain('farm tour rules'); // no plaintext content
  });

  it('returns 503 with rag_unavailable state when bin/rag sibling project is missing', async () => {
    // The bin/rag shim exits 7 with empty stdout + stderr 'rag_unavailable'
    // when the sibling project is absent.
    mock.whenMatch(
      (call) => call.command.endsWith('bin/rag') && call.args[0] === 'stats',
      () => ({ code: 7, stdout: '', stderr: 'rag_unavailable: sibling project not found' }),
    );
    mock.whenMatch(
      (call) => call.command.endsWith('bin/rag') && call.args[0] === 'list-sources',
      () => ({ code: 7, stdout: '', stderr: 'rag_unavailable: sibling project not found' }),
    );
    const cookie = (
      await request(app.server)
        .post('/login')
        .type('form')
        .send({ username: 'admin', password: 'correct-horse-battery-staple' })
        .then((res) => {
          const sc = res.headers['set-cookie'];
          const arr = Array.isArray(sc) ? sc : [sc];
          return arr
            .map((c: unknown) => (Array.isArray(c) ? c.join('; ') : c))
            .filter((c: unknown) => typeof c === 'string' && c.startsWith('sad.sid='))
            .join('; ');
        })
    );
    const res = await request(app.server).get('/rag').set('Cookie', cookie);
    expect(res.status).toBe(503);
    expect(res.text).toContain('RAG unavailable');
    expect(res.text).toContain('SKILL_RAG_QDRANT_DIR');
    // Sibling project not present ⇒ /rag should also still be 200 (rendering
    // a flash card) since the dashboard stays up.
    expect(res.text).not.toContain('Internal Server Error');
  });

  it('NEVER exposes chunk text or file content in the /rag response (fuzz)', async () => {
    const FORBIDDEN = [
      'top-secret-rotational-content',
      'sensitive-fertilizer-application-rate',
      'AKIA9999999999999999', // AWS-ish key
    ];
    mock.whenMatch(
      (call) => call.command.endsWith('bin/rag') && call.args[0] === 'stats',
      () => ({ code: 0, stdout: JSON.stringify({ points: 5, dims: 384, collection: 'x' }) }),
    );
    mock.whenMatch(
      (call) => call.command.endsWith('bin/rag') && call.args[0] === 'list-sources',
      () => ({
        code: 0,
        stdout: JSON.stringify([
          {
            filename: 'doc.md',
            size: 100,
            ingested_at: '2026-07-05T00:00:00Z',
            // These MUST be stripped by projectSourceList():
            content: FORBIDDEN[0],
            chunk_text: FORBIDDEN[1],
            preview: FORBIDDEN[2],
            body: 'leaked body',
            payload: { apiKey: 'AKIA-leak' },
          },
        ]),
      }),
    );
    const cookie = (
      await request(app.server)
        .post('/login')
        .type('form')
        .send({ username: 'admin', password: 'correct-horse-battery-staple' })
        .then((res) => {
          const sc = res.headers['set-cookie'];
          const arr = Array.isArray(sc) ? sc : [sc];
          return arr
            .map((c: unknown) => (Array.isArray(c) ? c.join('; ') : c))
            .filter((c: unknown) => typeof c === 'string' && c.startsWith('sad.sid='))
            .join('; ');
        })
    );
    const res = await request(app.server).get('/rag').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('doc.md');
    for (const v of FORBIDDEN) {
      expect(res.text).not.toContain(v);
    }
    expect(res.text).not.toContain('leaked body');
  });
});
