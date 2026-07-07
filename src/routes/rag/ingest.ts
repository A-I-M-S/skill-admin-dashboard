import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { mkdir, writeFile, chmod, unlink } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sendPage } from '../../lib/render';
import { generateCsrfToken } from '../../auth/csrf';
import { writeAudit } from '../../lib/audit';
import { config } from '../../config';
import {
  ingestFile,
  ingestText,
  type RagIngestResult,
} from '../../lib/rag-subprocess';

export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB (Risk #8)
export const MAX_TEXT_BYTES = 1 * 1024 * 1024;  // 1 MiB
export const DEFAULT_CHUNK_SIZE = 800;
export const DEFAULT_OVERLAP = 200;
const ALLOWED_FILE_EXTS = new Set(['.md', '.txt', '.json', '.yaml', '.yml']);

export interface RagIngestView {
  state:
    | 'ok'
    | 'rag_unavailable'
    | 'unreachable'
    | 'invalid_json'
    | 'spawn_failed'
    | 'unsupported_media'
    | 'payload_too_large'
    | 'invalid_input'
    | 'disabled';
  kind: 'upload' | 'text' | null;
  filename: string;
  source: string;
  chunkSize: number;
  overlap: number;
  result: RagIngestResult | null;
  error: string | null;
}

function safeExt(name: string): string {
  return extname(name).toLowerCase();
}

export function validateFileExt(name: string): boolean {
  return ALLOWED_FILE_EXTS.has(safeExt(name));
}

export function validateChunkSize(raw: string | number | undefined): number | null {
  if (raw === undefined || raw === '') return DEFAULT_CHUNK_SIZE;
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 50 || n > 8000) return null;
  return n;
}

export function validateOverlap(raw: string | number | undefined, chunkSize: number): number | null {
  if (raw === undefined || raw === '') return DEFAULT_OVERLAP;
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 0 || n >= chunkSize) return null;
  return n;
}

export function validateSourceTag(raw: string | undefined): string {
  const s = (raw ?? '').trim();
  if (s === '') return `dashboard-${randomUUID().slice(0, 8)}`;
  // Limit to ASCII letters / digits / dash / underscore / dot, max 128 chars.
  if (s.length > 128) return s.slice(0, 128);
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * With `attachFieldsToBody: true` (set in server.ts), multipart non-file
 * parts are attached to req.body as either:
 *   - a plain string (when the value is a single byte chunk); OR
 *   - a MultipartValue wrapper `{ fieldname, mimetype, value }`.
 * Tolerate both shapes so route handlers can use one accessor.
 */
function readFieldString(body: Record<string, unknown>, name: string): string {
  const raw = body[name] as unknown;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && 'value' in (raw as Record<string, unknown>)) {
    const v = (raw as { value?: unknown }).value;
    return typeof v === 'string' ? v : '';
  }
  return '';
}

function readFieldAsStringOrNumber(
  body: Record<string, unknown>,
  name: string,
): string | number | undefined {
  const raw = body[name] as unknown;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && 'value' in (raw as Record<string, unknown>)) {
    const v = (raw as { value?: unknown }).value;
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return v;
  }
  return undefined;
}

async function writeUploadToTmp(
  bytes: Buffer,
  filename: string,
): Promise<string> {
  const root = `${process.cwd()}/runtime/tmp/ingest`;
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700).catch(() => undefined);
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
  const fullPath = `${root}/${randomUUID()}-${safe}`;
  await writeFile(fullPath, bytes, { encoding: 'utf8', mode: 0o600 });
  await chmod(fullPath, 0o600).catch(() => undefined);
  return fullPath;
}

export interface IngestUploadResult {
  state: RagIngestView['state'];
  filename: string;
  result: RagIngestResult | null;
  error: string | null;
}

