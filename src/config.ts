import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { AppConfig } from './types';

const DOTENV_PATH = join(process.cwd(), '.env');

if (existsSync(DOTENV_PATH)) {
  process.loadEnvFile?.(DOTENV_PATH);
}

function readStringEnv(input: string | undefined, fallback: string): string {
  const value = (input ?? '').trim();
  return value === '' ? fallback : value;
}

function readOptionalStringEnv(input: string | undefined): string | undefined {
  const value = (input ?? '').trim();
  return value === '' ? undefined : value;
}

function readBooleanEnv(input: string | undefined, fallback: boolean): boolean {
  const value = (input ?? '').trim().toLowerCase();
  if (value === '') return fallback;
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  return fallback;
}

function readPortEnv(input: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(input ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) return fallback;
  return parsed;
}

function readTimeZoneEnv(input: string | undefined, fallback: string): string {
  const value = (input ?? '').trim();
  const candidate = value === '' ? fallback : value;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return fallback;
  }
}

function ensureSessionSecret(input: string | undefined): string {
  const value = (input ?? '').trim();
  if (value.length >= 32) return value;
  return randomBytes(32).toString('hex');
}

export const HOST = readStringEnv(process.env.HOST, '127.0.0.1');
export const PORT = readPortEnv(process.env.PORT, 4320);

// Safety defaults — all three default to the safe/closed state in v1.
export const READONLY_MODE = readBooleanEnv(process.env.READONLY_MODE, true);
export const APPROVAL_ACTIONS_ENABLED = readBooleanEnv(
  process.env.APPROVAL_ACTIONS_ENABLED,
  false,
);
export const IMPORT_MUTATION_ENABLED = readBooleanEnv(
  process.env.IMPORT_MUTATION_ENABLED,
  false,
);

export const LOCAL_TOKEN_AUTH_REQUIRED = readBooleanEnv(
  process.env.LOCAL_TOKEN_AUTH_REQUIRED,
  true,
);
export const LOCAL_API_TOKEN = readStringEnv(process.env.LOCAL_API_TOKEN, '');
export const LOCAL_TOKEN_HEADER = 'x-local-token' as const;

export const UI_TIMEZONE = readTimeZoneEnv(process.env.UI_TIMEZONE, 'UTC');

// skill-secret subprocess env (forwarded to bin/secret by lib/bin-secret.ts).
// These come from the dashboard's own env (systemd EnvironmentFile=/.env),
// NEVER from the request body — see Risk #4 in the plan.
export const SKILL_SECRET_KMS_BACKEND = readOptionalStringEnv(process.env.SKILL_SECRET_KMS_BACKEND);
export const SKILL_SECRET_KMS_PROJECT_URL = readOptionalStringEnv(
  process.env.SKILL_SECRET_KMS_PROJECT_URL,
);
export const SKILL_SECRET_KMS_API_BLOB = readOptionalStringEnv(
  process.env.SKILL_SECRET_KMS_API_BLOB,
);
export const SKILL_SECRET_PASSPHRASE = readOptionalStringEnv(process.env.SKILL_SECRET_PASSPHRASE);

// Path to the bin/secret wrapper script. Defaults to the live installation in
// the sibling skill-secret project. The local fallback at
// references/upstream/skill-secret/bin-secret-wrapper is also valid — useful
// when the sibling project is not checked out.
const SKILL_SECRET_BIN_FALLBACK = '/root/.openclaw/workspace/dev/projects/skill-secret/bin/secret';
export const SKILL_SECRET_BIN = readStringEnv(
  process.env.SKILL_SECRET_BIN,
  SKILL_SECRET_BIN_FALLBACK,
);

// Path to the bin/rag wrapper script (skill-rag-qdrant). Defaults to the
// dashboard's own bin/rag Python shim which delegates to the sibling project.
const SKILL_RAG_BIN_FALLBACK = join(process.cwd(), 'bin', 'rag');
export const SKILL_RAG_BIN = readStringEnv(
  process.env.SKILL_RAG_BIN,
  SKILL_RAG_BIN_FALLBACK,
);

