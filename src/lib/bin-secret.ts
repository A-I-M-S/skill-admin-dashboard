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

export async function list(
  options: BinSecretCallOptions = {},
): Promise<BinSecretCallResult<BinSecretListResult>> {
  return callBinSecret<BinSecretListResult>(['list'], options);
}
