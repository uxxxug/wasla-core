import { createHash } from "node:crypto";

/**
 * A deterministic, readable identifier for fixtures.
 *
 * Every CORE-owned key is `uuid` in the schema and `newId` returns UUID v4, so
 * a fixture using `"org-1"` was only ever passing because a `Map` does not
 * care. Postgres does, and so does `assertId` now.
 *
 * Hand-written UUID literals would have made the tests unreadable, so the
 * label is hashed into a well-formed v4 instead: `testId("org-1")` is stable
 * across runs, distinct per label, and still says what it is at the call site.
 * Tests that need to prove two ids differ can rely on distinct labels; tests
 * that need genuine randomness should keep using `randomUUID`.
 */
export function testId(label: string): string {
  const h = createHash("sha256").update(label).digest("hex");
  const v4 = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  return v4;
}
