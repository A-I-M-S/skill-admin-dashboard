import { config } from '../config';
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
