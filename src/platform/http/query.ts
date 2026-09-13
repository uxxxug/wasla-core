/**
 * How a route reads a query parameter.
 *
 * Milestone 23 measured the HTTP read surface the way milestones 21 and 22
 * measured the stores, and found that the selection a caller asked for and the
 * selection CORE performed could differ before any store was reached. Three
 * ways, all of them silent:
 *
 *   - **A repeated parameter loses every value but the first.**
 *     `URLSearchParams.get` returns the first of `?status=queued&status=failed`
 *     and discards the rest, so a caller who asked for two statuses was answered
 *     for one and told nothing. Whether the extras came from a retry loop, a
 *     proxy, or a client that built the string wrong, the honest answer is that
 *     CORE does not know which one was meant.
 *   - **An empty value was a filter.** `?organization_id=` reached
 *     `notifications.list({ organization_id: "" })`, which is a filter no row can
 *     match, so the response was an empty list with `count: 0` — indistinguishable
 *     from a tenant that genuinely has nothing. `?status=` was refused only
 *     because `""` failed an enum check; the tenant filters had no such check.
 *   - **`Number()` accepted things no caller meant.** `limit=0x10` selected 16
 *     rows, `limit=1e3` selected 1000 — past the 500 the route documents, since
 *     `Number.isInteger(1000)` is true — and `limit=" 5"`, `limit=5.0` and
 *     `limit=+5` were all accepted as 5. A limit is a decimal integer written by
 *     a caller; every other spelling is a request CORE cannot claim to have
 *     understood.
 *
 * So all three are refused here, once, rather than in each of the nine routes
 * that read parameters. A refusal is a 400 with the parameter named — the caller
 * learns what CORE could not understand, which is the whole difference between
 * this and returning a plausible list.
 */
import { invalid } from "../errors.js";

/** Only a decimal integer, no sign, no exponent, no leading zeros beyond `0`. */
const INTEGER = /^(?:0|[1-9][0-9]*)$/;
/** A decimal number, optionally signed, no exponent. Coordinates are written this way. */
const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

/**
 * The one value this parameter has, or `undefined` when it was not sent.
 *
 * Refuses a repeat and refuses an empty value. Empty is refused rather than read
 * as absent because the two are different requests: a caller who sent
 * `?organization_id=` asked to filter by something, and answering as though they
 * had asked for everything — or for nothing — is the same silent substitution
 * this module exists to end.
 */
export function optionalParam(query: URLSearchParams, key: string): string | undefined {
  const values = query.getAll(key);
  if (values.length === 0) return undefined;
  if (values.length > 1) {
    throw invalid(`${key} must be given at most once (received ${values.length} values)`);
  }
  const value = values[0]!;
  if (value.trim() === "") throw invalid(`${key} must not be empty`);
  if (value !== value.trim()) throw invalid(`${key} must not be surrounded by whitespace`);
  return value;
}

/** As `optionalParam`, and the parameter is required. */
export function requiredParam(query: URLSearchParams, key: string): string {
  const value = optionalParam(query, key);
  if (value === undefined) throw invalid(`${key} is required`);
  return value;
}

/** One of a closed set of values, or `undefined` when not sent. */
export function enumParam<T extends string>(
  query: URLSearchParams,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = optionalParam(query, key);
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw invalid(`${key} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

/**
 * A page size: a decimal integer within the route's bounds, or the route's
 * default when the parameter was not sent.
 */
export function limitParam(
  query: URLSearchParams,
  key: string,
  bounds: { readonly default: number; readonly min: number; readonly max: number },
): number {
  const raw = optionalParam(query, key);
  if (raw === undefined) return bounds.default;
  if (!INTEGER.test(raw)) {
    throw invalid(`${key} must be a decimal integer between ${bounds.min} and ${bounds.max}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    throw invalid(`${key} must be a decimal integer between ${bounds.min} and ${bounds.max}`);
  }
  return value;
}

/** A required decimal number, such as a coordinate. */
export function decimalParam(query: URLSearchParams, key: string): number {
  const raw = requiredParam(query, key);
  if (!DECIMAL.test(raw)) throw invalid(`${key} must be a decimal number`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw invalid(`${key} must be a decimal number`);
  return value;
}
