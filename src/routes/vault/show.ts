import type { FastifyInstance } from 'fastify';
import { sendPage } from '../../lib/render';
import { get, whoami, type BinSecretMetadataItem } from '../../lib/bin-secret';
import { generateCsrfToken } from '../../auth/csrf';

export interface VaultShowView {
  state: 'ok' | 'unreachable' | 'unconfigured' | 'invalid_json' | 'spawn_failed' | 'not_found';
  whoami: {
    state: 'ok' | 'unreachable' | 'unconfigured' | 'invalid_json' | 'spawn_failed';
    backend: string | null;
    region: string | null;
    projectUrl: string | null;
    anonKeyId: string | null;
    error: string | null;
  };
  item: BinSecretMetadataItem | null;
  rawId: string;
  error: string | null;
}

const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function validateSecretId(rawId: string): string | null {
  const id = rawId.trim();
  if (id === '') return null;
  if (!ID_PATTERN.test(id)) return null;
  return id;
}

export async function buildVaultShowView(rawId: string): Promise<VaultShowView> {
  const id = validateSecretId(rawId);
  if (id === null) {
    return {
      state: 'not_found',
      whoami: {
        state: 'unconfigured',
        backend: null,
        region: null,
        projectUrl: null,
        anonKeyId: null,
        error: null,
      },
      item: null,
      rawId,
      error: 'invalid secret id',
    };
  }

  const [itemResult, whoamiResult] = await Promise.all([
    get(id).catch((err: unknown) => ({
      ok: false,
      data: null,
      reason: 'spawn_failed' as const,
      raw: null,
      error: err instanceof Error ? err.message : String(err),
    })),
    whoami().catch((err: unknown) => ({
      ok: false,
      data: null,
      reason: 'spawn_failed' as const,
      raw: null,
      error: err instanceof Error ? err.message : String(err),
    })),
  ]);

  let whoamiView: VaultShowView['whoami'];
  if (!whoamiResult.ok) {
    whoamiView = {
      state: whoamiResult.reason === 'invalid_json'
        ? 'invalid_json'
        : whoamiResult.reason === 'spawn_failed'
          ? 'spawn_failed'
          : 'unreachable',
      backend: null,
      region: null,
      projectUrl: null,
      anonKeyId: null,
      error: whoamiResult.error ?? null,
    };
  } else {
    const d = whoamiResult.data;
    whoamiView = {
      state: 'ok',
      backend: d?.backend ?? null,
      region: d?.region ?? null,
      projectUrl: d?.projectUrl ?? null,
      anonKeyId: d?.anonKeyId ?? null,
      error: null,
    };
  }

  if (!itemResult.ok) {
    return {
      state: itemResult.reason === 'invalid_json'
        ? 'invalid_json'
        : itemResult.reason === 'spawn_failed'
          ? 'spawn_failed'
          : itemResult.reason === 'non_zero_exit'
            ? 'not_found'
            : 'unreachable',
      whoami: whoamiView,
      item: null,
      rawId,
      error: itemResult.error ?? null,
    };
  }

  return {
    state: 'ok',
    whoami: whoamiView,
    item: itemResult.data,
    rawId,
    error: null,
  };
}

export async function registerVaultShowRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/vault/:id', async (req, reply) => {
    const view = await buildVaultShowView(req.params.id);
    const csrfToken = await generateCsrfToken(reply);
    await sendPage(reply, {
      view: 'vault/show.ejs',
      context: {
        title: 'Vault · ' + view.rawId,
        activeNav: '/vault',
        csrfToken,
        view,
      },
    });
  });
}
