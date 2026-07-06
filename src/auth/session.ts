import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ADMIN_PASSWORD, config } from '../config';
import { writeAudit } from '../lib/audit';

const ARGON2_OPTS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB — OWASP minimum for argon2id
  timeCost: 2,
  parallelism: 1,
} as const;

let cachedPasswordHash: string | null = null;

export async function getAdminPasswordHash(): Promise<string> {
  if (cachedPasswordHash !== null) return cachedPasswordHash;
  const raw = ADMIN_PASSWORD;
  if (raw === '') {
    // No admin password configured — generate an unguessable random one so the
    // /login route rejects every attempt (and the basic-auth fallback also
    // fails closed). We never log or echo this back.
    const random = randomBytes(24).toString('base64url');
    cachedPasswordHash = await argon2.hash(random, ARGON2_OPTS);
    return cachedPasswordHash;
  }
  cachedPasswordHash = await argon2.hash(raw, ARGON2_OPTS);
  return cachedPasswordHash;
}

export async function verifyAdminPassword(candidate: string): Promise<boolean> {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const hash = await getAdminPasswordHash();
  try {
    return await argon2.verify(hash, candidate);
  } catch {
    return false;
  }
}

export async function registerSession(app: FastifyInstance): Promise<void> {
  await app.register(fastifyCookie, {
    secret: config.auth.sessionSecret,
  });

  await app.register(fastifySession, {
    secret: config.auth.sessionSecret,
    cookieName: config.auth.sessionCookieName,
    cookie: {
      secure: false, // v1 binds 127.0.0.1 only — no TLS, no public exposure
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: config.auth.sessionTtlMs,
    },
    saveUninitialized: false,
    rolling: true,
    idGenerator: () => randomBytes(24).toString('base64url'),
  });
}

export interface LoginContext {
  ip: string | undefined;
  userAgent: string | undefined;
  requestId: string | undefined;
}

export async function startSession(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  ctx: LoginContext,
): Promise<void> {
  // Risk #10: rotate session id on login (anti-fixation). The plugin's
  // regenerate() generates a new sessionId, persists it, and the Set-Cookie
  // header on `reply` reflects the new id.
  await new Promise<void>((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });

  const now = new Date().toISOString();
  req.session.set('user', {
    userId,
    createdAt: now,
    lastSeenAt: now,
    isAdmin: true,
  });

  await writeAudit({
    ts: now,
    action: 'session.regenerate',
    user: userId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  });
}

export async function endSession(
  req: FastifyRequest,
  ctx: LoginContext,
): Promise<void> {
  // Capture the user id BEFORE destroy — the in-memory session is wiped
  // by the plugin's destroy() and a subsequent get() will return undefined.
  const user = req.session.get('user') as { userId?: string } | undefined;
  await new Promise<void>((resolve, reject) => {
    req.session.destroy((err) => (err ? reject(err) : resolve()));
  });
  await writeAudit({
    ts: new Date().toISOString(),
    action: 'session.destroy',
    user: user?.userId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    requestId: ctx.requestId,
  });
}

export function getSessionUserId(req: FastifyRequest): string | undefined {
  const user = req.session.get('user') as { userId?: string } | undefined;
  return user?.userId;
}

export function getSessionCookieName(): string {
  return config.auth.sessionCookieName;
}
