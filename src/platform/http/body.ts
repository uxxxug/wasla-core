/**
 * How a route reads a request body.
 *
 * Milestone 24 closed the query string: a route declares the parameters it
 * accepts, the router refuses anything else, and `RequestContext` carries no
 * `URLSearchParams` at all, so a handler cannot read what its route did not
 * declare. Its own record named the body as the other half and left it — and
 * measuring the body before reserving milestone 25 turned that from a symmetry
 * argument into a money defect:
 *
 *   POST /v1/payment-authorizations/<id>/capture   {"amountMinor": 500}
 *   → 200, captured 5000
 *
 * The route reads `amount_minor`, and an *absent* amount means "capture the whole
 * remaining hold", which is the correct meaning of absence and a catastrophic
 * meaning for a typo. One camelCase spelling took ten times what the caller asked
 * for and the response said success. `refund` has the same shape, so the same
 * typo refunds everything. `POST /v1/wallets` accepted `nonsense` and `CURRENCY`
 * beside `currency` and answered 201.
 *
 * Every write route hand-parsed `ctx.body as Record<string, unknown>` with
 * `objectBody`/`requiredString`/`optionalString` helpers duplicated across three
 * modules, and not one of them refused a property it did not read. So the body is
 * declared at the registration, exactly as the query string is, and parsed here
 * once:
 *
 *   - **Unknown properties are refused first**, named, before any declared field
 *     is read, so a caller with both a typo and a bad value hears about the typo.
 *   - **A declared field is the only thing a handler can read.** `ctx.body` is
 *     gone; `ctx.input` is a `Body`, and reading an undeclared name throws — the
 *     same rule as `Selection`, for the same reason: `undefined` would rebuild
 *     the defect one level down.
 *   - **Nesting is declared too.** `grants` on `POST /v1/plans` is a list of
 *     objects, so its item fields are declared and a `featureKey` typo inside a
 *     grant is refused like any other unknown property.
 *   - **A route that reads no body says so** with `NO_BODY`, and then any
 *     property at all is refused. An empty object is still accepted: `{}` asks
 *     for nothing, so accepting it substitutes nothing.
 *   - **`OPAQUE_BODY` exists for exactly one case** — the event envelope on
 *     `POST /v1/events`, which is validated against the published event contract
 *     by `normalize.ts` rather than by a field list here. It requires a written
 *     reason, and the gate lists every route that uses it, so a second opaque
 *     body cannot appear quietly.
 */
import { invalid } from "../errors.js";

/** One property of a request body. */
export type FieldSpec =
  /** A non-empty string. */
  | { readonly name: string; readonly kind: "text"; readonly required?: boolean }
  /**
   * A non-empty string, or an explicit `null`, which is a *value* rather than an
   * absence — `organization_id: null` on a notification recipient means
   * "platform-wide", which is not the same request as omitting it.
   */
  | { readonly name: string; readonly kind: "nullable_text"; readonly required?: boolean }
  /** One of a closed set of strings. */
  | {
      readonly name: string;
      readonly kind: "enum";
      readonly values: readonly string[];
      readonly required?: boolean;
    }
  /** A safe integer. Money in minor units, quantities, counts. */
  | { readonly name: string; readonly kind: "integer"; readonly required?: boolean }
  /** A safe integer or an explicit `null` (an unmetered grant). */
  | {
      readonly name: string;
      readonly kind: "nullable_integer";
      readonly required?: boolean;
      /**
       * Added to the refusal when a required field is missing. `limit_value` on a
       * plan grant needs it: an omitted limit could mean "no quota" or "a quota of
       * nothing", which are opposites, so the refusal has to tell the caller how
       * to say the one it means.
       */
      readonly hint?: string;
    }
  /** A finite number. Coordinates and radii. */
  | { readonly name: string; readonly kind: "number"; readonly required?: boolean }
  /**
   * A list of strings from a closed vocabulary. `roles` on a membership is the
   * one of these: the contract has always taken bare strings, and reshaping the
   * contract to suit this reader would be a contract change made for CORE's
   * convenience.
   */
  | {
      readonly name: string;
      readonly kind: "enum_list";
      readonly values: readonly string[];
      readonly required?: boolean;
      readonly minItems?: number;
    }
  /** A list of objects, each declared field by field. */
  | {
      readonly name: string;
      readonly kind: "list";
      readonly items: readonly FieldSpec[];
      readonly required?: boolean;
      readonly minItems?: number;
    };

