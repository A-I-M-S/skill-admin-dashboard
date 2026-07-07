import type { FastifyInstance } from 'fastify';
import { sendPage } from '../../lib/render';
import { generateCsrfToken } from '../../auth/csrf';
import { writeAudit } from '../../lib/audit';
import {
  ask,
  type RagAskResult,
  type RagCallReason,
} from '../../lib/rag-subprocess';

export interface RagSearchView {
  state:
    | 'ok'
    | 'rag_unavailable'
    | 'unreachable'
    | 'invalid_json'
    | 'spawn_failed'
    | 'invalid_input';
  question: string;
  result: RagAskResult | null;
  error: string | null;
}

export function validateQuestion(raw: string): string | null {
  const q = raw.trim();
  if (q.length === 0) return null;
  if (q.length > 1024) return null;
  return q;
}

function normalize(reason: RagCallReason): RagSearchView['state'] {
  if (reason === 'ok') return 'ok';
  if (reason === 'rag_unavailable') return 'rag_unavailable';
  if (reason === 'invalid_json') return 'invalid_json';
  if (reason === 'spawn_failed') return 'spawn_failed';
  return 'unreachable';
}

export async function registerRagSearchRoute(app: FastifyInstance): Promise<void> {
  app.get('/rag/search', async (req, reply) => {
    const csrfToken = await generateCsrfToken(reply);
    await sendPage(reply, {
      view: 'rag/search.ejs',
      context: {
        title: 'RAG · Search',
        activeNav: '/rag',
        csrfToken,
        user: req.session?.get?.('user') ?? null,
        view: { state: 'ok', question: '', result: null, error: null } satisfies RagSearchView,
        flash: null,
      },
    });
  });

  app.post('/rag/search', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawQuestion =
      typeof body['question'] === 'string' ? (body['question'] as string) : '';
    const question = validateQuestion(rawQuestion);
    if (question === null) {
      void reply.code(400);
      const csrfToken = await generateCsrfToken(reply);
      await sendPage(reply, {
        view: 'rag/search.ejs',
        context: {
          title: 'RAG · Search',
          activeNav: '/rag',
          csrfToken,
          user: req.session?.get?.('user') ?? null,
          view: {
            state: 'invalid_input',
            question: rawQuestion,
            result: null,
            error: 'question is required (1..1024 chars)',
          } satisfies RagSearchView,
          flash: null,
        },
      });
      return;
    }

    const ragResult = await ask(question, { topK: 3 });
    const actor =
      (req.session?.get?.('user') as { userId?: string } | undefined)?.userId ?? 'unknown';

    if (!ragResult.ok) {
      const reason = normalize(ragResult.reason);
      await writeAudit({
        ts: new Date().toISOString(),
        action: 'rag.search',
        user: actor,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.id,
        topK: 3,
        outcome: 'failure',
        detail: reason,
        reason: ragResult.error ?? undefined,
      }).catch(() => undefined);
      if (reason === 'rag_unavailable' || reason === 'unreachable') {
        void reply.code(503);
      } else {
        void reply.code(502);
      }
      const csrfToken = await generateCsrfToken(reply);
      await sendPage(reply, {
        view: 'rag/search.ejs',
        context: {
          title: 'RAG · Search',
          activeNav: '/rag',
          csrfToken,
          user: req.session?.get?.('user') ?? null,
          view: {
            state: reason,
            question,
            result: null,
            error: ragResult.error ?? `exit ${ragResult.raw?.code ?? '?'}`,
          } satisfies RagSearchView,
          flash: null,
        },
      });
      return;
    }

    const data = ragResult.data;
    await writeAudit({
      ts: new Date().toISOString(),
      action: 'rag.search',
      user: actor,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      requestId: req.id,
      topK: 3,
      questionHash: data?.questionHash,
      outcome: 'success',
    }).catch(() => undefined);
    const csrfToken = await generateCsrfToken(reply);
    await sendPage(reply, {
      view: 'rag/search.ejs',
      context: {
        title: 'RAG · Search',
        activeNav: '/rag',
        csrfToken,
        user: req.session?.get?.('user') ?? null,
        view: { state: 'ok', question, result: data ?? null, error: null } satisfies RagSearchView,
        flash: null,
      },
    });
  });
}
