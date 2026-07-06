import type { FastifyInstance, FastifyReply } from 'fastify';
import { config } from '../config';
import { generateCsrfToken } from '../auth/csrf';
import { startSession, verifyAdminPassword } from '../auth/session';
import { writeAudit } from '../lib/audit';
import { sendPage } from '../lib/render';

interface LoginBody {
  username?: string;
  password?: string;
}

export async function registerLoginRoutes(app: FastifyInstance): Promise<void> {
  app.get('/login', async (_req, reply) => {
    const csrfToken = await generateCsrfToken(reply);
    return sendPage(reply, {
      view: 'login.ejs',
      context: {
        title: 'Sign in',
        user: null,
        csrfToken,
        activeNav: '/login',
      },
    });
  });

  app.post('/login', async (req, reply) => {
    const body = (req.body ?? {}) as LoginBody;
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (username !== config.auth.adminUser) {
      await writeAudit({
        ts: new Date().toISOString(),
        action: 'login.failure',
        user: username,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.id,
        reason: 'user-mismatch',
      });
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    const ok = await verifyAdminPassword(password);
    if (!ok) {
      await writeAudit({
        ts: new Date().toISOString(),
        action: 'login.failure',
        user: username,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.id,
        reason: 'bad-password',
      });
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    await startSession(app, req, reply, username, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      requestId: req.id,
    });
    await writeAudit({
      ts: new Date().toISOString(),
      action: 'login.success',
      user: username,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      requestId: req.id,
    });

    return reply.redirect('/', 302);
  });
}
