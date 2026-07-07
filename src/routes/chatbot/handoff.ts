import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendPage } from '../../lib/render';
import {
  handoffQueue,
  httpStatusForReason,
  isChatbotAdminAvailable,
  resolveChatbotAdminBin,
  type HandoffEntry,
  type ChatbotCallReason,
} from '../../lib/chatbot-admin';

export interface HandoffPageView {
  state: 'ok' | ChatbotCallReason;
  binPath: string;
  available: boolean;
  queue: HandoffEntry[];
  error: string | null;
}

export async function buildHandoffPageView(): Promise<HandoffPageView> {
  const binPath = resolveChatbotAdminBin();
  const available = isChatbotAdminAvailable();
  if (!available) {
    return {
      state: 'chatbot_admin_unavailable',
      binPath,
      available: false,
      queue: [],
      error: 'skill-chatbot admin wrapper not installed — see Phase 4 contract',
    };
  }
  const result = await handoffQueue().catch((err: unknown) => ({
    ok: false,
    data: null,
    reason: 'spawn_failed' as ChatbotCallReason,
    raw: null,
    error: err instanceof Error ? err.message : String(err),
  }));
  if (!result.ok || result.data === null) {
    return {
      state: result.reason,
      binPath,
      available: true,
      queue: [],
      error: result.error ?? null,
    };
  }
  return {
    state: 'ok',
    binPath,
    available: true,
    queue: result.data,
    error: null,
  };
}

export async function registerHandoffRoute(app: FastifyInstance): Promise<void> {
  app.get('/chatbot/handoff', async (req: FastifyRequest, reply) => {
    const view = await buildHandoffPageView();
    if (view.state !== 'ok') {
      const status = httpStatusForReason(view.state);
      if (status === 503) {
        void reply.header('Retry-After', '60');
      }
      void reply.code(status);
    }
    await sendPage(reply, {
      view: 'chatbot/handoff.ejs',
      context: {
        title: 'Chatbot · Handoff queue',
        activeNav: '/chatbot',
        csrfToken: '',
        user: req.session?.get?.('user') ?? null,
        view,
      },
    });
  });
}