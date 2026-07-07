import { appendFile, mkdir, open, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export type AuditAction =
  | 'login.success'
  | 'login.failure'
  | 'logout'
  | 'csrf.failure'
  | 'session.regenerate'
  | 'session.destroy'
  | 'basic-auth.fallback'
  | 'vault.init'
  | 'rag.ingest'
  | 'rag.search'
  | 'cron.pause'
  | 'cron.resume'
  | 'cron.run'
  | 'cron.remove';

export interface AuditEntry {
  ts: string;
  action: AuditAction;
  user?: string;
  ip?: string;
  userAgent?: string;
  reason?: string;
  requestId?: string;
  // Optional metadata: vault / url_hash / ip — used by vault.init etc.
  vault?: string;
  urlHash?: string;
  outcome?: 'success' | 'failure';
  detail?: string;
  // rag.ingest metadata.
  source?: string;
  chunks?: number;
  // rag.search metadata. PRIVACY: only the hash, NEVER the question text.
  questionHash?: string;
  topK?: number;
  // cron.* metadata.
  jobId?: string;
}

function sanitize(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  if (input.length === 0) return '';
  if (input.length > 256) return `${input.slice(0, 256)}…`;
  return input.replace(/[\r\n]+/g, ' ');
}

function resolveAuditPath(): string {
  // Source of truth is the env var, so tests can swap the path between
  // runs. The config module reads it once at boot for the default; we read
  // it fresh on every write so the dashboard honors runtime overrides.
  const fromEnv = (process.env.AUTH_AUDIT_LOG ?? '').trim();
  if (fromEnv !== '') return resolve(fromEnv);
  return resolve(join(process.cwd(), 'runtime', 'audit.log'));
}

export async function writeAudit(entry: AuditEntry): Promise<void> {
  const payload: AuditEntry = {
    ts: entry.ts,
    action: entry.action,
    user: sanitize(entry.user),
    ip: sanitize(entry.ip),
    userAgent: sanitize(entry.userAgent),
    reason: sanitize(entry.reason),
    requestId: sanitize(entry.requestId),
    vault: sanitize(entry.vault),
    urlHash: sanitize(entry.urlHash),
    outcome: entry.outcome,
    detail: sanitize(entry.detail),
    source: sanitize(entry.source),
    chunks: typeof entry.chunks === 'number' ? entry.chunks : undefined,
    questionHash: sanitize(entry.questionHash),
    topK: typeof entry.topK === 'number' ? entry.topK : undefined,
    jobId: sanitize(entry.jobId),
  };
  const line = `${JSON.stringify(payload)}\n`;

  const path = resolveAuditPath();
  await mkdir(dirname(path), { recursive: true });

  await ensureMode(path);
  await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
}

async function ensureMode(path: string): Promise<void> {
  const info = await stat(path).catch(() => null);
  const handle = await open(path, 'a', 0o600);
  try {
    if (info === null) {
      await handle.chmod(0o600);
    } else {
      await handle.chmod(0o600);
    }
  } finally {
    await handle.close();
  }
}