/** What a route accepts as a body. */
export type BodySpec =
  | { readonly kind: "none" }
  | { readonly kind: "object"; readonly fields: readonly FieldSpec[] }
  | { readonly kind: "opaque"; readonly reason: string };

/** A route that reads nothing from the body. Any property is refused. */
export const NO_BODY: BodySpec = { kind: "none" };

/**
 * A body handed to the handler whole, with the reason recorded.
 *
 * Used once, for the event envelope, which is validated against
 * `contracts/events/*` by `normalize.ts` — a field list here would be a second,
 * weaker copy of that contract.
 */
export function opaqueBody(reason: string): BodySpec {
  if (!reason.trim()) throw new Error("an opaque body must record why it is opaque");
  return { kind: "opaque", reason };
}

/** Shorthand for the common case. */
export function objectBody(...fields: readonly FieldSpec[]): BodySpec {
  return { kind: "object", fields };
}

type Value = string | number | null | undefined | ReadonlyArray<Body> | ReadonlyArray<string>;

/**
 * The parsed body of one request.
 *
 * Reading a name the route did not declare throws, because it is a programming
 * error rather than a caller error: a handler reading `amount_minor` from a route
 * that never declared it would otherwise see "not sent" on every request, which
 * is precisely the capture defect this module exists to end.
 */
export class Body {
  constructor(
    private readonly values: ReadonlyMap<string, Value>,
    private readonly opaque: unknown = undefined,
    private readonly isOpaque = false,
  ) {}

  private read(name: string): Value {
    if (!this.values.has(name)) {
      throw new Error(`route did not declare the body property ${name}`);
    }
    return this.values.get(name);
  }

  /** Was the property sent at all? `null` counts as sent. */
  has(name: string): boolean {
    return this.read(name) !== undefined;
  }

  /** A declared optional string; `null` if it was sent as null. */
  text(name: string): string | null | undefined {
    const value = this.read(name);
    if (value === undefined || value === null) return value;
    if (typeof value !== "string") throw invalid(`${name} must be a string`);
    return value;
  }

  /** A declared required string. The parse has already refused its absence. */
  requiredText(name: string): string {
    const value = this.text(name);
    if (typeof value !== "string") throw invalid(`${name} is required`);
    return value;
  }

  /** A declared optional number; `null` if it was sent as null. */
  number(name: string): number | null | undefined {
    const value = this.read(name);
    if (value === undefined || value === null) return value;
    if (typeof value !== "number") throw invalid(`${name} must be a number`);
    return value;
  }

  /** A declared required number. */
  requiredNumber(name: string): number {
    const value = this.number(name);
    if (typeof value !== "number") throw invalid(`${name} is required`);
    return value;
  }

  /** A declared list of vocabulary strings. */
  strings(name: string): readonly string[] {
    const value = this.read(name);
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw invalid(`${name} must be an array`);
    return value as readonly string[];
  }

  /** A declared list of objects, each already parsed against its item fields. */
  list(name: string): readonly Body[] {
    const value = this.read(name);
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw invalid(`${name} must be an array`);
    return value as readonly Body[];
  }

  /**
   * The body as sent, for the one route entitled to it.
   *
   * Throws for every other route rather than returning the raw object, so an
   * opaque read cannot spread by copy-paste into a route that declared fields.
   */
  raw(): unknown {
    if (!this.isOpaque) throw new Error("route did not declare an opaque body");
    return this.opaque;
  }

  /** The declared names, for the gate. */
  names(): readonly string[] {
    return [...this.values.keys()];
  }
}

