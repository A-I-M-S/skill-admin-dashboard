import { existsSync } from 'node:fs';
import { config } from '../config';
import { runSubprocess, SpawnError, type SpawnResult } from './subprocess';

/**
 * `lib/chatbot-admin.ts` — wraps the `bin/chatbot-admin` dispatcher in
 * the sibling `skill-chatbot` project (Phase 4 contract). Mirrors
 * `lib/bin-secret.ts` + `lib/rag-subprocess.ts` for consistency.
 *
 * When the wrapper script is missing, every function returns
 * `{ ok: false, code: 4, error: 'chatbot_admin_unavailable' }` and the
 * route layer translates that into a 503 with `Retry-After: 60`.
 *
 * The wrapper inherits its env from the dashboard's own env
 * (`process.env`) — never from the request body. The dashboard's
 * systemd `EnvironmentFile=` is the source of truth for
 * `CHATBOT_REPO`, `ORCHESTRATOR_DB`, `WA_BRIDGE_URL`, `WA_BRIDGE_TOKEN`,
 * `WA_NOTIFY`, `ADMIN_CONTACT_NUMBER`, `CHATBOT_ADMIN_ACTOR`.
 *
 * See `docs/plans/phase-4-chatbot-contract.md` for the wire contract.
 */

export interface Conversation {
  phone: string;
  lastMessageId: string | null;
  lastMessageAt: string | null;
  lastImage: string | null;
  flow: string;
  language: string | null;
  messageCount24h: number;
  handoffOpen: boolean;
  handoffReason: string | null;
  handoffSince: string | null;
}

export interface ChatbotMessage {
  messageId: string;
  direction: 'inbound' | 'outbound' | 'admin_send';
  text: string;
  image: string | null;
  timestamp: string;
  tool: string | null;
  flowAtSend: string | null;
  isFallback: boolean;
  isAdmin: boolean;
}

export interface HandoffEntry {
  phone: string;
  reason: string;
  summary: string;
  since: string;
  isFallback: boolean;
  lastMessageAt: string | null;
  language: string | null;
}

export interface AdminSendResult {
  messageId: string;
  sentAt: string;
  actor: string;
  auditRef: string;
}

export type ChatbotCallReason =
  | 'ok'
  | 'chatbot_admin_unavailable'
  | 'invalid_json'
  | 'non_zero_exit'
  | 'spawn_failed'
  | 'bad_phone'
  | 'bridge_unreachable';

export interface ChatbotCallResult<T> {
  ok: boolean;
  data: T | null;
  reason: ChatbotCallReason;
  raw: SpawnResult | null;
  error?: string;
  /** Mirror of the upstream `code` field for error envelopes. */
  upstreamCode?: number;
}

export interface ChatbotCallOptions {
  timeoutMs?: number;
  envOverrides?: NodeJS.ProcessEnv;
  /** When true, do NOT log stdout — used by admin-send which carries
   *  the customer-bound text. */
  sensitive?: boolean;
}

function buildChatbotEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...(overrides ?? {}) };
}

export function resolveChatbotAdminBin(): string {
  const fromEnv = (process.env.CHATBOT_ADMIN_BIN ?? '').trim();
  if (fromEnv !== '') return fromEnv;
  return config.chatbotAdmin.binPath;
}

export function isChatbotAdminAvailable(): boolean {
  return existsSync(resolveChatbotAdminBin());
}

function unavailableResult<T>(
  reason: ChatbotCallReason = 'chatbot_admin_unavailable',
): ChatbotCallResult<T> {
  return {
    ok: false,
    data: null,
    reason,
    raw: null,
    error: 'skill-chatbot admin wrapper not installed — see Phase 4 contract',
  };
}

function isSpawnError(err: unknown): err is SpawnError {
  return err instanceof SpawnError;
}

function interpretUpstreamError(code: number): ChatbotCallReason {
  switch (code) {
    case 1:
      return 'non_zero_exit';
    case 2:
      return 'bad_phone';
    case 3:
      return 'bridge_unreachable';
    case 4:
      return 'invalid_json';
    case 5:
      return 'non_zero_exit';
    default:
      return 'non_zero_exit';
  }
}

