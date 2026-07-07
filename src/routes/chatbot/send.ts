import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sendPage } from '../../lib/render';
import { generateCsrfToken } from '../../auth/csrf';
import {
  adminSend,
  httpStatusForReason,
  isChatbotAdminAvailable,
  isValidPhone,
  resolveChatbotAdminBin,
  type ChatbotCallReason,
} from '../../lib/chatbot-admin';
import { writeAudit, type AuditAction } from '../../lib/audit';
import { hashPhoneForAudit } from '../../lib/phone-hash';

export interface SendFormView {
  state: 'ok' | ChatbotCallReason | 'invalid_form';
  binPath: string;
  available: boolean;
  phone: string;
  text: string;
  replyTo: string;
  confirm: boolean;
  flash: string | null;
  error: string | null;
  csrfToken: string;
}

const MAX_TEXT_LEN = 4096;

function sanitizePhoneInput(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

function sanitizeTextInput(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw;
}

function sanitizeReplyToInput(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // Free-form inbound message_id reference. Constrain to a sane charset
  // so the page never echoes an attacker-controlled string unfiltered.
  return raw.trim().slice(0, 128);
}

function sanitizeConfirmInput(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
  }
  return false;
}

export async function buildEmptySendView(csrfToken: string): Promise<SendFormView> {
  return {
    state: 'ok',
    binPath: resolveChatbotAdminBin(),
    available: isChatbotAdminAvailable(),
    phone: '',
    text: '',
    replyTo: '',
    confirm: false,
    flash: null,
    error: null,
    csrfToken,
  };
}

interface SubmitDeps {
  actor: string;
  ip: string;
  userAgent: string | undefined;
  requestId: string;
  now: () => Date;
}

async function writeSendAudit(
  outcome: 'success' | 'failure',
  phone: string,
  textLength: number,
  reason: string | undefined,
  auditRef: string | undefined,
  bridgeMessageId: string | undefined,
  deps: SubmitDeps,
): Promise<void> {
  await writeAudit({
    ts: deps.now().toISOString(),
    action: 'chatbot.send' as AuditAction,
    user: deps.actor,
    ip: deps.ip,
    userAgent: deps.userAgent,
    requestId: deps.requestId,
    // PRIVACY: only the hash of the phone, never the raw phone.
    phoneHash: hashPhoneForAudit(phone),
    length: textLength,
    outcome,
    reason,
    detail:
      auditRef || bridgeMessageId
        ? `${bridgeMessageId ? `bridge_id=${bridgeMessageId}` : ''}${auditRef ? ` audit_ref=${auditRef}` : ''}`.trim()
        : undefined,
  }).catch(() => undefined);
}

