import type { FastifyInstance } from 'fastify';
import { sendPage } from '../../lib/render';
import { list, type BinSecretMetadataItem } from '../../lib/bin-secret';
import { generateCsrfToken } from '../../auth/csrf';

export interface VaultListView {
  state: 'ok' | 'unreachable' | 'unconfigured' | 'invalid_json' | 'spawn_failed' | 'vault_unreachable' | 'non_zero_exit';
  query: string;
  items: BinSecretMetadataItem[];
  error: string | null;
}

/**
 * Filter `items` so we only return rows whose any metadata field (id / name
 * / kind / sha / tag) contains `query` (case-insensitive substring).
 * Plaintext `content` / `secret` fields are never part of the metadata we
 * store, so this filter can never match against plaintext.
 */
export function filterVaultItems(
  items: ReadonlyArray<BinSecretMetadataItem>,
  query: string,
): BinSecretMetadataItem[] {
  const trimmed = query.trim();
  if (trimmed === '') return [...items];
  const needle = trimmed.toLowerCase();
  return items.filter((item) => {
    if (item.id.toLowerCase().includes(needle)) return true;
    if (typeof item.name === 'string' && item.name.toLowerCase().includes(needle)) return true;
    if (typeof item.kind === 'string' && item.kind.toLowerCase().includes(needle)) return true;
    if (typeof item.sha === 'string' && item.sha.toLowerCase().includes(needle)) return true;
    if (item.tags && item.tags.some((t) => t.toLowerCase().includes(needle))) return true;
    return false;
  });
}

export async function buildVaultListView(query: string): Promise<VaultListView> {
  const result = await list().catch((err: unknown) => ({
    ok: false,
    data: null,
    reason: 'spawn_failed' as const,
    raw: null,
    error: err instanceof Error ? err.message : String(err),
  }));

  if (!result.ok) {
    return {
      state: result.reason,
      query,
      items: [],
      error: result.error ?? null,
    };
  }
  const items = result.data ?? [];
  return {
    state: 'ok',
    query,
    items: filterVaultItems(items, query),
    error: null,
  };
}

export async function registerVaultListRoute(app: FastifyInstance): Promise<void> {
  app.get('/vault', async (req, reply) => {
    const rawQuery = (req.query as { q?: unknown } | undefined)?.q;
    const query = typeof rawQuery === 'string' ? rawQuery : '';
    const view = await buildVaultListView(query);
    const csrfToken = await generateCsrfToken(reply);
    await sendPage(reply, {
      view: 'vault/list.ejs',
      context: {
        title: 'Vault',
        activeNav: '/vault',
        csrfToken,
        view,
      },
    });
  });
}
