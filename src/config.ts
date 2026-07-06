import { existsSync } from 'node:fs';
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
export const SKILL_SECRET_KMS_BACKEND = readOptionalStringEnv(process.env.SKILL_SECRET_KMS_BACKEND);
export const SKILL_SECRET_KMS_PROJECT_URL = readOptionalStringEnv(
  process.env.SKILL_SECRET_KMS_PROJECT_URL,
);
export const SKILL_SECRET_KMS_API_BLOB = readOptionalStringEnv(
  process.env.SKILL_SECRET_KMS_API_BLOB,
);
export const SKILL_SECRET_PASSPHRASE = readOptionalStringEnv(process.env.SKILL_SECRET_PASSPHRASE);

// Tool path resolution for cron / sessions_list / opencode.
export const OPENCLAW_BIN = readStringEnv(process.env.OPENCLAW_BIN, '/usr/local/bin:/usr/bin');

export const NODE_ENV = readStringEnv(process.env.NODE_ENV, 'production');
export const LOG_LEVEL = readStringEnv(process.env.LOG_LEVEL, NODE_ENV === 'production' ? 'info' : 'debug');

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
  },
  openclawBin: OPENCLAW_BIN,
  nodeEnv: NODE_ENV,
  logLevel: LOG_LEVEL,
};