function fieldsOf(specs: readonly FieldSpec[], input: Record<string, unknown>, path: string): Map<string, Value> {
  const declared = new Set(specs.map((spec) => spec.name));
  const unknown = Object.keys(input)
    .filter((key) => !declared.has(key))
    .sort();
  if (unknown.length > 0) {
    throw invalid(
      `unknown body propert${unknown.length > 1 ? "ies" : "y"}: ${unknown
        .map((key) => `${path}${key}`)
        .join(", ")}` +
        (declared.size > 0
          ? ` (this route accepts ${[...declared].sort().map((key) => `${path}${key}`).join(", ")})`
          : " (this route accepts none)"),
    );
  }

  const values = new Map<string, Value>();
  for (const spec of specs) {
    const name = `${path}${spec.name}`;
    const present = spec.name in input;
    const raw = input[spec.name];
    if (!present || raw === undefined) {
      if (spec.required) {
        const hint = "hint" in spec && spec.hint ? `; ${spec.hint}` : "";
        throw invalid(`${name} is required${hint}`);
      }
      values.set(spec.name, undefined);
      continue;
    }
    const nullable = spec.kind === "nullable_text" || spec.kind === "nullable_integer";
    if (raw === null) {
      if (!nullable) throw invalid(`${name} must not be null`);
      values.set(spec.name, null);
      continue;
    }
    switch (spec.kind) {
      case "text":
      case "nullable_text": {
        if (typeof raw !== "string" || !raw.trim()) throw invalid(`${name} must be a non-empty string`);
        values.set(spec.name, raw);
        break;
      }
      case "enum": {
        if (typeof raw !== "string" || !spec.values.includes(raw)) {
          throw invalid(`${name} must be one of ${spec.values.join(", ")}`);
        }
        values.set(spec.name, raw);
        break;
      }
      case "integer":
      case "nullable_integer": {
        if (typeof raw !== "number" || !Number.isSafeInteger(raw)) {
          throw invalid(`${name} must be an integer`);
        }
        values.set(spec.name, raw);
        break;
      }
      case "number": {
        if (typeof raw !== "number" || !Number.isFinite(raw)) {
          throw invalid(`${name} must be a number`);
        }
        values.set(spec.name, raw);
        break;
      }
      case "enum_list": {
        if (!Array.isArray(raw)) throw invalid(`${name} must be an array`);
        const least = spec.minItems ?? 0;
        if (raw.length < least) {
          throw invalid(`${name} must contain at least ${least} item${least === 1 ? "" : "s"}`);
        }
        const items = raw.map((entry, index) => {
          if (typeof entry !== "string" || !spec.values.includes(entry)) {
            throw invalid(`${name}[${index}] must be one of ${spec.values.join(", ")}`);
          }
          return entry;
        });
        values.set(spec.name, items);
        break;
      }
      case "list": {
        if (!Array.isArray(raw)) throw invalid(`${name} must be an array`);
        const minimum = spec.minItems ?? 0;
        if (raw.length < minimum) {
          throw invalid(`${name} must contain at least ${minimum} item${minimum === 1 ? "" : "s"}`);
        }
        const items = raw.map((entry, index) => {
          if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            throw invalid(`${name}[${index}] must be an object`);
          }
          return new Body(
            fieldsOf(spec.items, entry as Record<string, unknown>, `${name}[${index}].`),
          );
        });
        values.set(spec.name, items);
        break;
      }
    }
  }
  return values;
}

/**
 * Parse a request body against what the route declared.
 *
 * A body that is not a JSON object is refused for every route that declares
 * fields, even when all of them are optional, because `"5"` or `[1,2]` is not a
 * request CORE can claim to have understood. An absent body is accepted when no
 * field is required and refused, naming the missing field, when one is.
 */
export function parseBody(body: unknown, spec: BodySpec): Body {
  if (spec.kind === "opaque") {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw invalid("a JSON object body is required");
    }
    return new Body(new Map(), body, true);
  }

  const absent = body === undefined || body === null;
  if (!absent && (typeof body !== "object" || Array.isArray(body))) {
    throw invalid("a JSON object body is required");
  }
  const input = (absent ? {} : body) as Record<string, unknown>;

  if (spec.kind === "none") {
    const sent = Object.keys(input).sort();
    if (sent.length > 0) {
      throw invalid(
        `unknown body propert${sent.length > 1 ? "ies" : "y"}: ${sent.join(", ")} ` +
          "(this route reads no body)",
      );
    }
    return new Body(new Map());
  }

  return new Body(fieldsOf(spec.fields, input, ""));
}
