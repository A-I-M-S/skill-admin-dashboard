import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendPage } from '../../lib/render';
import { generateCsrfToken } from '../../auth/csrf';
import {
  listConversations,
  httpStatusForReason,
  isChatbotAdminAvailable,
  resolveChatbotAdminBin,
  type Conversation,
  type ChatbotCallReason,
} from '../../lib/chatbot-admin';

export interface ConversationsPageView {
  state: 'ok' | ChatbotCallReason;
  binPath: string;
  available: boolean;
  conversations: Conversation[];
  phoneFilter: string;
  error: string | null;
}

/**
 * GET /chatbot/conversations?phone=659... — list active conversations
 * with an optional phone-prefix filter. The phone query string is
 * constrained to digits + leading `+` so a malformed value is rejected
 * here, not forwarded to the wrapper.
 */
const PHONE_QUERY_PATTERN = /^\+?\d{0,20}$/;

function sanitizePhoneQuery(raw: string | undefined): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  if (!PHONE_QUERY_PATTERN.test(trimmed)) return '';
  return trimmed;
}

export async function buildConversationsPageView(
  rawPhoneQuery: string | undefined,
): Promise<ConversationsPageView> {
  const binPath = resolveChatbotAdminBin();
  const available = isChatbotAdminAvailable();
  const phoneFilter = sanitizePhoneQuery(rawPhoneQuery);
  if (!available) {
    return {
      state: 'chatbot_admin_unavailable',
      binPath,
      available: false,
      conversations: [],
      phoneFilter,
      error: 'skill-chatbot admin wrapper not installed — see Phase 4 contract',
    };
  }
  const opts = phoneFilter === '' ? {} : { phonePrefix: phoneFilter };
  const result = await listConversations(opts).catch((err: unknown) => ({
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
      conversations: [],
      phoneFilter,
      error: result.error ?? null,
    };
  }
  return {
    state: 'ok',
    binPath,
    available: true,
    conversations: result.data,
    phoneFilter,
    error: null,
  };
}

export async function registerConversationsRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { phone?: string } }>(
    '/chatbot/conversations',
    async (req: FastifyRequest, reply) => {
      const view = await buildConversationsPageView(
        (req.query as { phone?: string }).phone,
      );
      if (view.state !== 'ok') {
        const status = httpStatusForReason(view.state);
        if (status === 503) {
          void reply.header('Retry-After', '60');
        }
        void reply.code(status);
      }
      const csrfToken = view.state === 'ok' ? await generateCsrfToken(reply) : '';
      await sendPage(reply, {
        view: 'chatbot/conversations.ejs',
        context: {
          title: 'Chatbot · Conversations',
          activeNav: '/chatbot',
          csrfToken,
          user: req.session?.get?.('user') ?? null,
          view,
        },
      });
    },
  );
}