import type { FastifyInstance } from 'fastify';
import { endSession } from '../auth/session';
import { writeAudit } from '../lib/audit';

export async function registerLogoutRoutes(app: FastifyInstance): Promise<void> {
  app.post('/logout', async (req, reply) => {
    const ctx = {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      requestId: req.id,
    };
    // Capture the user id BEFORE endSession wipes the in-memory session.
    const user = (req.session?.get?.('user') as { userId?: string } | undefined) ?? undefined;
    await endSession(req, ctx);
    await writeAudit({
      ts: new Date().toISOString(),
      action: 'logout',
      user: user?.userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });
    return reply.redirect('/login', 302);
  });
}
