import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

describe('RAG ingest forms (Issue #8)', () => {
  let app: FastifyInstance;
  let mock: MockSubprocessHandle;
  const ingestTmpRoot = mkdtempSync(
    join(RUNTIME_ROOT, `rag-ingest-test-${randomUUID()}-`),
  );

  beforeAll(async () => {
    process.env.AUTH_AUDIT_LOG = join(ingestTmpRoot, 'audit.log');
    process.env.IMPORT_MUTATION_ENABLED = 'true';
    vi.resetModules();
    const fresh = await import('../src/server');
    app = await fresh.buildServer();
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    delete process.env.IMPORT_MUTATION_ENABLED;
    rmSync(ingestTmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    mock = mockSubprocess();
    mock.install();
  });

  afterEach(() => {
    mock.restore();
  });

  async function login(app: FastifyInstance): Promise<string> {
    const r = await request(app.server).post('/login').type('form').send({
      username: 'admin',
      password: 'correct-horse-battery-staple',
    });
    const sc = r.headers['set-cookie'];
    const arr = Array.isArray(sc) ? sc : [sc];
    return arr
      .map((c: unknown) => (Array.isArray(c) ? c.join('; ') : c))
      .filter((c: unknown) => typeof c === 'string' && c.startsWith('sad.sid='))
      .join('; ');
  }

  async function csrfFromPage(app: FastifyInstance, cookie: string, path: string): Promise<string> {
    const res = await request(app.server).get(path).set('Cookie', cookie);
    const m = /name="_csrf"\s+value="([^"]+)"/.exec(res.text);
    if (!m) throw new Error('csrf not found');
    return m[1] ?? '';
  }

  it('GET /rag/ingest shows the form (CSRF + chunking defaults)', async () => {
    const cookie = await login(app);
    const res = await request(app.server).get('/rag/ingest').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/name="_csrf"\s+value="[^"]+"/);
    expect(res.text).toContain('name="file"');
    expect(res.text).toContain('name="text"');
    expect(res.text).toContain('800'); // default chunk size
    expect(res.text).toContain('200'); // default overlap
  });

  it('POST /rag/ingest (multipart) happy path: writes audit log + ingestFile called', async () => {
    let capturedArgs: string[] | null = null;
    mock.whenMatch(
      (call) =>
        call.command.endsWith('bin/rag') &&
        call.args[0] === 'ingest-file',
      (call) => {
        capturedArgs = [...call.args];
        return { code: 0, stdout: JSON.stringify({ chunks: 7, source: 'doc-2026-07-05' }) };
      },
    );

    const cookie = await login(app);
    const csrf = await csrfFromPage(app, cookie, '/rag/ingest');
    const res = await request(app.server)
      .post('/rag/ingest')
      .set('Cookie', cookie)
      .set('csrf-token', csrf)
      .field('source', 'doc-2026-07-05')
      .field('chunkSize', '600')
      .field('overlap', '150')
      .attach('file', Buffer.from('# hello\nworld'), { filename: 'doc.md', contentType: 'text/markdown' });

    expect(res.status).toBe(303);
    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs![0]).toBe('ingest-file');
    expect(capturedArgs!.join(' ')).toContain('--source');
    expect(capturedArgs!.join(' ')).toContain('--chunk-size');
    expect(capturedArgs!.join(' ')).toContain('--overlap');
    // Temp file unlinked: read the captured file path + stat.
    const fileArgIdx = capturedArgs!.indexOf('ingest-file') + 1;
    const filePath = capturedArgs![fileArgIdx];
    expect(filePath).toMatch(/runtime\/tmp\/ingest\/.+\.md$/);
    const { stat } = await import('node:fs/promises');
    await expect(stat(filePath)).rejects.toThrow();

    // Audit log entry.
    const auditPath = process.env.AUTH_AUDIT_LOG as string;
    const text = await readFile(auditPath, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>;
    expect(last.action).toBe('rag.ingest');
    expect(last.user).toBe('admin');
    expect(last.source).toBe('doc-2026-07-05');
    expect(last.chunks).toBe(7);
    expect(last.outcome).toBe('success');
    expect(last.detail).toContain('file:doc.md');
  });

  it('POST /rag/ingest rejects unsupported media type with 415', async () => {
    const cookie = await login(app);
    const csrf = await csrfFromPage(app, cookie, '/rag/ingest');
    const res = await request(app.server)
      .post('/rag/ingest')
      .set('Cookie', cookie)
      .set('csrf-token', csrf)
      .field('source', 's')
      .attach('file', Buffer.from('binary'), { filename: 'evil.exe', contentType: 'application/octet-stream' });
    expect(res.status).toBe(415);
    expect(res.text).toContain('unsupported media');
  });

  it('POST /rag/ingest rejects > 10 MiB with 413', async () => {
    const cookie = await login(app);
    const csrf = await csrfFromPage(app, cookie, '/rag/ingest');
    const big = Buffer.alloc(11 * 1024 * 1024, 0x61); // 11 MiB of 'a'
    const res = await request(app.server)
      .post('/rag/ingest')
      .set('Cookie', cookie)
      .set('csrf-token', csrf)
      .field('source', 'big')
      .attach('file', big, { filename: 'big.md', contentType: 'text/markdown' });
    // fastify-multipart rejects with 413 before our handler sees the body.
    expect([413, 400]).toContain(res.status);
  });

  it('POST /rag/ingest without CSRF = 403', async () => {
    const cookie = await login(app);
    const res = await request(app.server)
      .post('/rag/ingest')
      .set('Cookie', cookie)
      .field('source', 's')
      .attach('file', Buffer.from('x'), { filename: 'x.md' });
    expect(res.status).toBe(403);
  });

  it('POST /rag/ingest/text happy path', async () => {
    let capturedArgs: string[] | null = null;
    mock.whenMatch(
      (call) => call.command.endsWith('bin/rag') && call.args[0] === 'ingest-text',
      (call) => {
        capturedArgs = [...call.args];
        return { code: 0, stdout: JSON.stringify({ chunks: 3, source: 'manual-note' }) };
      },
    );
    const cookie = await login(app);
    const csrf = await csrfFromPage(app, cookie, '/rag/ingest');
    const res = await request(app.server)
      .post('/rag/ingest/text')
      .type('form')
      .set('Cookie', cookie)
      .send({ _csrf: csrf, source: 'manual-note', text: 'hello world from paste' });
    expect(res.status).toBe(303);
    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs![0]).toBe('ingest-text');
    expect(capturedArgs![1]).toBe('hello world from paste');
    expect(capturedArgs!.join(' ')).toContain('--source manual-note');

    // Audit log.
    const auditPath = process.env.AUTH_AUDIT_LOG as string;
    const lines = (await readFile(auditPath, 'utf8'))
      .split('\n')
      .filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>;
    expect(last.action).toBe('rag.ingest');
    expect(last.detail).toBe('text');
    expect(last.chunks).toBe(3);
    expect(last.outcome).toBe('success');
  });

  it('POST /rag/ingest/text rejects text > 1 MiB with 413', async () => {
    const cookie = await login(app);
    const csrf = await csrfFromPage(app, cookie, '/rag/ingest');
    const huge = 'a'.repeat(2 * 1024 * 1024); // 2 MiB
    const res = await request(app.server)
      .post('/rag/ingest/text')
      .type('form')
      .set('Cookie', cookie)
      .send({ _csrf: csrf, source: 'huge', text: huge });
    expect(res.status).toBe(413);
  });

  it('When IMPORT_MUTATION_ENABLED=false the POST routes 303 to /rag/ingest?flash=disabled', async () => {
    vi.resetModules();
    delete process.env.IMPORT_MUTATION_ENABLED;
    const fresh = await import('../src/server');
    const app2 = await fresh.buildServer();
    await app2.ready();
    const cookie = await login(app2 as unknown as FastifyInstance);
    const csrf = await csrfFromPage(app2 as unknown as FastifyInstance, cookie, '/rag/ingest');
    const res = await request(app2.server)
      .post('/rag/ingest/text')
      .type('form')
      .set('Cookie', cookie)
      .send({ _csrf: csrf, source: 's', text: 'hello' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toMatch(/flash=disabled/);
    await app2.close();
    // Restore the enable-on state for the rest of this suite.
    process.env.IMPORT_MUTATION_ENABLED = 'true';
    vi.resetModules();
    const fresh2 = await import('../src/server');
    app = await fresh2.buildServer();
    await app.ready();
  });
});
