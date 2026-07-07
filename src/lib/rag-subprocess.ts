import { config } from '../config';
import { createHash } from 'node:crypto';
import { runSubprocess, SpawnError, type SpawnResult } from './subprocess';

/**
 * Subprocess wrapper around `bin/rag` (Python shim) which delegates to the
 * sibling skill-rag-qdrant project. If that sibling isn't installed, the
 * shim exits 7 with empty stdout — the dashboard translates that into
 * `rag_unavailable` (Risk #5).
 *
 * Result shape mirrors `bin-secret.ts` for consistency: every call returns
 * `{ok, data, reason, raw, error?}` so the route layer can pattern-match.
 */

export interface RagStats {
  points?: number;
  vector_count?: number;
  dims?: number;
  collection?: string;
  status?: string;
  last_ingest_at?: string | null;
}

export interface RagSourceItem {
  filename: string;
  size: number;
  ingested_at: string | null;
}

export type RagCallReason =
  | 'ok'
  | 'rag_unavailable'
  | 'invalid_json'
  | 'non_zero_exit'
  | 'spawn_failed';

export interface RagCallResult<T> {
  ok: boolean;
  data: T | null;
  reason: RagCallReason;
  raw: SpawnResult | null;
  error?: string;
}

export interface RagCallOptions {
  timeoutMs?: number;
  envOverrides?: NodeJS.ProcessEnv;
  args?: string[];
}

function isSpawnError(err: unknown): err is SpawnError {
  return err instanceof SpawnError;
}

/**
 * Build the env passed to `bin/rag`. Same Risk-#4 inheritance pattern as
 * `bin-secret.ts`: env comes from the dashboard's own env (systemd /
 * `.env`), never from a request body.
 */
export function buildRagEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...(overrides ?? {}) };
}

export function resolveRagBin(): string {
  // Same env-var convention as `bin/secret`: SKILL_RAG_BIN overrides the
  // dashboard's `bin/rag` shim path so tests / air-gapped installs can
  // swap in a fixture.
  const fromEnv = (process.env.SKILL_RAG_BIN ?? '').trim();
  if (fromEnv !== '') return fromEnv;
  // Default to the dashboard's own bin/rag shim.
  return config.skillRag.binPath;
}

