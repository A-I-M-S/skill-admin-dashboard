import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { sendPage } from '../../lib/render';
import {
  sessionsList,
  resolveOpenclawToolPath,
  type OpenClawCallResult,
} from '../../lib/openclaw-bin';

export interface SessionView {
  key: string;
  kind: string;
  channel: string;
  lastMessage: string;
  startedAt: string | null;
  updatedAt: string | null;
  transcriptPath: string | null;
  deepLink: string | null;
}

export interface SessionsListView {
  state: 'ok' | 'unreachable' | 'invalid_json' | 'spawn_failed';
  binPath: string | null;
  sessions: SessionView[];
  error: string | null;
}

const KIND_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function sanitizeKind(raw: string | undefined): string {
  if (typeof raw !== 'string') return 'agent';
  const trimmed = raw.trim();
  if (trimmed === '') return 'agent';
  if (!KIND_PATTERN.test(trimmed)) return 'agent';
  return trimmed;
}

function sanitizeChannel(raw: string | undefined): string {
  if (typeof raw !== 'string') return 'unknown';
  const trimmed = raw.trim();
  return trimmed === '' ? 'unknown' : trimmed.slice(0, 64);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function projectSession(raw: Record<string, unknown>, idx: number): SessionView {
  const key =
    (typeof raw['key'] === 'string' && (raw['key'] as string)) ||
    (typeof raw['id'] === 'string' && (raw['id'] as string)) ||
    (typeof raw['session_id'] === 'string' && (raw['session_id'] as string)) ||
    `session-${idx}`;
  const kind = sanitizeKind(
    (typeof raw['kind'] === 'string' && (raw['kind'] as string)) ||
      (typeof raw['agent_id'] === 'string' && (raw['agent_id'] as string)) ||
      (typeof raw['agentId'] === 'string' && (raw['agentId'] as string)) ||
      undefined,
  );
  const channel =
    (typeof raw['channel'] === 'string' && (raw['channel'] as string)) ||
    (typeof raw['origin'] === 'string' && (raw['origin'] as string)) ||
    'unknown';
  const lastMessageRaw =
    (typeof raw['last_message'] === 'string' && (raw['last_message'] as string)) ||
    (typeof raw['lastMessage'] === 'string' && (raw['lastMessage'] as string)) ||
    (typeof raw['preview'] === 'string' && (raw['preview'] as string)) ||
    '';
  const startedAt =
    typeof raw['started_at'] === 'string'
      ? (raw['started_at'] as string)
      : typeof raw['startedAt'] === 'string'
        ? (raw['startedAt'] as string)
        : typeof raw['created_at'] === 'string'
          ? (raw['created_at'] as string)
          : null;
  const updatedAt =
    typeof raw['updated_at'] === 'string'
      ? (raw['updated_at'] as string)
      : typeof raw['updatedAt'] === 'string'
        ? (raw['updatedAt'] as string)
        : typeof raw['last_message_at'] === 'string'
          ? (raw['last_message_at'] as string)
          : typeof raw['lastMessageAt'] === 'string'
            ? (raw['lastMessageAt'] as string)
            : null;
  const transcriptPath =
    typeof raw['session_file'] === 'string'
      ? (raw['session_file'] as string)
      : typeof raw['transcript_path'] === 'string'
        ? (raw['transcript_path'] as string)
        : typeof raw['jsonl_path'] === 'string'
          ? (raw['jsonl_path'] as string)
          : typeof raw['path'] === 'string'
            ? (raw['path'] as string)
            : null;
  return {
    key,
    kind,
    channel: sanitizeChannel(channel),
    lastMessage: truncate(lastMessageRaw, 200),
    startedAt,
    updatedAt,
    transcriptPath: transcriptPath !== null && transcriptPath !== '' ? transcriptPath : null,
    deepLink:
      transcriptPath !== null && transcriptPath !== '' && existsSync(transcriptPath)
        ? `file://${transcriptPath}`
        : null,
  };
}

type CallReason = NonNullable<OpenClawCallResult<unknown>['reason']>;

function normalize(reason: CallReason): SessionsListView['state'] {
  if (reason === 'ok') return 'ok';
  if (reason === 'invalid_json') return 'invalid_json';
  if (reason === 'spawn_failed') return 'spawn_failed';
  return 'unreachable';
}

export async function buildSessionsListView(): Promise<SessionsListView> {
  const binPath = resolveOpenclawToolPath('sessions_list');
  const result = await sessionsList().catch((err: unknown) => ({
    ok: false,
    data: null,
    reason: 'spawn_failed' as CallReason,
    raw: null,
    error: err instanceof Error ? err.message : String(err),
  }));
  if (!result.ok || result.data === null) {
    return {
      state: normalize(result.reason),
      binPath,
      sessions: [],
      error: result.error ?? null,
    };
  }
  const rawSessions: unknown[] = Array.isArray(result.data.sessions)
    ? (result.data.sessions as unknown[])
    : [];
  const sessions = rawSessions
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    .map((s, i) => projectSession(s, i));
  return { state: 'ok', binPath, sessions, error: null };
}

export async function registerSessionsRoute(app: FastifyInstance): Promise<void> {
  app.get('/sessions', async (req, reply) => {
    const view = await buildSessionsListView();
    if (view.state === 'unreachable') void reply.code(503);
    else if (view.state !== 'ok') void reply.code(502);
    await sendPage(reply, {
      view: 'ops/sessions.ejs',
      context: {
        title: 'Sessions',
        activeNav: '/sessions',
        csrfToken: '',
        user: req.session?.get?.('user') ?? null,
        view,
      },
    });
  });
}