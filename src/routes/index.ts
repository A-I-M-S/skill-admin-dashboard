import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { generateCsrfToken } from '../auth/csrf';
import { sendPage } from '../lib/render';

export async function registerIndexRoute(app: FastifyInstance): Promise<void> {
  app.get('/', async (req, reply) => {
    const user = (req.session?.get?.('user') as { userId?: string } | undefined) ?? undefined;
    const csrfToken = await generateCsrfToken(reply);
    return sendPage(reply, {
      view: 'index.ejs',
      context: {
        title: 'Overview',
        user: user ? { userId: user.userId ?? '' } : null,
        csrfToken,
        activeNav: '/',
        readonlyMode: config.readonlyMode,
        approvalActionsEnabled: config.approvalActionsEnabled,
        importMutationEnabled: config.importMutationEnabled,
      },
    });
  });
}
