import { existsSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { sendPage } from '../../lib/render';
import { generateCsrfToken } from '../../auth/csrf';
import { writeAudit, type AuditAction } from '../../lib/audit';
import {
  cronList,
  cronAction,
  type CronAction,
  type CronActionResult,
} from '../../lib/openclaw-bin';

type OpenClawCallReason =
  | 'ok'
  | 'unreachable'
  | 'invalid_json'
  | 'non_zero_exit'
  | 'spawn_failed';

export interface CronJobView {
  id: string;
  name: string;
  schedule: string;
  lastRunAt: string | null;
  enabled: boolean;
}

export interface CronListView {
  state:
    | 'ok'
    | 'unreachable'
    | 'invalid_json'
    | 'spawn_failed'
    | 'invalid_id';
  cronPath: string | null;
  jobs: CronJobView[];
  error: string | null;
}

/**
 * Constrain cron job ids to a safe ASCII shape (no shell meta chars).
 * Same pattern as the vault `:id` validator in routes/vault/show.ts.
 */
const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function validateJobId(rawId: string): string | null {
  const id = rawId.trim();
  if (id === '') return null;
  if (!ID_PATTERN.test(id)) return null;
  return id;
}

/**
 * Translate the OpenClawCallReason into a view-friendly state.
 */
function normalize(reason: OpenClawCallReason, action: CronAction): CronListView['state'] {
  if (reason === 'ok') return 'ok';
  if (reason === 'invalid_json') return 'invalid_json';
  if (reason === 'spawn_failed') return 'spawn_failed';
  return 'unreachable';
  void action;
}

/**
 * Project a single cron job entry from the upstream cron tool's JSON.
 * Falls back to `unknown` / "" for missing fields so the view always
 * renders a row.
 */
function projectCronJob(raw: Record<string, unknown>, idx: number): CronJobView {
  const id =
    (typeof raw['id'] === 'string' && (raw['id'] as string)) ||
    (typeof raw['job_id'] === 'string' && (raw['job_id'] as string)) ||
    '';
  const name =
    (typeof raw['name'] === 'string' && (raw['name'] as string)) ||
    (typeof raw['command'] === 'string' && (raw['command'] as string)) ||
    `cron-job-${idx}`;
  const schedule =
    (typeof raw['schedule'] === 'string' && (raw['schedule'] as string)) ||
    (typeof raw['cron'] === 'string' && (raw['cron'] as string)) ||
    '';
  const lastRunAtRaw =
    typeof raw['last_run_at'] === 'string'
      ? (raw['last_run_at'] as string)
      : typeof raw['lastRunAt'] === 'string'
        ? (raw['lastRunAt'] as string)
        : null;
  const enabled =
    typeof raw['enabled'] === 'boolean'
      ? (raw['enabled'] as boolean)
      : typeof raw['paused'] === 'boolean'
        ? !(raw['paused'] as boolean)
        : true;
  return {
    id: id !== '' ? id : `unknown-${idx}`,
    name,
    schedule,
    lastRunAt: lastRunAtRaw,
    enabled,
  };
}

/**
 * Resolve the on-disk cron binary path so we can show it on the page
 * even when the binary fails to execute. Used by tests too — the asset
 * is the binary that was found, not the one that actually ran.
 */
function resolveCronPath(): string | null {
  // Mirrors openclaw-bin.ts:resolveOpenclawToolPath('cron'). Keep in sync.
  const dirs = (process.env.OPENCLAW_BIN ?? '/usr/local/bin:/usr/bin').split(':').map((d) => d.trim()).filter((d) => d !== '');
  for (const dir of dirs) {
    const candidate = `${dir}/cron`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function buildCronListView(): Promise<CronListView> {
  const result = await cronList().catch((err: unknown) => ({
    ok: false,
    data: null,
    reason: 'spawn_failed' as OpenClawCallReason,
    raw: null,
    error: err instanceof Error ? err.message : String(err),
  }));
  if (!result.ok || result.data === null) {
    return {
      state: normalize(result.reason, 'pause'),
      cronPath: resolveCronPath(),
      jobs: [],
      error: result.error ?? null,
    };
  }
  const jobsRaw = Array.isArray(result.data.jobs)
    ? (result.data.jobs as unknown[])
    : [];
  const jobs: CronJobView[] = jobsRaw
    .filter((j): j is Record<string, unknown> => typeof j === 'object' && j !== null)
    .map((j, i) => projectCronJob(j, i));
  return {
    state: 'ok',
    cronPath: resolveCronPath(),
    jobs,
    error: null,
  };
}

interface CronActionDeps {
  actor: string;
  ip: string;
  userAgent: string | undefined;
  requestId: string;
  now: () => Date;
}

async function writeCronAudit(
  action: CronAction,
  jobId: string,
  outcome: 'success' | 'failure',
  reason: string | undefined,
  deps: CronActionDeps,
): Promise<void> {
  await writeAudit({
    ts: deps.now().toISOString(),
    action: `cron.${action}` as AuditAction,
    user: deps.actor,
    ip: deps.ip,
    userAgent: deps.userAgent,
    requestId: deps.requestId,
    jobId,
    outcome,
    reason,
  }).catch(() => undefined);
}

export async function registerCronRoute(app: FastifyInstance): Promise<void> {
  app.get('/cron', async (req, reply) => {
    const view = await buildCronListView();
    const csrfToken = await generateCsrfToken(reply);
    await sendPage(reply, {
      view: 'ops/cron.ejs',
      context: {
        title: 'Cron',
        activeNav: '/cron',
        csrfToken,
        user: req.session?.get?.('user') ?? null,
        view,
      },
    });
  });

  const actionRoutes: Array<{ path: string; action: CronAction }> = [
    { path: '/cron/:id/pause', action: 'pause' },
    { path: '/cron/:id/resume', action: 'resume' },
    { path: '/cron/:id/run', action: 'run' },
    { path: '/cron/:id/remove', action: 'remove' },
  ];

  for (const route of actionRoutes) {
    app.post<{ Params: { id: string } }>(route.path, async (req: FastifyRequest, reply: FastifyReply) => {
      const id = validateJobId((req.params as { id: string }).id);
      if (id === null) {
        void reply.code(400);
        return reply.send({ error: 'invalid job id' });
      }
      const actor =
        (req.session?.get?.('user') as { userId?: string } | undefined)?.userId ?? 'unknown';
      const deps: CronActionDeps = {
        actor,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.id,
        now: () => new Date(),
      };
      const result: CronActionResult & { reason?: string } = await (async () => {
        const r = await cronAction(route.action, id);
        if (!r.ok) {
          return { ok: false, reason: r.error ?? `reason=${r.reason}` };
        }
        return { ok: true, ...(r.data ?? {}) };
      })();
      if (!result.ok) {
        await writeCronAudit(route.action, id, 'failure', result.reason, deps);
        void reply.code(502);
        return reply.send({
          error: result.reason ?? `cron ${route.action} failed`,
        });
      }
      await writeCronAudit(route.action, id, 'success', undefined, deps);
      void reply.code(303);
      return reply.redirect('/cron');
    });
  }
}
