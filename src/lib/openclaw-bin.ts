import { existsSync } from 'node:fs';
import { config } from '../config';
import { runSubprocess, SpawnError, type SpawnResult } from './subprocess';

export type OpenClawTool = 'cron' | 'sessions_list' | 'opencode';

export interface OpenClawInvocation {
  tool: OpenClawTool;
  args: string[];
  binaryPath: string;
  env: NodeJS.ProcessEnv;
}

export interface OpenClawCallOptions {
  timeoutMs?: number;
  envOverrides?: NodeJS.ProcessEnv;
}

function buildOpenclawEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Inherit the dashboard's full env. We add SYSTEMD_COLORS=0 and TERM=dumb
  // for journalctl-derived calls (Risk #9). The caller can layer more on top
  // via overrides.
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    SYSTEMD_COLORS: '0',
    TERM: 'dumb',
  };
  return { ...base, ...(overrides ?? {}) };
}

export function resolveOpenclawToolPath(tool: OpenClawTool): string | null {
  const dirs = config.openclawBin.split(':').map((d) => d.trim()).filter((d) => d !== '');
  for (const dir of dirs) {
    const candidate = `${dir}/${tool}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function buildOpenclawInvocation(
  tool: OpenClawTool,
  args: string[],
  options: OpenClawCallOptions = {},
): OpenClawInvocation {
  const binaryPath = resolveOpenclawToolPath(tool) ?? tool;
  return {
    tool,
    args,
    binaryPath,
    env: buildOpenclawEnv(options.envOverrides),
  };
}

export interface OpenClawCallResult<T> {
  ok: boolean;
  data: T | null;
  reason: 'ok' | 'unreachable' | 'invalid_json' | 'non_zero_exit' | 'spawn_failed';
  raw: SpawnResult | null;
  error?: string;
}

export async function callOpenclawTool<T>(
  tool: OpenClawTool,
  args: string[],
  options: OpenClawCallOptions = {},
): Promise<OpenClawCallResult<T>> {
  const invocation = buildOpenclawInvocation(tool, args, options);
  let result: SpawnResult;
  try {
    result = await runSubprocess(invocation.binaryPath, {
      args: invocation.args,
      env: invocation.env,
      timeoutMs: options.timeoutMs ?? 10_000,
    });
  } catch (err) {
    if (err instanceof SpawnError) {
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

  if (result.code !== 0 || result.timedOut) {
    const emptyStdout = result.stdout.trim() === '';
    return {
      ok: false,
      data: null,
      reason: emptyStdout ? 'unreachable' : 'non_zero_exit',
      raw: result,
      error: result.stderr.trim() || `exit ${result.code}`,
    };
  }

  const trimmed = result.stdout.trim();
  if (trimmed === '') {
    return { ok: false, data: null, reason: 'unreachable', raw: result };
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
      error: 'openclaw tool output was not valid JSON',
    };
  }
}

export interface CronJobSummary {
  jobId?: string;
  id?: string;
  name?: string;
  enabled?: boolean;
  nextRunAt?: string;
}

export interface CronListResponse {
  jobs?: CronJobSummary[];
}

export async function cronList(
  options: OpenClawCallOptions = {},
): Promise<OpenClawCallResult<CronListResponse>> {
  return callOpenclawTool<CronListResponse>('cron', ['list', '--json'], options);
}

export type CronAction = 'pause' | 'resume' | 'run' | 'remove';

/**
 * JSON-decoder for a single cron action's stdout. The upstream cron tool
 * returns `{ ok: true, job_id, action }` on success and `{ ok: false,
 * reason }` on failure. We tolerate either.
 */
export interface CronActionResult {
  ok: boolean;
  job_id?: string;
  action?: CronAction;
  reason?: string;
}

/**
 * Run a cron mutating action: `pause`, `resume`, `run`, or `remove`.
 *
 * The cron CLI is expected to accept `<action> <job-id>` and emit JSON.
 * `--json` is requested so the dashboard can parse structured responses
 * rather than scraping stderr.
 *
 * Risk #11: the binary path is resolved via `OPENCLAW_BIN` so the
 * dashboard can be air-gapped by pointing at a fixture / `cron-mock`.
 */
export async function cronAction(
  action: CronAction,
  jobId: string,
  options: OpenClawCallOptions = {},
): Promise<OpenClawCallResult<CronActionResult>> {
  return callOpenclawTool<CronActionResult>('cron', [action, jobId, '--json'], options);
}

export interface SessionsListItem {
  key?: string;
  id?: string;
  agentId?: string;
  state?: string;
  lastMessageAt?: string;
  startedAt?: string;
  sessionFile?: string;
  model?: string;
}

export interface SessionsListResponse {
  sessions?: SessionsListItem[];
}

export async function sessionsList(
  options: OpenClawCallOptions = {},
): Promise<OpenClawCallResult<SessionsListResponse>> {
  return callOpenclawTool<SessionsListResponse>('sessions_list', ['--json'], options);
}
