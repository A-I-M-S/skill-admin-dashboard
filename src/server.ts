import Fastify, { type FastifyInstance } from 'fastify';
import { HOST, LOG_LEVEL, PORT, config } from './config';
import type { CsrfToken, Session } from './types';

declare module 'fastify' {
  interface FastifyRequest {
    session?: Session;
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

  app.get('/healthz', async () => ({ ok: true }));

  return app;
}

export async function startServer(): Promise<FastifyInstance> {
  const app = await buildServer();
  await app.listen({ host: HOST, port: PORT });
  app.log.info({ host: HOST, port: PORT, readonlyMode: config.readonlyMode }, 'server listening');
  return app;
}
