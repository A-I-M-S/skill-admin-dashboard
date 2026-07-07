import type { FastifyInstance } from 'fastify';
import { sendPage } from '../../lib/render';
import { generateCsrfToken } from '../../auth/csrf';
import {
  stats,
  listSources,
  type RagSourceItem,
  type RagStats,
  type RagCallReason,
} from '../../lib/rag-subprocess';

export interface RagStatsView {
  state: 'ok' | 'rag_unavailable' | 'unreachable' | 'invalid_json' | 'spawn_failed';
  stats: RagStats;
  sources: RagSourceItem[];
  error: string | null;
}

const VIEW_STATES: ReadonlySet<RagStatsView['state']> = new Set([
  'ok',
  'rag_unavailable',
  'unreachable',
  'invalid_json',
  'spawn_failed',
]);

function normalize(reason: RagCallReason): RagStatsView['state'] {
  if (reason === 'ok') return 'ok';
  if (reason === 'rag_unavailable') return 'rag_unavailable';
  if (reason === 'invalid_json') return 'invalid_json';
  if (reason === 'spawn_failed') return 'spawn_failed';
  return 'unreachable';
}

export async function buildRagStatsView(): Promise<RagStatsView> {
  const [statsResult, sourcesResult] = await Promise.all([
    stats().catch((err: unknown) => ({
      ok: false,
      data: null,
      reason: 'spawn_failed' as RagCallReason,
      raw: null,
      error: err instanceof Error ? err.message : String(err),
    })),
    listSources().catch((err: unknown) => ({
      ok: false,
      data: null,
      reason: 'spawn_failed' as RagCallReason,
      raw: null,
      error: err instanceof Error ? err.message : String(err),
    })),
  ]);

  // If EITHER call failed, surface the union reason. Stats is the
  // canonical signal — if stats is unavailable, we render 503 + a soft
  // fallback card (issue #7 acceptance criteria).
  if (!statsResult.ok) {
    const reason = normalize(statsResult.reason);
    if (!VIEW_STATES.has(reason)) {
      return { state: 'unreachable', stats: {}, sources: [], error: 'unknown state' };
    }
    return {
      state: reason,
      stats: {},
      sources: [],
      error: statsResult.error ?? null,
    };
  }

  return {
    state: 'ok',
    stats: statsResult.data ?? {},
    sources: sourcesResult.ok ? (sourcesResult.data ?? []) : [],
    error: null,
  };
}

export async function registerRagStatsRoute(app: FastifyInstance): Promise<void> {
  app.get('/rag', async (req, reply) => {
    const view = await buildRagStatsView();
    if (view.state === 'rag_unavailable' || view.state === 'unreachable') {
      void reply.code(503);
    } else if (view.state === 'invalid_json' || view.state === 'spawn_failed') {
      void reply.code(502);
    }
    const csrfToken = await generateCsrfToken(reply);
    await sendPage(reply, {
      view: 'rag/stats.ejs',
      context: {
        title: 'RAG',
        activeNav: '/rag',
        csrfToken,
        user: req.session?.get?.('user') ?? null,
        view,
      },
    });
  });
}
