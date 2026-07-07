import { config } from '../../config';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { sendPage } from '../../lib/render';
import {
  isValidServiceName,
  readJournalTail,
  projectJournal,
  resolveLogsServices,
  type JournalCursorPayload,
} from '../../lib/journal';

export interface LogsPageView {
  services: string[];
  active: string;
  initial: JournalCursorPayload;
  reasons: Record<string, JournalCursorPayload['reason']>;
}

/**
 * The `/logs` route serves the initial page (with the first service's
 * 200 lines already embedded) and a per-service polling endpoint
 * `/logs/:service?since=<cursor>` that returns only new bytes.
 */
export async function buildLogsPageView(
  requestedService: string | undefined,
): Promise<LogsPageView> {
  const services = resolveLogsServices(config.logsServices);
  // Default to the first service so the page always has something to
  // render, even when the env override is empty.
  const active = pickActive(services, requestedService);
  const initial = projectJournal(
    await readJournalTail(active, { lines: 200 }).catch((err: unknown) => ({
      ok: false,
      service: active,
      text: '',
      raw: {
        stdout: '',
        stderr: '',
        code: -1,
        signal: null,
        timedOut: false,
        durationMs: 0,
      },
      reason: 'spawn_failed' as const,
      error: err instanceof Error ? err.message : String(err),
    })),
  );
  const reasons: Record<string, JournalCursorPayload['reason']> = {};
  for (const svc of services) {
    reasons[svc] = svc === active ? initial.reason : 'ok';
  }
  return { services, active, initial, reasons };
}

function pickActive(services: string[], requested: string | undefined): string {
  if (requested && services.includes(requested)) return requested;
  return services[0] ?? 'aoa';
}

export async function registerLogsRoute(app: FastifyInstance): Promise<void> {
  app.get('/logs', async (req, reply) => {
    const view = await buildLogsPageView(undefined);
    if (view.services.length === 0) void reply.code(503);
    await sendPage(reply, {
      view: 'ops/logs.ejs',
      context: {
        title: 'Logs',
        activeNav: '/logs',
        csrfToken: '',
        user: req.session?.get?.('user') ?? null,
        view,
      },
    });
  });

  // Poll endpoint — returns only the delta since `cursor`.
  // Risk #9: response body MUST have ANSI stripped before reaching the
  // browser. `projectJournal` enforces that.
  app.get<{ Params: { service: string }; Querystring: { since?: string } }>(
    '/logs/:service',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const service = (req.params as { service: string }).service;
      if (!isValidServiceName(service)) {
        void reply.code(400);
        return reply.send({ ok: false, error: 'invalid service' });
      }
      const sinceRaw = (req.query as { since?: string }).since ?? '';
      const since = sinceRaw === '' ? 0 : Number.parseInt(sinceRaw, 10);
      const safeSince =
        typeof since === 'number' && Number.isFinite(since) && since >= 0 ? since : 0;
      const result = await readJournalTail(service, {
        lines: 2_000,
        since: safeSince,
      }).catch((err: unknown) => ({
        ok: false,
        service,
        text: '',
        raw: {
          stdout: '',
          stderr: '',
          code: -1,
          signal: null,
          timedOut: false,
          durationMs: 0,
        },
        reason: 'spawn_failed' as const,
        error: err instanceof Error ? err.message : String(err),
      }));
      const projected = projectJournal(result);
      if (!projected.ok) {
        if (projected.reason === 'unreachable') void reply.code(503);
        else if (projected.reason === 'invalid_service') void reply.code(400);
        else void reply.code(502);
      }
      void reply.type('application/json; charset=utf-8');
      return reply.send(projected);
    },
  );
}