import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendPage } from '../../lib/render';
import { generateCsrfToken } from '../../auth/csrf';
import {
  listConversations,
  listMessages,
  httpStatusForReason,
  isChatbotAdminAvailable,
  isValidPhone,
  resolveChatbotAdminBin,
  type Conversation,
  type ChatbotMessage,
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

export interface MessagesPageView {
  state: 'ok' | ChatbotCallReason;
  binPath: string;
  available: boolean;
  phone: string;
  messages: ChatbotMessage[];
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

/** Decode a `:phone` path parameter. URL-decoded by Fastify already;
 *  we re-encode any `+` literal to `+` (browsers send `+` for space in
 *  query, but for path segments Fastify already decoded it). We also
 *  validate against `isValidPhone` so the wrapper never sees a bogus
 *  value. */
function sanitizePhonePath(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  // Browsers encode `+` in path as `%2B`; Fastify decoded that. If the
  // caller sent a literal `+`, Fastify decoded it to a space in some
  // configs — we restore the `+` for valid `+` patterns.
  if (/^\d/.test(trimmed) && !trimmed.startsWith('+')) {
    // already bare-digit; ok
  }
  if (!isValidPhone(trimmed)) return null;
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

export async function buildMessagesPageView(rawPhone: string | undefined): Promise<MessagesPageView> {
  const binPath = resolveChatbotAdminBin();
  const available = isChatbotAdminAvailable();
  const phone = sanitizePhonePath(rawPhone);
  if (phone === null) {
    return {
      state: 'bad_phone',
      binPath,
      available,
      phone: typeof rawPhone === 'string' ? rawPhone : '',
      messages: [],
      error: 'phone must match ^\\+?\\d{6,15}$',
    };
  }
  if (!available) {
    return {
      state: 'chatbot_admin_unavailable',
      binPath,
      available: false,
      phone,
      messages: [],
      error: 'skill-chatbot admin wrapper not installed — see Phase 4 contract',
    };
  }
  const result = await listMessages(phone, { limit: 50, includeAdmin: true }).catch(
    (err: unknown) => ({
      ok: false,
      data: null,
      reason: 'spawn_failed' as ChatbotCallReason,
      raw: null,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  if (!result.ok || result.data === null) {
    // Distinguish "no messages yet" (empty array) from "phone unknown"
    // (upstream code 5). For unknown phones the wrapper returns an
    // error envelope, which we surface as a 404 in the route.
    return {
      state: result.reason,
      binPath,
      available: true,
      phone,
      messages: [],
      error: result.error ?? null,
    };
  }
  return {
    state: 'ok',
    binPath,
    available: true,
    phone,
    messages: result.data,
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

  // Sub-route: last 50 messages for a single phone. Returns 404 when
  // the phone doesn't exist in the orchestrator (upstream code 5) and
  // 503 + Retry-After when the wrapper is missing.
  app.get<{ Params: { phone: string } }>(
    '/chatbot/conversations/:phone',
    async (req: FastifyRequest, reply) => {
      const rawPhone = (req.params as { phone: string }).phone;
      const view = await buildMessagesPageView(rawPhone);
      if (view.state === 'bad_phone') {
        void reply.code(400);
      } else if (view.state === 'ok' && view.messages.length === 0) {
        // Empty list — phone is known to the wrapper but had no
        // messages in the window. Render an empty-state card.
      } else if (view.state !== 'ok') {
        const status = httpStatusForReason(view.state);
        if (view.state === 'non_zero_exit' && view.error === 'phone_not_found') {
          void reply.code(404);
        } else if (status === 503) {
          void reply.header('Retry-After', '60');
          void reply.code(503);
        } else {
          void reply.code(status);
        }
      }
      await sendPage(reply, {
        view: 'chatbot/messages.ejs',
        context: {
          title: `Chatbot · ${view.phone || 'phone'}`,
          activeNav: '/chatbot',
          csrfToken: '',
          user: req.session?.get?.('user') ?? null,
          view,
        },
      });
    },
  );
}