export async function handleRagIngestFile(
  req: FastifyRequest,
): Promise<IngestUploadResult> {
  // With `attachFieldsToBody: true` (set in server.ts), multipart parts land
  // directly on req.body: file parts as MultipartFile streams, non-file parts
  // as plain values. The legacy promise-api `req.file()` also still works but
  // returns undefined because the plugin only attaches to body.
  const body = (req.body ?? {}) as Record<string, unknown>;
  const data = body['file'] as
    | {
        filename?: string;
        file: AsyncIterable<Buffer> & { truncated?: boolean };
        mimetype?: string;
      }
    | undefined;
  if (!data) {
    return {
      state: 'invalid_input',
      filename: '',
      result: null,
      error: 'no file uploaded',
    };
  }
  const filename = (data.filename as string) ?? '';
  if (!validateFileExt(filename)) {
    return {
      state: 'unsupported_media',
      filename,
      result: null,
      error: `unsupported file type: ${safeExt(filename) || '(none)'}`,
    };
  }
  // Read the file body fully into memory (multipart stream). Risk #8 caps
  // this at 10 MiB; supertest / fastify-multipart already short-circuits above.
  const chunks: Buffer[] = [];
  let total = 0;
  // fastify-multipart sets `truncated: true` when the configured fileSize
  // limit is exceeded. We catch that here and return 413.
  if (data.file.truncated) {
    return {
      state: 'payload_too_large',
      filename,
      result: null,
      error: `file exceeds ${MAX_FILE_BYTES / 1024 / 1024} MiB`,
    };
  }
  for await (const c of data.file) {
    const buf = c as Buffer;
    total += buf.length;
    if (total > MAX_FILE_BYTES) {
      return {
        state: 'payload_too_large',
        filename,
        result: null,
        error: `file exceeds ${MAX_FILE_BYTES / 1024 / 1024} MiB`,
      };
    }
    chunks.push(buf);
  }
  const buf = Buffer.concat(chunks);
  if (buf.length > MAX_FILE_BYTES) {
    return {
      state: 'payload_too_large',
      filename,
      result: null,
      error: `file exceeds ${MAX_FILE_BYTES / 1024 / 1024} MiB`,
    };
  }

  const source = validateSourceTag(readFieldString(body, 'source'));
  const chunkSize = validateChunkSize(readFieldAsStringOrNumber(body, 'chunkSize'));
  const overlap = chunkSize === null
    ? null
    : validateOverlap(readFieldAsStringOrNumber(body, 'overlap'), chunkSize);
  if (chunkSize === null || overlap === null) {
    return {
      state: 'invalid_input',
      filename,
      result: null,
      error: 'invalid chunking params',
    };
  }
  let tempPath: string | null = null;
  try {
    tempPath = await writeUploadToTmp(buf, filename);
    const actor =
      (req.session?.get?.('user') as { userId?: string } | undefined)?.userId ?? 'unknown';
    const ragResult = await ingestFile(tempPath, { source, chunkSize, overlap });
    if (!ragResult.ok) {
      const reason = ragResult.reason;
      await writeAudit({
        ts: new Date().toISOString(),
        action: 'rag.ingest',
        user: actor,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.id,
        source,
        outcome: 'failure',
        detail: `file:${filename}`,
        reason: ragResult.error ?? `reason=${reason}`,
      }).catch(() => undefined);
      return {
        state:
          reason === 'rag_unavailable' ? 'rag_unavailable'
          : reason === 'invalid_json' ? 'invalid_json'
          : reason === 'spawn_failed' ? 'spawn_failed'
          : 'unreachable',
        filename,
        result: null,
        error: ragResult.error ?? `exit ${ragResult.raw?.code ?? '?'}`,
      };
    }
    await writeAudit({
      ts: new Date().toISOString(),
      action: 'rag.ingest',
      user: actor,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      requestId: req.id,
      source,
      outcome: 'success',
      detail: `file:${filename}`,
      chunks: ragResult.data?.chunks ?? 0,
    }).catch(() => undefined);
    return {
      state: 'ok',
      filename,
      result: ragResult.data ?? { chunks: 0, source },
      error: null,
    };
  } catch (err) {
    return {
      state: 'spawn_failed',
      filename,
      result: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (tempPath !== null) {
      await unlink(tempPath).catch(() => undefined);
    }
  }
}

export interface IngestTextResult {
  state: RagIngestView['state'];
  result: RagIngestResult | null;
  error: string | null;
}

export async function handleRagIngestText(
  req: FastifyRequest,
): Promise<IngestTextResult> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const text = typeof body['text'] === 'string' ? (body['text'] as string) : '';
  if (text === '') {
    return { state: 'invalid_input', result: null, error: 'text is required' };
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
    return {
      state: 'payload_too_large',
      result: null,
      error: `text exceeds ${MAX_TEXT_BYTES / 1024 / 1024} MiB`,
    };
  }
  const source = validateSourceTag(readFieldString(body, 'source'));
  const chunkSize = validateChunkSize(readFieldAsStringOrNumber(body, 'chunkSize'));
  const overlap = chunkSize === null
    ? null
    : validateOverlap(readFieldAsStringOrNumber(body, 'overlap'), chunkSize);
  if (chunkSize === null || overlap === null) {
    return { state: 'invalid_input', result: null, error: 'invalid chunking params' };
  }
  const actor =
    (req.session?.get?.('user') as { userId?: string } | undefined)?.userId ?? 'unknown';
  const ragResult = await ingestText(text, { source, chunkSize, overlap });
  if (!ragResult.ok) {
    const reason = ragResult.reason;
    await writeAudit({
      ts: new Date().toISOString(),
      action: 'rag.ingest',
      user: actor,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      requestId: req.id,
      source,
      outcome: 'failure',
      detail: 'text',
      reason: ragResult.error ?? `reason=${reason}`,
    }).catch(() => undefined);
    return {
      state:
        reason === 'rag_unavailable' ? 'rag_unavailable'
        : reason === 'invalid_json' ? 'invalid_json'
        : reason === 'spawn_failed' ? 'spawn_failed'
        : 'unreachable',
      result: null,
      error: ragResult.error ?? `exit ${ragResult.raw?.code ?? '?'}`,
    };
  }
  await writeAudit({
    ts: new Date().toISOString(),
    action: 'rag.ingest',
    user: actor,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    requestId: req.id,
    source,
    outcome: 'success',
    detail: 'text',
    chunks: ragResult.data?.chunks ?? 0,
  }).catch(() => undefined);
  return {
    state: 'ok',
    result: ragResult.data ?? { chunks: 0, source },
    error: null,
  };
}