export async function callRag<T>(
  args: string[],
  options: RagCallOptions = {},
): Promise<RagCallResult<T>> {
  const bin = resolveRagBin();
  const env = buildRagEnv(options.envOverrides);
  const fullArgs = options.args ? [...args, ...options.args] : args;
  let result: SpawnResult;
  try {
    result = await runSubprocess(bin, {
      args: fullArgs,
      env,
      timeoutMs: options.timeoutMs ?? 15_000,
    });
  } catch (err) {
    if (isSpawnError(err)) {
      return {
        ok: false,
        data: null,
        reason: 'spawn_failed',
        raw: err.result,
        error: err.message,
      };
    }
    return {
      ok: false,
      data: null,
      reason: 'spawn_failed',
      raw: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Empty stdout + non-zero exit ⇒ rag_unavailable (Risk #5).
  if (result.code !== 0 || result.timedOut) {
    const emptyStdout = result.stdout.trim() === '';
    return {
      ok: false,
      data: null,
      reason: emptyStdout ? 'rag_unavailable' : 'non_zero_exit',
      raw: result,
      error: result.stderr.trim() || `exit ${result.code}`,
    };
  }

  const trimmed = result.stdout.trim();
  if (trimmed === '') {
    return {
      ok: false,
      data: null,
      reason: 'rag_unavailable',
      raw: result,
    };
  }

  try {
    const parsed = JSON.parse(trimmed) as T;
    return { ok: true, data: parsed, reason: 'ok', raw: result };
  } catch {
    return {
      ok: false,
      data: null,
      reason: 'invalid_json',
      raw: result,
      error: 'bin/rag output was not valid JSON',
    };
  }
}

/**
 * Project `bin/rag list-sources` output down to filename + size only —
 * never the file content (Risk #5: no plaintext / chunk text on the
 * dashboard).
 */
export function projectSourceList(raw: unknown): RagSourceItem[] {
  if (!Array.isArray(raw)) return [];
  const out: RagSourceItem[] = [];
  for (const item of raw) {
    if (item && typeof item === 'object') {
      const it = item as Record<string, unknown>;
      const filename =
        typeof it['filename'] === 'string' && it['filename'].length > 0
          ? (it['filename'] as string)
          : typeof it['source'] === 'string'
            ? (it['source'] as string)
            : '';
      if (filename === '') continue;
      const sizeRaw = it['size'] ?? it['size_bytes'] ?? 0;
      const size = typeof sizeRaw === 'number' && sizeRaw >= 0 ? sizeRaw : 0;
      const ingestedAtRaw = it['ingested_at'] ?? it['mtime'] ?? null;
      const ingested_at =
        typeof ingestedAtRaw === 'string' && ingestedAtRaw.length > 0
          ? (ingestedAtRaw as string)
          : null;
      out.push({ filename, size, ingested_at });
    }
  }
  return out;
}

export function projectStats(raw: unknown): RagStats {
  if (!raw || typeof raw !== 'object') return {};
  const it = raw as Record<string, unknown>;
  const numOrUndef = (k: string): number | undefined => {
    const v = it[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  const strOrUndef = (k: string): string | undefined =>
    typeof it[k] === 'string' && (it[k] as string).length > 0
      ? (it[k] as string)
      : undefined;
  return {
    points: numOrUndef('points'),
    vector_count: numOrUndef('vector_count'),
    dims: numOrUndef('dims'),
    collection: strOrUndef('collection'),
    status: strOrUndef('status'),
    last_ingest_at: strOrUndef('last_ingest_at') ?? null,
  };
}

export async function stats(
  options: RagCallOptions = {},
): Promise<RagCallResult<RagStats>> {
  const result = await callRag<unknown>(['stats'], options);
  if (!result.ok || result.data === null) {
    return { ...result, data: null };
  }
  return {
    ok: true,
    reason: 'ok',
    raw: result.raw,
    data: projectStats(result.data),
  };
}

export async function listSources(
  options: RagCallOptions = {},
): Promise<RagCallResult<RagSourceItem[]>> {
  const result = await callRag<unknown>(['list-sources'], options);
  if (!result.ok || result.data === null) {
    return { ...result, data: null };
  }
  return {
    ok: true,
    reason: 'ok',
    raw: result.raw,
    data: projectSourceList(result.data),
  };
}

export interface RagIngestOptions {
  /** Stable tag / source identifier (e.g. "meeting-2026-07-05"). */
  source?: string;
  /** Chunk size in chars (default 800). Sent through; the wrapper may clamp. */
  chunkSize?: number;
  /** Overlap between adjacent chunks (default 200). */
  overlap?: number;
  /** Multi-call args appended after the dashboard's own; tests use this. */
  extraArgs?: string[];
  timeoutMs?: number;
}

export interface RagIngestResult {
  chunks: number;
  source: string;
}

/**
 * Coerce an unknown `chunks` count from the upstream JSON into a safe
 * non-negative integer. If upstream returns garbage, default to 0.
 */
function coerceChunkCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return 0;
}

function buildIngestResult(
  raw: unknown,
  fallbackSource: string,
): RagIngestResult {
  if (raw && typeof raw === 'object') {
    const it = raw as Record<string, unknown>;
    const source =
      typeof it['source'] === 'string' && (it['source'] as string).length > 0
        ? (it['source'] as string)
        : fallbackSource;
    return { chunks: coerceChunkCount(it['chunks']), source };
  }
  return { chunks: 0, source: fallbackSource };
}

/**
 * Ingest a file from disk. `filePath` MUST be a path that exists on this
 * host — the dashboard writes the user-uploaded file to a mode 0o600
 * temp file under `runtime/tmp/<uuid>/...` before invoking this. The
 * wrapper reads from disk; the API key / content never crosses a process
 * boundary as a request-body arg (Risk #5, Risk #8 caps).
 */
export async function ingestFile(
  filePath: string,
  options: RagIngestOptions = {},
): Promise<RagCallResult<RagIngestResult>> {
  const args: string[] = ['ingest-file', filePath];
  if (options.source) args.push('--source', options.source);
  if (typeof options.chunkSize === 'number') {
    args.push('--chunk-size', String(options.chunkSize));
  }
  if (typeof options.overlap === 'number') {
    args.push('--overlap', String(options.overlap));
  }
  const callOpts: RagCallOptions = {
    timeoutMs: options.timeoutMs ?? 60_000,
    args: options.extraArgs,
  };
  const result = await callRag<unknown>(args, callOpts);
  if (!result.ok || result.data === null) {
    return { ...result, data: null };
  }
  return {
    ok: true,
    reason: 'ok',
    raw: result.raw,
    data: buildIngestResult(result.data, options.source ?? ''),
  };
}

/**
 * Ingest a text string directly. The text is forwarded through
 * `spawn`-args (not stdin), which means:
 *  - it is safe from shell injection because we use spawn, not shell;
 *  - it is bounded to the process argv limit (~ 128 KiB on Linux).
 *
 * The dashboard's route layer rejects requests with `text` larger than
 * 1 MiB (Risk #8) so we never hit argv limits.
 */
export async function ingestText(
  text: string,
  options: RagIngestOptions = {},
): Promise<RagCallResult<RagIngestResult>> {
  const args: string[] = ['ingest-text', text];
  if (options.source) args.push('--source', options.source);
  if (typeof options.chunkSize === 'number') {
    args.push('--chunk-size', String(options.chunkSize));
  }
  if (typeof options.overlap === 'number') {
    args.push('--overlap', String(options.overlap));
  }
  const callOpts: RagCallOptions = {
    timeoutMs: options.timeoutMs ?? 60_000,
    args: options.extraArgs,
  };
  const result = await callRag<unknown>(args, callOpts);
  if (!result.ok || result.data === null) {
    return { ...result, data: null };
  }
  return {
    ok: true,
    reason: 'ok',
    raw: result.raw,
    data: buildIngestResult(result.data, options.source ?? ''),
  };
}

export interface RagAskHit {
  score: number;
  text: string;
  source: string | null;
  chunk_index: number | null;
}

export interface RagAskResult {
  questionHash: string;
  topK: number;
  answer: string | null;
  hits: RagAskHit[];
}

/**
 * Coerce one upstream hit into the allow-listed shape. We deliberately
 * accept ONLY score / text / source / chunk_index. Anything else
 * (payload, raw Vector, custom objects, etc.) is dropped.
 */
function coerceHit(value: unknown): RagAskHit | null {
  if (!value || typeof value !== 'object') return null;
  const it = value as Record<string, unknown>;
  const score = typeof it['score'] === 'number' ? (it['score'] as number) : NaN;
  if (!Number.isFinite(score)) return null;
  const text = typeof it['text'] === 'string' ? (it['text'] as string) : '';
  const source = typeof it['source'] === 'string' ? (it['source'] as string) : null;
  const chunkIdxRaw = it['chunk_index'];
  const chunk_index =
    typeof chunkIdxRaw === 'number' && Number.isFinite(chunkIdxRaw)
      ? (chunkIdxRaw as number)
      : null;
  return { score, text, source, chunk_index };
}

/**
 * Run an admin-only RAG question. The question text is hashed (SHA-256,
 * first 12 hex chars) before it hits the audit log — the question text
 * itself is NEVER persisted (privacy).
 */
export async function ask(
  question: string,
  options: RagCallOptions & { topK?: number } = {},
): Promise<RagCallResult<RagAskResult>> {
  const topK = options.topK ?? 3;
  const args = ['ask', question, '--top-k', String(topK)];
  const callOpts: RagCallOptions = {
    timeoutMs: options.timeoutMs ?? 30_000,
    args: options.args,
  };
  const result = await callRag<unknown>(args, callOpts);
  if (!result.ok || result.data === null) {
    return { ...result, data: null };
  }
  const raw = result.data as Record<string, unknown>;
  const questionHash = createHash('sha256').update(question, 'utf8').digest('hex').slice(0, 12);

  let hits: RagAskHit[] = [];
  if (Array.isArray(raw['contexts'])) {
    hits = (raw['contexts'] as unknown[])
      .map(coerceHit)
      .filter((h): h is RagAskHit => h !== null);
    // Sort by descending score; cap at topK.
    hits.sort((a, b) => b.score - a.score);
    hits = hits.slice(0, topK);
  }
  const answer = typeof raw['answer'] === 'string' ? (raw['answer'] as string) : null;

  return {
    ok: true,
    reason: 'ok',
    raw: result.raw,
    data: { questionHash, topK, answer, hits },
  };
}
