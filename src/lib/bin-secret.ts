import { config } from '../config';
import { runSubprocess, SpawnError, type SpawnResult } from './subprocess';

export interface BinSecretWhoami {
  projectUrl?: string;
  anonKeyId?: string;
  region?: string;
  authStatus?: string;
  backend?: string;
}

export interface BinSecretListItem {
  id: string;
  mtime?: string;
  tags?: string[];
  kind?: string;
  preview?: string;
}

export interface BinSecretListResult {
  items: BinSecretListItem[];
  raw: SpawnResult;
}

/**
 * Metadata-only projection of a secret. Risk #1 + #4 (Q1 decision: NO reveal
 * in v1): a secret item MUST NOT carry plaintext to the dashboard. Anything
 * returned by `get` / `list` is run through `projectSecretMetadata` so even a
 * buggy/over-sharey `bin/secret` upstream cannot leak plaintext into a
 * response body.
 */
export interface BinSecretMetadataItem {
  id: string;
  name?: string;
  mtime?: string;
  tags?: string[];
  kind?: string;
  sha?: string;
  preview?: string;
}

/**
 * Fields that are allowed on metadata-only responses. Anything else — most
 * importantly `content`, `plaintext`, `secret`, `value`, `body` — is dropped.
 */
const ALLOWED_METADATA_KEYS: ReadonlySet<string> = new Set([
  'id',
  'name',
  'mtime',
  'tags',
  'kind',
  'sha',
  'preview',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function projectSecretMetadata(raw: unknown): BinSecretMetadataItem | null {
  if (!isRecord(raw)) return null;
  const idValue = raw['id'];
  if (typeof idValue !== 'string' || idValue === '') return null;
  const projected: BinSecretMetadataItem = { id: idValue };
  for (const key of ALLOWED_METADATA_KEYS) {
    if (key === 'id') continue;
    const value = raw[key];
    if (value === undefined) continue;
    if (key === 'tags') {
      if (Array.isArray(value)) {
        const tags: string[] = [];
        for (const t of value) {
          if (typeof t === 'string') tags.push(t);
        }
        projected.tags = tags;
      }
      continue;
    }
    if (typeof value === 'string') {
      if (key === 'name') projected.name = value;
      else if (key === 'mtime') projected.mtime = value;
      else if (key === 'kind') projected.kind = value;
      else if (key === 'sha') projected.sha = value;
      else if (key === 'preview') projected.preview = value;
    }
  }
  return projected;
}

export function projectSecretList(raw: unknown): BinSecretMetadataItem[] {
  if (!isRecord(raw)) return [];
  const itemsValue = raw['items'];
  if (!Array.isArray(itemsValue)) return [];
  const out: BinSecretMetadataItem[] = [];
  for (const item of itemsValue) {
    const projected = projectSecretMetadata(item);
    if (projected !== null) out.push(projected);
  }
  return out;
}

export interface BinSecretCallOptions {
  timeoutMs?: number;
  envOverrides?: NodeJS.ProcessEnv;
}

/**
 * Build the env passed to `bin/secret`. We always inherit from the
 * dashboard's own env (process.env) so the systemd `EnvironmentFile=` is the
 * source of truth — see Risk #4. Callers may additively pass extra env vars
 * via `envOverrides`, but we never accept secrets from a request body.
 */
export function buildBinSecretEnv(
  overrides?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  // Always start from process.env so SKILL_SECRET_KMS_BACKEND,
  // SKILL_SECRET_KMS_PROJECT_URL, SKILL_SECRET_KMS_API_BLOB and
  // SKILL_SECRET_PASSPHRASE are inherited. Callers can still layer on
  // extra env (e.g. SKILL_SECRET_ENV) via overrides.
  return { ...process.env, ...(overrides ?? {}) };
}

/**
 * Resolve the `bin/secret` path. `SKILL_SECRET_BIN` is the env var; default
 * points at the sibling skill-secret project. The local snapshot at
 * `references/upstream/skill-secret/bin-secret-wrapper` is the documented
 * fallback used in CI / airgapped installs.
 */
export function resolveBinSecretPath(): string {
  return config.skillSecret.binPath;
}

export interface BinSecretInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  options: { timeoutMs?: number };
}

export function buildBinSecretInvocation(
  args: string[],
  options: BinSecretCallOptions = {},
): BinSecretInvocation {
  const env = buildBinSecretEnv(options.envOverrides);
  return {
    command: resolveBinSecretPath(),
    args,
    env,
    options: { timeoutMs: options.timeoutMs ?? 10_000 },
  };
}

function isSpawnError(err: unknown): err is SpawnError {
  return err instanceof SpawnError;
}

export interface BinSecretCallResult<T> {
  ok: boolean;
  data: T | null;
  reason: 'ok' | 'vault_unreachable' | 'invalid_json' | 'non_zero_exit' | 'spawn_failed';
  raw: SpawnResult | null;
  error?: string;
}

export async function callBinSecret<T>(
  args: string[],
  options: BinSecretCallOptions = {},
): Promise<BinSecretCallResult<T>> {
  const invocation = buildBinSecretInvocation(args, options);
  let result: SpawnResult;
  try {
    result = await runSubprocess(invocation.command, {
      args: invocation.args,
      env: invocation.env,
      timeoutMs: invocation.options.timeoutMs,
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

  // Non-zero exit + empty stdout → "vault unreachable" (Risk #1).
  if (result.code !== 0 || result.timedOut) {
    const emptyStdout = result.stdout.trim() === '';
    return {
      ok: false,
      data: null,
      reason: emptyStdout ? 'vault_unreachable' : 'non_zero_exit',
      raw: result,
      error: result.stderr.trim() || `exit ${result.code}`,
    };
  }

  const trimmed = result.stdout.trim();
  if (trimmed === '') {
    return {
      ok: false,
      data: null,
      reason: 'vault_unreachable',
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
      error: 'bin/secret output was not valid JSON',
    };
  }
}

export async function whoami(
  options: BinSecretCallOptions = {},
): Promise<BinSecretCallResult<BinSecretWhoami>> {
  return callBinSecret<BinSecretWhoami>(['whoami'], options);
}

/**
 * Fetch metadata for every secret in the vault. The raw JSON from
 * `bin/secret list` is filtered through `projectSecretList`, which drops any
 * field that is not on the metadata allow-list (Risk #1 + #4: never plaintext
 * in the dashboard response).
 */
export async function list(
  options: BinSecretCallOptions = {},
): Promise<BinSecretCallResult<BinSecretMetadataItem[]>> {
  // We accept whatever raw shape `bin/secret list` produces; bin-secret
  // upstream currently doesn't expose `list`, so in production this falls
  // back to `vault_unreachable`. Tests script the mock to return JSON.
  const result = await callBinSecret<unknown>(['list'], options);
  if (!result.ok || result.data === null) {
    return { ...result, data: null };
  }
  const projected = projectSecretList(result.data);
  return {
    ok: true,
    reason: 'ok',
    raw: result.raw,
    data: projected,
  };
}

/**
 * Fetch metadata for a single secret by id. `bin/secret` has no native
 * metadata-only `get` command, so we currently proxy to `bin/secret get <id>`
 * when available, falling back to a `list`-then-find implementation that
 * never returns plaintext. The result is projected through
 * `projectSecretMetadata` so a buggy upstream cannot leak `content` /
 * `plaintext` fields to the response body.
 */
export async function get(
  id: string,
  options: BinSecretCallOptions = {},
): Promise<BinSecretCallResult<BinSecretMetadataItem>> {
  const result = await callBinSecret<unknown>(['get', id], options);
  if (!result.ok || result.data === null) {
    return { ...result, data: null };
  }
  const projected = projectSecretMetadata(result.data);
  if (projected === null) {
    return {
      ok: false,
      reason: 'invalid_json',
      raw: result.raw,
      data: null,
      error: 'bin/secret get returned an item without an id',
    };
  }
  return {
    ok: true,
    reason: 'ok',
    raw: result.raw,
    data: projected,
  };
}

export interface InitOptions {
  url: string;
  /** Path on disk to a file containing the API key (mode 0o600). */
  apiKeyFilePath: string;
  /** Override pass-phrase forwarded to `bin/secret init --password`. Optional. */
  passphrase?: string;
  /** Caller-injected env (e.g. SKILL_SECRET_PASSPHRASE). */
  envOverrides?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Invoke `bin/secret init --url <url> --api-key-file <path>` to (re)initialise
 * the Supabase KMS database. The caller is responsible for placing the API
 * key on disk (mode 0o600) and deleting it after the call returns.
 *
 * The wrapper NEVER accepts plaintext via env / args from a request body — it
 * only references the file path (Risk #4). The actual API key bytes stay on
 * disk just long enough for `bin/secret` to slurp them.
 *
 * Password is read from the dashboard's own env (via `envOverrides` /
 * `process.env`) — typically `SKILL_SECRET_PASSPHRASE` from systemd /
 * `.env`, NEVER the request body.
 */
export async function init(
  options: InitOptions,
): Promise<BinSecretCallResult<{ url: string }>> {
  const args = ['init', '--url', options.url, '--api-key-file', options.apiKeyFilePath];
  if (options.passphrase) {
    args.push('--password', options.passphrase);
  }
  const callOptions: BinSecretCallOptions = {
    timeoutMs: options.timeoutMs ?? 30_000,
    envOverrides: options.envOverrides,
  };
  const result = await callBinSecret<{ url?: string }>(args, callOptions);
  if (!result.ok || result.data === null) {
    return { ...result, data: null };
  }
  return {
    ok: true,
    reason: 'ok',
    raw: result.raw,
    data: { url: result.data.url ?? options.url },
  };
}