export async function registerRagIngestRoute(app: FastifyInstance): Promise<void> {
  app.get('/rag/ingest', async (req, reply) => {
    const flash = (req.query as { flash?: string }).flash;
    const csrfToken = await generateCsrfToken(reply);
    await sendPage(reply, {
      view: 'rag/ingest.ejs',
      context: {
        title: 'RAG · Ingest',
        activeNav: '/rag',
        csrfToken,
        user: req.session?.get?.('user') ?? null,
        view: {
          state: flash === 'ok' ? 'ok' : 'ok' as const,
          kind: null,
          filename: '',
          source: '',
          chunkSize: DEFAULT_CHUNK_SIZE,
          overlap: DEFAULT_OVERLAP,
          result: null,
          error: null,
        } satisfies RagIngestView,
        flash:
          flash === 'ok'
            ? 'Ingest successful.'
            : flash === 'disabled'
              ? 'Mutations are disabled (IMPORT_MUTATION_ENABLED=false).'
              : null,
        importMutationEnabled: config.importMutationEnabled,
      },
    });
  });

  app.post('/rag/ingest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.importMutationEnabled) {
      void reply.code(403);
      return reply.redirect(303, '/rag/ingest?flash=disabled');
    }
    const out = await handleRagIngestFile(req);
    if (out.state === 'ok') {
      void reply.code(303);
      return reply.redirect(303, '/rag/ingest?flash=ok');
    }
    // Bounce back to the form with the failure state preserved.
    const flashMap: Record<RagIngestView['state'], string> = {
      ok: 'ok',
      rag_unavailable: 'rag_unavailable',
      unreachable: 'unreachable',
      invalid_json: 'invalid_json',
      spawn_failed: 'spawn_failed',
      unsupported_media: 'unsupported_media',
      payload_too_large: 'payload_too_large',
      invalid_input: 'invalid_input',
      disabled: 'disabled',
    };
    const statusCode =
      out.state === 'unsupported_media' ? 415
      : out.state === 'payload_too_large' ? 413
      : out.state === 'invalid_input' ? 400
      : 502;
    void reply.code(statusCode);
    const csrfToken = await generateCsrfToken(reply);
    await sendPage(reply, {
      view: 'rag/ingest.ejs',
      context: {
        title: 'RAG · Ingest',
        activeNav: '/rag',
        csrfToken,
        user: req.session?.get?.('user') ?? null,
        view: {
          state: out.state,
          kind: 'upload',
          filename: out.filename,
          source: '',
          chunkSize: DEFAULT_CHUNK_SIZE,
          overlap: DEFAULT_OVERLAP,
          result: null,
          error: out.error,
        } satisfies RagIngestView,
        flash: `${flashMap[out.state]}: ${out.error ?? ''}`.trim(),
        importMutationEnabled: config.importMutationEnabled,
      },
    });
  });

  app.post('/rag/ingest/text', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.importMutationEnabled) {
      void reply.code(403);
      return reply.redirect(303, '/rag/ingest?flash=disabled');
    }
    const out = await handleRagIngestText(req);
    if (out.state === 'ok') {
      void reply.code(303);
      return reply.redirect(303, '/rag/ingest?flash=ok');
    }
    const statusCode =
      out.state === 'payload_too_large' ? 413
      : out.state === 'invalid_input' ? 400
      : 502;
    void reply.code(statusCode);
    const csrfToken = await generateCsrfToken(reply);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const source = typeof body['source'] === 'string' ? (body['source'] as string) : '';
    await sendPage(reply, {
      view: 'rag/ingest.ejs',
      context: {
        title: 'RAG · Ingest',
        activeNav: '/rag',
        csrfToken,
        user: req.session?.get?.('user') ?? null,
        view: {
          state: out.state,
          kind: 'text',
          filename: '',
          source,
          chunkSize: DEFAULT_CHUNK_SIZE,
          overlap: DEFAULT_OVERLAP,
          result: null,
          error: out.error,
        } satisfies RagIngestView,
        flash: out.error ?? null,
        importMutationEnabled: config.importMutationEnabled,
      },
    });
  });
}