// Tool path resolution for cron / sessions_list / opencode.
export const OPENCLAW_BIN = readStringEnv(process.env.OPENCLAW_BIN, '/usr/local/bin:/usr/bin');

// Ops log tail — comma-separated systemd unit names. v1 default is the
// quartet from the Phase 0 plan (issue #12). Operators override via
// LOGS_SERVICES=svc1,svc2,...
const LOGS_SERVICES_FALLBACK = 'aoa,openclaw-control-center,wa-bridge,orchestrator';
export const LOGS_SERVICES = readStringEnv(process.env.LOGS_SERVICES, LOGS_SERVICES_FALLBACK);

// Path to the bin/chatbot-admin wrapper script (skill-chatbot). Defaults
// to the sibling skill-chatbot project. The dashboard returns 503 (Phase
// 4 contract) until this wrapper is installed (issue #13/#14/#15).
const CHATBOT_ADMIN_BIN_FALLBACK = '/root/.openclaw/workspace/dev/projects/skill-chatbot/bin/chatbot-admin';
export const CHATBOT_ADMIN_BIN = readStringEnv(
  process.env.CHATBOT_ADMIN_BIN,
  CHATBOT_ADMIN_BIN_FALLBACK,
);

// Auth (Issue #3). ADMIN_PASSWORD is hashed with argon2id lazily by auth/session.ts
// and never appears in the config object — raw env values stay in module-local consts.
export const ADMIN_USER = readStringEnv(process.env.ADMIN_USER, 'admin');
export const ADMIN_PASSWORD = readStringEnv(process.env.ADMIN_PASSWORD, '');
export const SESSION_SECRET = ensureSessionSecret(process.env.SESSION_SECRET);
export const SESSION_COOKIE_NAME = readStringEnv(process.env.SESSION_COOKIE_NAME, 'sad.sid');
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 h
export const AUTH_AUDIT_LOG = readStringEnv(
  process.env.AUTH_AUDIT_LOG,
  join(process.cwd(), 'runtime', 'audit.log'),
);

export const NODE_ENV = readStringEnv(process.env.NODE_ENV, 'production');
export const LOG_LEVEL = readStringEnv(
  process.env.LOG_LEVEL,
  NODE_ENV === 'production' ? 'info' : 'debug',
);

export const config: AppConfig = {
  host: HOST,
  port: PORT,
  readonlyMode: READONLY_MODE,
  approvalActionsEnabled: APPROVAL_ACTIONS_ENABLED,
  importMutationEnabled: IMPORT_MUTATION_ENABLED,
  localTokenAuthRequired: LOCAL_TOKEN_AUTH_REQUIRED,
  localApiToken: LOCAL_API_TOKEN,
  localTokenHeader: LOCAL_TOKEN_HEADER,
  uiTimezone: UI_TIMEZONE,
  skillSecret: {
    kmsBackend: SKILL_SECRET_KMS_BACKEND,
    kmsProjectUrl: SKILL_SECRET_KMS_PROJECT_URL,
    kmsApiBlob: SKILL_SECRET_KMS_API_BLOB,
    passphrase: SKILL_SECRET_PASSPHRASE,
    binPath: SKILL_SECRET_BIN,
  },
  skillRag: {
    binPath: SKILL_RAG_BIN,
  },
  auth: {
    adminUser: ADMIN_USER,
    sessionSecret: SESSION_SECRET,
    sessionCookieName: SESSION_COOKIE_NAME,
    sessionTtlMs: SESSION_TTL_MS,
    auditLogPath: AUTH_AUDIT_LOG,
    basicAuthUser: ADMIN_USER,
  },
  openclawBin: OPENCLAW_BIN,
  logsServices: LOGS_SERVICES,
  chatbotAdmin: { binPath: CHATBOT_ADMIN_BIN },
  nodeEnv: NODE_ENV,
  logLevel: LOG_LEVEL,
};
