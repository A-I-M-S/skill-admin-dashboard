import fastifyCsrfProtection from '@fastify/csrf-protection';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { writeAudit } from '../lib/audit';

export const CSRF_FIELD_NAME = '_csrf' as const;

export async function registerCsrf(app: FastifyInstance): Promise<void> {
  await app.register(fastifyCsrfProtection, {
    sessionPlugin: '@fastify/session',
    // Risk #12: token bound to session. A regenerated session (e.g. on login)
    // automatically yields a fresh CSRF secret — no manual rotation needed.
    sessionKey: 'csrf-secret',
    cookieKey: CSRF_FIELD_NAME,
    getToken: (req) => {
      const body = req.body as Record<string, unknown> | undefined;
      if (body && typeof body[CSRF_FIELD_NAME] === 'string') {
        return body[CSRF_FIELD_NAME] as string;
      }
      const headerToken = req.headers['csrf-token'];
      if (typeof headerToken === 'string') return headerToken;
      return undefined;
    },
  });

  // Global CSRF gate — Risk #3: fail-closed. Any mutating request that does
  // not carry a valid CSRF token returns 403, regardless of READONLY_MODE.
  // GET / HEAD / OPTIONS are exempt. /login is the bootstrap route and is
  // also exempt; /healthz is exempt. Everything else is protected.
  //
  // The plugin's csrfProtection hook is an (req, reply, next) callback that
  // calls reply.send(error) on failure (which emits 403 + FST_CSRF_* body).
  // We invoke it manually at preHandler so req.body is parsed (form posts
  // carry the token in the body, not headers).
  app.addHook('preHandler', async (req, reply) => {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    const url = (req.url ?? '').split('?')[0] ?? '';
    if (url === '/login' || url === '/healthz') return;
    if (reply.sent) return;

    const session = (req as FastifyRequest).session;
    if (!session) {
      csrfFailure(req, 'no-session');
      void reply.code(403).send({ error: 'csrf_invalid' });
      return;
    }

    const pluginHook = app.csrfProtection as (
      r: FastifyRequest,
      s: FastifyReply,
      cb: (err?: Error) => void,
    ) => void;
    await new Promise<void>((resolve) => {
      pluginHook(req, reply, () => resolve());
    });
    if (reply.sent && reply.statusCode === 403) {
      csrfFailure(req, `http-${reply.statusCode}`);
    }
  });
}

export async function generateCsrfToken(reply: FastifyReply): Promise<string> {
  return reply.generateCsrf();
}

function csrfFailure(req: FastifyRequest, reason: string): void {
  void writeAudit({
    ts: new Date().toISOString(),
    action: 'csrf.failure',
    user: (req.session?.get?.('user') as { userId?: string } | undefined)?.userId,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    requestId: req.id,
    reason,
  });
}
