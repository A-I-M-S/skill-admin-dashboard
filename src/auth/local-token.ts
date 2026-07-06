import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { ADMIN_PASSWORD, LOCAL_API_TOKEN, config } from '../config';
import { writeAudit } from '../lib/audit';

const PUBLIC_PATHS = new Set(['/login', '/healthz']);

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function extractBasicAuth(header: string | undefined): { user: string; pass: string } | null {
  if (typeof header !== 'string') return null;
  const match = /^Basic\s+([A-Za-z0-9+/=._-]+)\s*$/.exec(header);
  if (!match) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1] ?? '', 'base64').toString('utf8');
  } catch {
    return null;
  }
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  return { user: decoded.slice(0, colon), pass: decoded.slice(colon + 1) };
}

export async function registerLocalTokenFallback(app: FastifyInstance): Promise<void> {
  if (!config.localTokenAuthRequired) return;
  if (LOCAL_API_TOKEN === '') {
    app.log.warn('LOCAL_TOKEN_AUTH_REQUIRED=true but LOCAL_API_TOKEN is empty — basic-auth fallback disabled');
    return;
  }

  // The local-token fallback ONLY applies when the client presents a Basic
  // authorization header. Page-level cookie flow handles all other cases
  // (browser visits → redirect to /login; /healthz is public).
  //
  // If the client provides a valid cookie session, we skip the check too.
  app.addHook('onRequest', async (req, reply) => {
    const url = (req.url ?? '').split('?')[0] ?? '';
    if (PUBLIC_PATHS.has(url)) return;

    const sessionUser = (req.session?.get?.('user') as { userId?: string } | undefined) ?? undefined;
    if (sessionUser?.userId) return;

    const creds = extractBasicAuth(req.headers.authorization);
    if (!creds) return; // no basic auth presented → let page-level flow continue

    if (creds.user !== config.auth.basicAuthUser) {
      return unauthorizedReply(req, reply, 'user-mismatch');
    }
    // We accept either the LOCAL_API_TOKEN (preferred — rotated, scoped)
    // OR the ADMIN_PASSWORD (in case the operator only set the password).
    // Both are compared in constant time.
    const tokenOk = LOCAL_API_TOKEN !== '' && constantTimeEqual(creds.pass, LOCAL_API_TOKEN);
    const passwordOk =
      ADMIN_PASSWORD !== '' && constantTimeEqual(creds.pass, ADMIN_PASSWORD);
    if (!tokenOk && !passwordOk) {
      return unauthorizedReply(req, reply, 'credential-mismatch');
    }

    // Bind a transient session for this request so the CSRF gate and any
    // route-level checks see an authenticated user.
    req.session.set('user', {
      userId: creds.user,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      isAdmin: true,
    });

    void writeAudit({
      ts: new Date().toISOString(),
      action: 'basic-auth.fallback',
      user: creds.user,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      requestId: req.id,
    });
  });
}

function unauthorizedReply(req: FastifyRequest, reply: FastifyReply, reason: string): void {
  void writeAudit({
    ts: new Date().toISOString(),
    action: 'login.failure',
    reason: `basic-auth:${reason}`,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    requestId: req.id,
  });
  void reply
    .header('www-authenticate', 'Basic realm="skill-admin-dashboard"')
    .code(401)
    .send({ error: 'unauthorized' });
}
