// Set by vitest setupFiles before any test module loads. This ensures that
// `process.env.*` values are present when `src/config.ts` is first imported
// by the server module under test.
process.env.ADMIN_USER ??= 'admin';
process.env.ADMIN_PASSWORD ??= 'correct-horse-battery-staple';
process.env.LOCAL_API_TOKEN ??= 'test-local-token-1234567890';
process.env.LOCAL_TOKEN_AUTH_REQUIRED ??= 'true';
process.env.READONLY_MODE ??= 'true';
process.env.APPROVAL_ACTIONS_ENABLED ??= 'false';
process.env.IMPORT_MUTATION_ENABLED ??= 'false';
process.env.SESSION_SECRET ??= 'a'.repeat(48);
process.env.NODE_ENV ??= 'test';
process.env.LOG_LEVEL ??= 'silent';
