import { randomUUID, randomBytes, createHash } from "node:crypto";
import { invalid } from "./errors.js";

/** Opaque identifier factory. IDs are UUID v4 and carry no business meaning. */
export function newId(): string {
  return randomUUID();
}

/** Cryptographically random opaque token (never stored in plaintext). */
export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** One-way hash used for session tokens at rest. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Deterministic idempotency key. Callers supply a stable business reference so
 * that a retried command resolves to the same key and therefore the same result.
 */
export function idempotencyKey(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

/**
 * The shape of every identifier CORE issues.
 *
 * `newId` produces UUID v4 and the schema declares every CORE-owned key as
 * `uuid`, so this is the domain stating the same rule the database already
 * enforces. Without it, a malformed identifier behaves differently on each
 * backend: a `Map` accepts `"org-1"` happily, while Postgres raises an opaque
 * `invalid input syntax for type uuid`. Asserting it here means both backends
 * reject it the same way, as a malformed request rather than a crash or a
 * phantom row.
 *
 * This does *not* apply to references CORE does not own. `market_order_reference`,
 * `move_job_reference`, `identity_link.external_id`, `business_reference`,
 * `correlation_id` and `country_code` are `text` in the schema on purpose:
 * they are other systems' identifiers or natural keys, and constraining their
 * format would be CORE inventing rules for data it does not issue.
 */
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/**
 * Rejects a malformed CORE identifier at intake.
 *
 * `field` names the input so the caller learns which one was wrong; the value
 * is not echoed back, because an identifier arriving from outside is untrusted
 * input and this message reaches logs.
 */
export function assertId(field: string, value: unknown): string {
  if (!isId(value)) throw invalid(`${field} must be a UUID`);
  return value as string;
}
