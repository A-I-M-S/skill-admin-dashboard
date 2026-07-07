import { chmod, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sendPage } from '../../lib/render';
import { generateCsrfToken } from '../../auth/csrf';
import { writeAudit } from '../../lib/audit';
import { createTmpDir } from '../../lib/tmp';
import { init as binSecretInit } from '../../lib/bin-secret';

export interface VaultInitView {
  state: 'ok' | 'unreachable' | 'unconfigured' | 'invalid_json' | 'spawn_failed' | 'not_initialized';
  url: string;
  error: string | null;
}

/**
 * Constrain `url` to the Supabase KMS project URL shape. We deliberately
 * accept only https URLs — the dashboard talks only to Supabase KMS today.
 * This catches typos before they reach `bin/secret init`.
 */
const URL_PATTERN = /^https:\/\/[A-Za-z0-9._-]{1,253}\.supabase\.co\/?$/;

export function validateVaultUrl(rawUrl: string): string | null {
  const url = rawUrl.trim();
  if (url === '') return null;
  if (url.length > 256) return null;
  if (!URL_PATTERN.test(url)) return null;
  return url.replace(/\/+$/, '');
}

export function validateApiKey(rawKey: string): string | null {
  const key = rawKey.trim();
  if (key === '') return null;
  if (key.length < 16 || key.length > 4096) return null;
  // Supabase service-role / anon JWTs are base64url + dots; we accept any
  // non-whitespace token here and let `bin/secret init` validate the shape.
  if (/[\r\n\t\v\f\0]/.test(key)) return null;
  return key;
}

export function computeUrlHash(url: string): string {
  return createHash('sha256').update(url, 'utf8').digest('hex').slice(0, 12);
}

async function writeApiKeyFile(
  filePath: string,
  apiKey: string,
): Promise<void> {
  await writeFile(filePath, apiKey, { encoding: 'utf8', mode: 0o600 });
  // Best-effort chmod — writeFile mode isn't honoured on all FSes.
  await chmod(filePath, 0o600).catch(() => undefined);
}

export interface VaultInitHandlerResult {
  state: VaultInitView['state'];
  url: string;
  error: string | null;
}

export interface VaultInitDeps {
  // Optional injection hook for tests; default uses real subsystems.
  now?: () => Date;
  audit?: typeof writeAudit;
  init?: typeof binSecretInit;
}

export async function handleVaultInitPost(
  req: FastifyRequest,
  deps: VaultInitDeps = {},
): Promise<VaultInitHandlerResult> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const urlRaw = typeof body['url'] === 'string' ? (body['url'] as string) : '';
  const apiKeyRaw = typeof body['apiKey'] === 'string' ? (body['apiKey'] as string) : '';
  const confirm = body['confirm'];

  const url = validateVaultUrl(urlRaw);
  const apiKey = validateApiKey(apiKeyRaw);
  if (url === null) {
    return { state: 'invalid_json', url: urlRaw, error: 'invalid project url' };
  }
  if (apiKey === null) {
    return { state: 'invalid_json', url, error: 'invalid api key' };
  }
  if (confirm !== 'on') {
    return { state: 'invalid_json', url, error: 'confirmation required' };
  }

  const now = (deps.now ?? (() => new Date()))();
  const ts = now.toISOString();
  const urlHash = computeUrlHash(url);
  const actor =
    (req.session?.get?.('user') as { userId?: string } | undefined)?.userId ?? 'unknown';
  const audit = deps.audit ?? writeAudit;
  const initFn = deps.init ?? binSecretInit;

  // 1. Write the API key to a fresh mode-0o600 file.
  let tmp;
  try {
    tmp = await createTmpDir('vault-init-');
    const keyPath = tmp.file('key');
    await writeApiKeyFile(keyPath, apiKey);

    // 2. Invoke bin/secret init --url <url> --api-key-file <path>.
    let result;
    try {
      result = await initFn({
        url,
        apiKeyFilePath: keyPath,
        envOverrides: undefined,
      });
    } finally {
      // 3. ALWAYS delete the temp file, success or failure.
      await tmp.cleanup().catch(() => undefined);
    }

    if (!result.ok) {
      await audit({
        ts,
        action: 'vault.init',
        user: actor,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.id,
        vault: 'skill-secret',
        urlHash,
        outcome: 'failure',
        detail: result.reason,
        reason: result.error ?? undefined,
      });
      return {
        state: result.reason === 'spawn_failed'
          ? 'spawn_failed'
          : result.reason === 'invalid_json'
            ? 'invalid_json'
            : result.reason === 'non_zero_exit'
              ? 'not_initialized'
              : 'unreachable',
        url,
        error: result.error ?? `exit ${result.raw?.code ?? '?'}`,
      };
    }

    // 4. Success audit.
    await audit({
      ts,
      action: 'vault.init',
      user: actor,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      requestId: req.id,
      vault: 'skill-secret',
      urlHash,
      outcome: 'success',
    });
    return { state: 'ok', url, error: null };
  } catch (err) {
    await tmp?.cleanup().catch(() => undefined);
    await audit({
      ts,
      action: 'vault.init',
      user: actor,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      requestId: req.id,
      vault: 'skill-secret',
      urlHash,
      outcome: 'failure',
      detail: 'exception',
      reason: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
    return {
      state: 'spawn_failed',
      url,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function registerVaultInitRoute(app: FastifyInstance): Promise<void> {
  app.get('/vault/init', async (req, reply) => {
    const csrfToken = await generateCsrfToken(reply);
    const q = (req.query ?? {}) as { flash?: unknown };
    const flashMessage =
      q.flash === 'ok'
        ? 'Vault initialised.'
        : q.flash === 'fail'
          ? 'Vault init failed.'
          : null;
    await sendPage(reply, {
      view: 'vault/init.ejs',
      context: {
        title: 'Vault · Init',
        activeNav: '/vault',
        csrfToken,
        user: req.session?.get?.('user') ?? null,
        view: { state: 'ok' as const, url: '', error: null },
        flash: flashMessage,
      },
    });
  });

  app.post('/vault/init', async (req: FastifyRequest, reply: FastifyReply) => {
    const result = await handleVaultInitPost(req);
    if (result.state === 'ok') {
      return reply.redirect(303, '/vault/init?flash=ok');
    }
    if (result.state === 'invalid_json') {
      void reply.code(400);
    } else {
      void reply.code(502);
    }
    const csrfToken = await generateCsrfToken(reply);
    await sendPage(reply, {
      view: 'vault/init.ejs',
      context: {
        title: 'Vault · Init',
        activeNav: '/vault',
        csrfToken,
        user: req.session?.get?.('user') ?? null,
        view: { state: result.state, url: result.url, error: result.error } satisfies VaultInitView,
        flash: null,
      },
    });
  });
}