export async function registerSendRoute(app: FastifyInstance): Promise<void> {
  // GET — render the form.
  app.get('/chatbot/send', async (req: FastifyRequest, reply) => {
    const csrfToken = await generateCsrfToken(reply);
    const view = await buildEmptySendView(csrfToken);
    if (!view.available) void reply.code(503);
    await sendPage(reply, {
      view: 'chatbot/send.ejs',
      context: {
        title: 'Chatbot · Admin send',
        activeNav: '/chatbot',
        csrfToken,
        user: req.session?.get?.('user') ?? null,
        view,
      },
    });
  });

  // POST — CSRF-gated (the global hook enforces this), audit-logged,
  // then dispatches to `bin/chatbot-admin admin-send`. The text body
  // is NEVER logged (privacy: customer-bound text).
  app.post('/chatbot/send', async (req: FastifyRequest, reply: FastifyReply) => {
    const csrfToken = await generateCsrfToken(reply);
    const body = (req.body as Record<string, unknown>) ?? {};
    const phone = sanitizePhoneInput(body['phone']);
    const text = sanitizeTextInput(body['text']);
    const replyTo = sanitizeReplyToInput(body['replyTo']);
    const confirm = sanitizeConfirmInput(body['confirm']);

    const actor =
      (req.session?.get?.('user') as { userId?: string } | undefined)?.userId ?? 'unknown';
    const deps: SubmitDeps = {
      actor,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      requestId: req.id,
      now: () => new Date(),
    };

    // Form validation (also runs before any subprocess call).
    if (!confirm) {
      const view: SendFormView = {
        state: 'invalid_form',
        binPath: resolveChatbotAdminBin(),
        available: isChatbotAdminAvailable(),
        phone,
        text,
        replyTo,
        confirm: false,
        flash: null,
        error: 'You must tick the "confirm" checkbox to send an admin message.',
        csrfToken,
      };
      void reply.code(400);
      await sendPage(reply, {
        view: 'chatbot/send.ejs',
        context: {
          title: 'Chatbot · Admin send',
          activeNav: '/chatbot',
          csrfToken,
          user: req.session?.get?.('user') ?? null,
          view,
        },
      });
      return;
    }
    if (!isValidPhone(phone)) {
      const view: SendFormView = {
        state: 'invalid_form',
        binPath: resolveChatbotAdminBin(),
        available: isChatbotAdminAvailable(),
        phone,
        text,
        replyTo,
        confirm,
        flash: null,
        error: 'Phone number must match ^\\+?\\d{6,15}$',
        csrfToken,
      };
      void reply.code(400);
      await sendPage(reply, {
        view: 'chatbot/send.ejs',
        context: {
          title: 'Chatbot · Admin send',
          activeNav: '/chatbot',
          csrfToken,
          user: req.session?.get?.('user') ?? null,
          view,
        },
      });
      return;
    }
    if (text.length === 0) {
      const view: SendFormView = {
        state: 'invalid_form',
        binPath: resolveChatbotAdminBin(),
        available: isChatbotAdminAvailable(),
        phone,
        text,
        replyTo,
        confirm,
        flash: null,
        error: 'Message body is required.',
        csrfToken,
      };
      void reply.code(400);
      await sendPage(reply, {
        view: 'chatbot/send.ejs',
        context: {
          title: 'Chatbot · Admin send',
          activeNav: '/chatbot',
          csrfToken,
          user: req.session?.get?.('user') ?? null,
          view,
        },
      });
      return;
    }
    if (text.length > MAX_TEXT_LEN) {
      const view: SendFormView = {
        state: 'invalid_form',
        binPath: resolveChatbotAdminBin(),
        available: isChatbotAdminAvailable(),
        phone,
        text: text.slice(0, MAX_TEXT_LEN),
        replyTo,
        confirm,
        flash: null,
        error: `Message body must be at most ${MAX_TEXT_LEN} characters.`,
        csrfToken,
      };
      void reply.code(400);
      await sendPage(reply, {
        view: 'chatbot/send.ejs',
        context: {
          title: 'Chatbot · Admin send',
          activeNav: '/chatbot',
          csrfToken,
          user: req.session?.get?.('user') ?? null,
          view,
        },
      });
      return;
    }
    if (!isChatbotAdminAvailable()) {
      const view: SendFormView = {
        state: 'chatbot_admin_unavailable',
        binPath: resolveChatbotAdminBin(),
        available: false,
        phone,
        text,
        replyTo,
        confirm,
        flash: null,
        error: 'skill-chatbot admin wrapper not installed — see Phase 4 contract',
        csrfToken,
      };
      await writeSendAudit('failure', phone, text.length, 'wrapper_missing', undefined, undefined, deps);
      void reply.header('Retry-After', '60');
      void reply.code(503);
      await sendPage(reply, {
        view: 'chatbot/send.ejs',
        context: {
          title: 'Chatbot · Admin send',
          activeNav: '/chatbot',
          csrfToken,
          user: req.session?.get?.('user') ?? null,
          view,
        },
      });
      return;
    }

    const result = await adminSend(phone, text, {
      actor,
      replyTo: replyTo === '' ? undefined : replyTo,
      timeoutMs: 30_000,
    }).catch((err: unknown) => ({
      ok: false,
      data: null,
      reason: 'spawn_failed' as ChatbotCallReason,
      raw: null,
      error: err instanceof Error ? err.message : String(err),
    }));

    if (!result.ok || result.data === null) {
      await writeSendAudit(
        'failure',
        phone,
        text.length,
        result.error ?? result.reason,
        undefined,
        undefined,
        deps,
      );
      const status = httpStatusForReason(result.reason);
      if (status === 503) void reply.header('Retry-After', '60');
      const view: SendFormView = {
        state: result.reason,
        binPath: resolveChatbotAdminBin(),
        available: true,
        phone,
        text,
        replyTo,
        confirm,
        flash: null,
        error: result.error ?? `chatbot send failed (${result.reason})`,
        csrfToken,
      };
      void reply.code(status);
      await sendPage(reply, {
        view: 'chatbot/send.ejs',
        context: {
          title: 'Chatbot · Admin send',
          activeNav: '/chatbot',
          csrfToken,
          user: req.session?.get?.('user') ?? null,
          view,
        },
      });
      return;
    }

    // Success. Audit BEFORE the side-effect? The side-effect already
    // happened (the wrapper posted to wa-bridge); we audit immediately
    // after so the dashboard's record is in lockstep with reality.
    await writeSendAudit(
      'success',
      phone,
      text.length,
      undefined,
      result.data.auditRef,
      result.data.messageId,
      deps,
    );

    void reply.code(303);
    return reply.redirect('/chatbot/send?ok=1');
  });
}