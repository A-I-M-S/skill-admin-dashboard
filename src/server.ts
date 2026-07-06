import fastifyFormbody from '@fastify/formbody';
import Fastify, { type FastifyInstance } from 'fastify';
import { HOST, LOG_LEVEL, config } from './config';
import { registerCsrf } from './auth/csrf';
import { registerLocalTokenFallback } from './auth/local-token';
import { registerSession } from './auth/session';
import { requireAuthForPages } from './lib/render';
import { registerIndexRoute } from './routes/index';
import { registerLoginRoutes } from './routes/login';
import { registerLogoutRoutes } from './routes/logout';
import type { CsrfToken } from './types';

declare module 'fastify' {
  // @fastify/session already augments FastifyRequest with `session` and
  // `sessionStore`; we add our own `csrfToken` decorator for convenience.
  interface FastifyRequest {
    csrfToken?: CsrfToken;
  }
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.cookie',
          'req.headers.authorization',
          'req.body.cookie',
          'req.body.authorization',
          'req.body.apiKey',
          'req.body.passphrase',
          'req.body.token',
          'req.body.password',
          'req.body.username',
          '*.apiKey',
          '*.passphrase',
          '*.token',
        ],
        censor: '[REDACTED]',
      },
      ...(config.nodeEnv !== 'production'
        ? {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
            },
          }
        : {}),
    },
    disableRequestLogging: false,
    bodyLimit: 10 * 1024 * 1024,
    trustProxy: false,
  });

  await app.register(fastifyFormbody);

  // Order matters: cookie → session → csrf → local-token fallback → routes.
  await registerSession(app);
  await registerCsrf(app);
  await registerLocalTokenFallback(app);

  // Public probes that must work even when the user is unauthenticated.
  app.get('/healthz', async () => ({ ok: true }));

  // Page-level auth gate: unauthenticated GETs redirect to /login.
  app.addHook('preHandler', requireAuthForPages());

  await registerIndexRoute(app);
  await registerLoginRoutes(app);
  await registerLogoutRoutes(app);

  return app;
}

export async function startServer(): Promise<FastifyInstance> {
  const app = await buildServer();
  await app.listen({ host: HOST, port: config.port });
  app.log.info(
    { host: HOST, port: config.port, readonlyMode: config.readonlyMode },
    'server listening',
  );
  return app;
}
