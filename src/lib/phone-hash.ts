import { createHash } from 'node:crypto';

/**
 * SHA-256 hash of an admin-supplied phone number, first 12 hex chars.
 * Used in audit log entries for `chatbot.send` so the dashboard never
 * persists the raw phone (privacy). The full hash is computed at call
 * time and truncated; we do NOT add a per-deployment salt in v1.
 *
 * For higher-assurance deployments, swap in a server-side pepper via
 * `process.env.AUDIT_PHONE_HASH_PEPPER` (concat-then-hash) — see Risk
 * #4 in `docs/plans/phase-0-bootstrap.md`.
 */
export function hashPhoneForAudit(phone: string): string {
  if (typeof phone !== 'string' || phone === '') return '';
  const pepper = (process.env.AUDIT_PHONE_HASH_PEPPER ?? '').trim();
  const material = pepper === '' ? phone : `${pepper}|${phone}`;
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 12);
}