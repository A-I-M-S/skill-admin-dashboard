import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { generateCsrfToken } from '../auth/csrf';
import { list as binSecretList, whoami, type BinSecretListItem } from '../lib/bin-secret';
import { cronList, sessionsList } from '../lib/openclaw-bin';
import { sendPage } from '../lib/render';

export interface IndexStatusView {
  vault: {
    state: 'ok' | 'unreachable' | 'unconfigured' | 'invalid_json';
    backend: string | null;
    region: string | null;
    projectUrl: string | null;
    anonKeyId: string | null;
    error: string | null;
  };
  recentSecrets: {
    state: 'ok' | 'unreachable' | 'invalid_json';
    items: BinSecretListItem[];
    error: string | null;
  };
  cron: {
    state: 'ok' | 'unreachable' | 'invalid_json';
    count: number;
    error: string | null;
  };
  agents: {
    state: 'ok' | 'unreachable' | 'invalid_json';
    count: number;
    error: string | null;
  };
  binSecretPath: string;
}

export async function buildIndexStatus(): Promise<IndexStatusView> {
  const [whoamiResult, listResult, cronResult, sessionsResult] = await Promise.all([
    whoami().catch((err: unknown) => ({
      ok: false,
      data: null,
      reason: 'spawn_failed' as const,
      raw: null,
      error: err instanceof Error ? err.message : String(err),
    })),
    binSecretList().catch((err: unknown) => ({
      ok: false,
      data: null,
      reason: 'spawn_failed' as const,
      raw: null,
      error: err instanceof Error ? err.message : String(err),
    })),
    cronList().catch((err: unknown) => ({
      ok: false,
      data: null,
      reason: 'spawn_failed' as const,
      raw: null,
      error: err instanceof Error ? err.message : String(err),
    })),
    sessionsList().catch((err: unknown) => ({
      ok: false,
      data: null,
      reason: 'spawn_failed' as const,
      raw: null,
      error: err instanceof Error ? err.message : String(err),
    })),
  ]);

  const vaultConfigured = config.skillSecret.kmsBackend !== undefined;

  let vaultView: IndexStatusView['vault'];
  if (!vaultConfigured) {
    vaultView = {
      state: 'unconfigured',
      backend: null,
      region: null,
      projectUrl: null,
      anonKeyId: null,
      error: null,
    };
  } else if (whoamiResult.ok && whoamiResult.data) {
    vaultView = {
      state: 'ok',
      backend: whoamiResult.data.backend ?? config.skillSecret.kmsBackend ?? null,
      region: whoamiResult.data.region ?? null,
      projectUrl: whoamiResult.data.projectUrl ?? null,
      anonKeyId: whoamiResult.data.anonKeyId ?? null,
      error: null,
    };
  } else if (whoamiResult.reason === 'invalid_json') {
    vaultView = {
      state: 'invalid_json',
      backend: config.skillSecret.kmsBackend ?? null,
      region: null,
      projectUrl: null,
      anonKeyId: null,
      error: whoamiResult.error ?? null,
    };
  } else {
    vaultView = {
      state: 'unreachable',
      backend: config.skillSecret.kmsBackend ?? null,
      region: null,
      projectUrl: null,
      anonKeyId: null,
      error: whoamiResult.error ?? null,
    };
  }

  let recentSecrets: IndexStatusView['recentSecrets'];
  if (listResult.ok && listResult.data) {
    const items = (listResult.data.items ?? []).slice();
    items.sort((a, b) => {
      const am = a.mtime ? Date.parse(a.mtime) : 0;
      const bm = b.mtime ? Date.parse(b.mtime) : 0;
      return bm - am;
    });
    recentSecrets = {
      state: 'ok',
      items: items.slice(0, 5),
      error: null,
    };
  } else if (listResult.reason === 'invalid_json') {
    recentSecrets = {
      state: 'invalid_json',
      items: [],
      error: listResult.error ?? null,
    };
  } else {
    recentSecrets = {
      state: 'unreachable',
      items: [],
      error: listResult.error ?? null,
    };
  }

  let cronView: IndexStatusView['cron'];
  if (cronResult.ok && cronResult.data) {
    const jobs = cronResult.data.jobs ?? [];
    cronView = {
      state: 'ok',
      count: jobs.length,
      error: null,
    };
  } else if (cronResult.reason === 'invalid_json') {
    cronView = { state: 'invalid_json', count: 0, error: cronResult.error ?? null };
  } else {
    cronView = { state: 'unreachable', count: 0, error: cronResult.error ?? null };
  }

  let agentsView: IndexStatusView['agents'];
  if (sessionsResult.ok && sessionsResult.data) {
    const sessions = sessionsResult.data.sessions ?? [];
    agentsView = { state: 'ok', count: sessions.length, error: null };
  } else if (sessionsResult.reason === 'invalid_json') {
    agentsView = { state: 'invalid_json', count: 0, error: sessionsResult.error ?? null };
  } else {
    agentsView = { state: 'unreachable', count: 0, error: sessionsResult.error ?? null };
  }

  return {
    vault: vaultView,
    recentSecrets,
    cron: cronView,
    agents: agentsView,
    binSecretPath: config.skillSecret.binPath,
  };
}

export async function registerIndexRoute(app: FastifyInstance): Promise<void> {
  app.get('/', async (req, reply) => {
    const user = (req.session?.get?.('user') as { userId?: string } | undefined) ?? undefined;
    const csrfToken = await generateCsrfToken(reply);
    const status = await buildIndexStatus();
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
        status,
      },
    });
  });
}
