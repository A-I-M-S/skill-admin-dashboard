export interface SkillSecretConfig {
  kmsBackend: string | undefined;
  kmsProjectUrl: string | undefined;
  kmsApiBlob: string | undefined;
  passphrase: string | undefined;
}

export interface AuthConfig {
  adminUser: string;
  sessionSecret: string;
  sessionCookieName: string;
  sessionTtlMs: number;
  auditLogPath: string;
  basicAuthUser: string;
}

export interface AppConfig {
  host: string;
  port: number;
  readonlyMode: boolean;
  approvalActionsEnabled: boolean;
  importMutationEnabled: boolean;
  localTokenAuthRequired: boolean;
  localApiToken: string;
  localTokenHeader: 'x-local-token';
  uiTimezone: string;
  skillSecret: SkillSecretConfig;
  auth: AuthConfig;
  openclawBin: string;
  nodeEnv: string;
  logLevel: string;
}

export interface Session {
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  isAdmin: boolean;
}

export interface CsrfToken {
  token: string;
  issuedAt: string;
}