async function callChatbot<T>(
  args: string[],
  options: ChatbotCallOptions = {},
): Promise<ChatbotCallResult<T>> {
  if (!isChatbotAdminAvailable()) {
    return unavailableResult<T>();
  }
  const bin = resolveChatbotAdminBin();
  const env = buildChatbotEnv(options.envOverrides);
  const fullArgs = [...args, '--json'];
  let result: SpawnResult;
  try {
    result = await runSubprocess(bin, {
      args: fullArgs,
      env,
      timeoutMs: options.timeoutMs ?? 10_000,
    });
  } catch (err) {
    if (isSpawnError(err)) {
      return {
        ok: false,
        data: null,
        reason: 'spawn_failed',
        raw: err.result,
        error: err.message,
      };
    }
    return {
      ok: false,
      data: null,
      reason: 'spawn_failed',
      raw: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (result.code !== 0 || result.timedOut) {
    const stdout = result.stdout.trim();
    let parsedCode: number | undefined;
    let parsedError: string | undefined;
    if (stdout !== '') {
      try {
        const parsed = JSON.parse(stdout) as { code?: number; error?: string };
        if (typeof parsed.code === 'number') parsedCode = parsed.code;
        if (typeof parsed.error === 'string') parsedError = parsed.error;
      } catch {
        // fallthrough
      }
    }
    return {
      ok: false,
      data: null,
      reason: stdout === '' ? 'chatbot_admin_unavailable' : interpretUpstreamError((parsedCode ?? result.code) ?? 1),
      raw: result,
      error: parsedError ?? (result.stderr.trim() || `exit ${result.code}`),
      upstreamCode: parsedCode,
    };
  }

  const trimmed = result.stdout.trim();
  if (trimmed === '') {
    return { ok: false, data: null, reason: 'chatbot_admin_unavailable', raw: result };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      data: null,
      reason: 'invalid_json',
      raw: result,
      error: 'chatbot-admin output was not valid JSON',
    };
  }
  if (parsed['ok'] === false) {
    const upstreamCode = typeof parsed['code'] === 'number' ? (parsed['code'] as number) : 1;
    return {
      ok: false,
      data: null,
      reason: interpretUpstreamError(upstreamCode),
      raw: result,
      error: typeof parsed['error'] === 'string' ? (parsed['error'] as string) : undefined,
      upstreamCode,
    };
  }
  return {
    ok: true,
    data: parsed as unknown as T,
    reason: 'ok',
    raw: result,
  };
}

// Phone validation mirrors the upstream contract: ^\+?\d{6,15}$.
const PHONE_PATTERN = /^\+?\d{6,15}$/;
export function isValidPhone(raw: string): boolean {
  return PHONE_PATTERN.test(raw.trim());
}

// --- list-conversations -----------------------------------------------------

function projectConversation(raw: Record<string, unknown>): Conversation {
  const phone =
    typeof raw['phone'] === 'string' && (raw['phone'] as string).length > 0
      ? (raw['phone'] as string)
      : '';
  return {
    phone,
    lastMessageId:
      typeof raw['last_message_id'] === 'string' ? (raw['last_message_id'] as string) : null,
    lastMessageAt:
      typeof raw['last_message_at'] === 'string' ? (raw['last_message_at'] as string) : null,
    lastImage: typeof raw['last_image'] === 'string' ? (raw['last_image'] as string) : null,
    flow: typeof raw['flow'] === 'string' ? (raw['flow'] as string) : 'idle',
    language: typeof raw['language'] === 'string' ? (raw['language'] as string) : null,
    messageCount24h:
      typeof raw['message_count_24h'] === 'number' &&
      Number.isFinite(raw['message_count_24h'])
        ? Math.max(0, Math.floor(raw['message_count_24h'] as number))
        : 0,
    handoffOpen: raw['handoff_open'] === true,
    handoffReason:
      typeof raw['handoff_reason'] === 'string' ? (raw['handoff_reason'] as string) : null,
    handoffSince:
      typeof raw['handoff_since'] === 'string' ? (raw['handoff_since'] as string) : null,
  };
}

export interface ListConversationsOptions {
  limit?: number;
  phonePrefix?: string;
  activeWithinMin?: number;
}

export async function listConversations(
  options: ListConversationsOptions = {},
): Promise<ChatbotCallResult<Conversation[]>> {
  const args: string[] = ['list-conversations'];
  if (typeof options.limit === 'number') {
    args.push('--limit', String(Math.max(1, Math.min(500, Math.floor(options.limit)))));
  }
  if (typeof options.phonePrefix === 'string' && options.phonePrefix !== '') {
    args.push('--phone-prefix', options.phonePrefix);
  }
  if (typeof options.activeWithinMin === 'number') {
    args.push(
      '--active-within-min',
      String(Math.max(1, Math.floor(options.activeWithinMin))),
    );
  }
  const result = await callChatbot<{ conversations?: unknown[]; count?: number }>(args, {
    timeoutMs: 10_000,
  });
  if (!result.ok || result.data === null) {
    return { ...result, data: null };
  }
  const raw = Array.isArray(result.data.conversations)
    ? (result.data.conversations as unknown[])
    : [];
  const conversations: Conversation[] = raw
    .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
    .map(projectConversation)
    .filter((c) => c.phone !== '');
  return {
    ok: true,
    reason: 'ok',
    raw: result.raw,
    data: conversations,
  };
}

// --- list-messages ---------------------------------------------------------

function projectMessage(raw: Record<string, unknown>): ChatbotMessage {
  const directionRaw = typeof raw['direction'] === 'string' ? (raw['direction'] as string) : '';
  const direction: ChatbotMessage['direction'] =
    directionRaw === 'inbound' ||
    directionRaw === 'outbound' ||
    directionRaw === 'admin_send'
      ? (directionRaw as ChatbotMessage['direction'])
      : 'outbound';
  return {
    messageId:
      typeof raw['message_id'] === 'string' && (raw['message_id'] as string).length > 0
        ? (raw['message_id'] as string)
        : 'unknown',
    direction,
    text: typeof raw['text'] === 'string' ? (raw['text'] as string) : '',
    image: typeof raw['image'] === 'string' ? (raw['image'] as string) : null,
    timestamp: typeof raw['timestamp'] === 'string' ? (raw['timestamp'] as string) : '',
    tool: typeof raw['tool'] === 'string' ? (raw['tool'] as string) : null,
    flowAtSend: typeof raw['flow_at_send'] === 'string' ? (raw['flow_at_send'] as string) : null,
    isFallback: raw['is_fallback'] === true,
    isAdmin: raw['is_admin'] === true,
  };
}

export interface ListMessagesOptions {
  limit?: number;
  includeAdmin?: boolean;
}

export async function listMessages(
  phone: string,
  options: ListMessagesOptions = {},
): Promise<ChatbotCallResult<ChatbotMessage[]>> {
  if (!isValidPhone(phone)) {
    return {
      ok: false,
      data: null,
      reason: 'bad_phone',
      raw: null,
      error: 'phone must match ^\\+?\\d{6,15}$',
    };
  }
  const args: string[] = ['list-messages', phone.trim()];
  if (typeof options.limit === 'number') {
    args.push('--limit', String(Math.max(1, Math.min(500, Math.floor(options.limit)))));
  }
  if (options.includeAdmin === true) args.push('--include-admin', '1');
  const result = await callChatbot<{ messages?: unknown[] }>(args, {
    timeoutMs: 10_000,
  });
  if (!result.ok || result.data === null) {
    return { ...result, data: null };
  }
  const raw = Array.isArray(result.data.messages) ? (result.data.messages as unknown[]) : [];
  const messages = raw
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
    .map(projectMessage);
  return {
    ok: true,
    reason: 'ok',
    raw: result.raw,
    data: messages,
  };
}

// --- handoff-queue ---------------------------------------------------------

function projectHandoff(raw: Record<string, unknown>): HandoffEntry {
  return {
    phone: typeof raw['phone'] === 'string' ? (raw['phone'] as string) : '',
    reason: typeof raw['reason'] === 'string' ? (raw['reason'] as string) : '',
    summary: typeof raw['summary'] === 'string' ? (raw['summary'] as string) : '',
    since: typeof raw['since'] === 'string' ? (raw['since'] as string) : '',
    isFallback: raw['is_fallback'] === true,
    lastMessageAt:
      typeof raw['last_message_at'] === 'string' ? (raw['last_message_at'] as string) : null,
    language: typeof raw['language'] === 'string' ? (raw['language'] as string) : null,
  };
}

export interface HandoffQueueOptions {
  includeResolved?: boolean;
}

export async function handoffQueue(
  options: HandoffQueueOptions = {},
): Promise<ChatbotCallResult<HandoffEntry[]>> {
  const args: string[] = ['handoff-queue'];
  if (options.includeResolved === true) args.push('--include-resolved', '1');
  const result = await callChatbot<{ queue?: unknown[] }>(args, {
    timeoutMs: 10_000,
  });
  if (!result.ok || result.data === null) {
    return { ...result, data: null };
  }
  const raw = Array.isArray(result.data.queue) ? (result.data.queue as unknown[]) : [];
  const queue = raw
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map(projectHandoff)
    .filter((e) => e.phone !== '');
  return {
    ok: true,
    reason: 'ok',
    raw: result.raw,
    data: queue,
  };
}

// --- admin-send ------------------------------------------------------------

export interface AdminSendOptions {
  actor: string;
  replyTo?: string;
  timeoutMs?: number;
}

export async function adminSend(
  phone: string,
  text: string,
  options: AdminSendOptions,
): Promise<ChatbotCallResult<AdminSendResult>> {
  if (!isValidPhone(phone)) {
    return {
      ok: false,
      data: null,
      reason: 'bad_phone',
      raw: null,
      error: 'phone must match ^\\+?\\d{6,15}$',
    };
  }
  if (typeof text !== 'string' || text.length === 0) {
    return {
      ok: false,
      data: null,
      reason: 'bad_phone',
      raw: null,
      error: 'text must be a non-empty string',
    };
  }
  if (text.length > 4096) {
    return {
      ok: false,
      data: null,
      reason: 'bad_phone',
      raw: null,
      error: 'text must be at most 4096 characters',
    };
  }
  if (!options.actor || options.actor.trim() === '') {
    return {
      ok: false,
      data: null,
      reason: 'non_zero_exit',
      raw: null,
      error: 'actor is required',
    };
  }
  const args: string[] = ['admin-send', phone.trim(), '--text', text, '--actor', options.actor];
  if (options.replyTo) args.push('--reply-to', options.replyTo);
  // Sensitive: stdout (and any echoed text) must never be logged.
  const result = await callChatbot<Record<string, unknown>>(args, {
    timeoutMs: options.timeoutMs ?? 30_000,
    sensitive: true,
  });
  if (!result.ok || result.data === null) {
    return { ...result, data: null };
  }
  const r = result.data;
  return {
    ok: true,
    reason: 'ok',
    raw: result.raw,
    data: {
      messageId:
        typeof r['message_id'] === 'string' ? (r['message_id'] as string) : '',
      sentAt: typeof r['sent_at'] === 'string' ? (r['sent_at'] as string) : new Date().toISOString(),
      actor: typeof r['actor'] === 'string' ? (r['actor'] as string) : options.actor,
      auditRef: typeof r['audit_ref'] === 'string' ? (r['audit_ref'] as string) : '',
    },
  };
}

/** Map a reason to an HTTP status code the route layer can use. */
export function httpStatusForReason(reason: ChatbotCallReason): number {
  if (reason === 'ok') return 200;
  if (reason === 'chatbot_admin_unavailable') return 503;
  if (reason === 'bad_phone') return 400;
  if (reason === 'invalid_json') return 502;
  if (reason === 'bridge_unreachable') return 502;
  return 502;
}