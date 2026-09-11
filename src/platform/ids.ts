import { randomUUID, randomBytes, createHash } from "node:crypto";

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
