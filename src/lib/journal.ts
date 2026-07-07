import { runSubprocess, type SpawnResult } from './subprocess';

/**
 * `lib/journal.ts` — wraps `journalctl -u <service> -n 200 --no-pager`
 * with safe defaults: ANSI escape stripping (Risk #9), `SYSTEMD_COLORS=0`
 * + `TERM=dumb` in the env, and a hard 2 MiB stdout buffer cap.
 *
 * The `--since-cursor=...` mode powers the v1 polling endpoint
 * (`GET /logs/:service?since=<byte-offset>`) — we emit a stable byte
 * cursor on the last delivered line so the client only re-fetches the
 * delta between polls. v2 will swap this for a WebSocket stream.
 */

// Service name constraint: systemd unit names allow `[A-Za-z0-9_.@-]`,
// plus `@` for template instances. Cap at 128 to keep argv sane.
const SERVICE_PATTERN = /^[A-Za-z0-9._@-]{1,128}$/;

export function isValidServiceName(raw: string): boolean {
  return SERVICE_PATTERN.test(raw);
}

// ANSI escape strip — covers CSI (`\x1b[...m`) plus the bare `\x1b` byte.
// Risk #9: journalctl emits SGR sequences even with --no-pager; some
// distros also inject OSC hyperlinks. Stripping both is cheap.
// The eslint no-control-regex rule is disabled here because matching
// these bytes IS the entire point of this function.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\[[0-9;?]*[A-Za-z]|\](?:[^]|(?!\\))*(?:|\\)|[()][ -~]|[A-Za-z]/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, '');
}

const DEFAULT_LINES = 200;
const MAX_LINES = 2_000;
const POLL_BUFFER_BYTES = 2 * 1024 * 1024; // 2 MiB cap on poll output

export interface JournalReadResult {
  ok: boolean;
  service: string;
  text: string;
  raw: SpawnResult;
  error?: string;
  reason:
    | 'ok'
    | 'unreachable'
    | 'non_zero_exit'
    | 'spawn_failed'
    | 'invalid_service';
}

function buildJournalEnv(): NodeJS.ProcessEnv {
  // Risk #9: SYSTEMD_COLORS=0 + TERM=dumb tell journalctl not to emit
  // SGR sequences. They may still arrive on older distros, which is why
  // `stripAnsi` exists.
  return {
    ...process.env,
    SYSTEMD_COLORS: '0',
    TERM: 'dumb',
    NO_COLOR: '1',
  };
}

export interface ReadJournalTailOptions {
  lines?: number;
  /** Optional byte cursor — when set, the call becomes an incremental
   *  poll that only returns bytes newer than this offset. */
  since?: number;
}

/**
 * Tail the last `lines` log entries for a single systemd unit. The
 * subprocess is invoked via `runSubprocess` so we inherit timeout,
 * max-buffer, and SIGTERM/SIGKILL escalation.
 *
 * `since` (when present) is interpreted as a byte offset into the
 * initial tail — we slice the result and recompute the new cursor.
 * NOTE: this is intentionally simple; v2 will replace with a proper
 * cursor (journalctl `--cursor`) once we add WebSocket streaming.
 */
export async function readJournalTail(
  service: string,
  options: ReadJournalTailOptions = {},
): Promise<JournalReadResult> {
  if (!isValidServiceName(service)) {
    return {
      ok: false,
      service,
      text: '',
      raw: emptyResult(),
      reason: 'invalid_service',
      error: 'invalid service name',
    };
  }

  const lines = clamp(options.lines ?? DEFAULT_LINES, 1, MAX_LINES);

  const args = ['-u', service, '-n', String(lines), '--no-pager', '--output=short'];
  let result: SpawnResult;
  try {
    result = await runSubprocess('journalctl', {
      args,
      env: buildJournalEnv(),
      timeoutMs: 5_000,
      maxBufferBytes: POLL_BUFFER_BYTES,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      service,
      text: '',
      raw: 'result' in (err as Record<string, unknown>)
        ? ((err as { result: SpawnResult }).result)
        : emptyResult(),
      reason: 'spawn_failed',
      error: msg,
    };
  }

  if (result.code !== 0 || result.timedOut) {
    return {
      ok: false,
      service,
      text: '',
      raw: result,
      reason: result.stdout.trim() === '' ? 'unreachable' : 'non_zero_exit',
      error: result.stderr.trim() || `exit ${result.code}`,
    };
  }

  const fullText = stripAnsi(result.stdout);
  // Convert byte-offset cursors into JS-string indices by re-encoding.
  // The client passes back the byte length of the response it has; we
  // re-fetch the latest tail and slice off everything up to that
  // byte offset — this gives the client only the new bytes appended
  // since its last poll. If the journal rotated (log shorter than the
  // client's cursor), we return the full new text (best-effort).
  let text = fullText;
  if (typeof options.since === 'number' && options.since > 0) {
    text = sliceAtByteOffset(fullText, options.since);
  }
  // Cursor = byte length of the full cleaned output. The client passes
  // it back as `?since=<cursor>` and we slice it off the next poll.
  // Cap the byte length so an exploding log doesn't blow up the cursor.
  if (Buffer.byteLength(text, 'utf8') > POLL_BUFFER_BYTES) {
    text = text.slice(-POLL_BUFFER_BYTES);
  }

  return {
    ok: true,
    service,
    text,
    raw: result,
    reason: 'ok',
    error: undefined,
  };
}

export interface JournalCursorPayload {
  ok: boolean;
  service: string;
  text: string;
  /** Byte length of `text`. Pass this back as `?since=<cursor>`. */
  cursor: number;
  reason: JournalReadResult['reason'];
  error?: string;
}

export function projectJournal(result: JournalReadResult): JournalCursorPayload {
  if (!result.ok) {
    return {
      ok: false,
      service: result.service,
      text: '',
      cursor: 0,
      reason: result.reason,
      error: result.error,
    };
  }
  return {
    ok: true,
    service: result.service,
    text: result.text,
    cursor: Buffer.byteLength(result.text, 'utf8'),
    reason: 'ok',
  };
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

/**
 * Slice a UTF-8 string at a byte offset rather than a code-unit
 * offset. Returns the tail starting at `byteOffset`. If the string's
 * byte length is less than `byteOffset` (journal rotated / restarted),
 * returns the full text (best-effort: the client should reset its
 * cursor).
 */
function sliceAtByteOffset(text: string, byteOffset: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (byteOffset <= 0) return text;
  if (byteOffset >= buf.length) {
    // Full text is shorter than the client's cursor — return the full
    // text so the client at least sees the current state.
    return text;
  }
  return buf.subarray(byteOffset).toString('utf8');
}

function emptyResult(): SpawnResult {
  return {
    stdout: '',
    stderr: '',
    code: -1,
    signal: null,
    timedOut: false,
    durationMs: 0,
  };
}

/**
 * Read the comma-separated `LOGS_SERVICES` env var into a stable,
 * deduped, validated list of service names. Names that fail
 * `isValidServiceName` are dropped (with a console warning at boot).
 */
export function resolveLogsServices(envValue: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of envValue.split(',')) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    if (!isValidServiceName(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}