/**
 * Shared event schema loading and validation.
 *
 * Used by the event-payload-declaration gate and available to any test that
 * needs to assert an emitted event payload satisfies its published contract.
 *
 * Deliberately not a full JSON Schema validator (no ajv dependency): this
 * checks the three properties that actually go wrong between a producer and
 * its contract — a required field the producer forgot, a field the producer
 * invented that the contract forbids, and a value whose type the contract
 * does not declare. A full validator would be stronger but would also be a
 * dependency, and the contract gate already proves every schema parses.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const eventsDir = join(root, "contracts", "events");

export interface EventSchema {
  readonly required: readonly string[];
  readonly properties: Record<string, unknown>;
  readonly additionalProperties: boolean;
  readonly title: string;
  readonly examples?: readonly unknown[];
}

const schemas = new Map<string, EventSchema>();
const schemaFiles = new Set<string>();

for (const file of readdirSync(eventsDir).filter(
  (f) => f.endsWith(".schema.json") && f !== "envelope.schema.json",
)) {
  const raw = JSON.parse(readFileSync(join(eventsDir, file), "utf8"));
  const eventType = file.replace(/\.v\d+\.schema\.json$/, "").replace(/\.schema\.json$/, "");
  schemas.set(eventType, raw as EventSchema);
  schemaFiles.add(eventType);
}

/** Every core event type that has a published schema. */
export const CORE_EVENT_TYPES: readonly string[] = [...schemas.keys()]
  .filter((t) => t.startsWith("core."))
  .sort();

/** The published contract for an event type, read from the repository. */
export function schemaFor(eventType: string): EventSchema {
  const schema = schemas.get(eventType);
  if (!schema) {
    throw new Error(
      `No published schema for event type "${eventType}". ` +
        `Schemas exist for: ${[...schemas.keys()].sort().join(", ")}`,
    );
  }
  return schema;
}

/**
 * The structural errors in a payload against its published schema.
 *
 * Returns an empty array if the payload conforms. Each error is a single
 * sentence naming the event type, the field and the violation, so a caller
 * can assert on the array length and read the first error on failure.
 */
export function payloadErrors(
  eventType: string,
  payload: Record<string, unknown>,
): string[] {
  const schema = schemaFor(eventType);
  const errors: string[] = [];

  for (const field of schema.required) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) {
      errors.push(`${eventType}: payload is missing required field "${field}"`);
    } else if (payload[field] === undefined) {
      errors.push(`${eventType}: required field "${field}" is undefined`);
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(payload)) {
      if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
        errors.push(
          `${eventType}: payload carries "${key}", which the contract does not declare`,
        );
      }
    }
  }

  // Type checking: for each property present in the payload that the schema
  // declares, verify the value matches the declared type. This catches a
  // producer that writes a string where the contract says integer, which a
  // required-field check alone would miss.
  const props = schema.properties as Record<string, Record<string, unknown>>;
  for (const [key, value] of Object.entries(payload)) {
    const prop = props[key];
    if (!prop) continue; // already reported if additionalProperties is false
    const declared = prop.type;
    if (typeof declared === "string") {
      const actual = Array.isArray(value) ? "array" : typeof value;
      if (declared === "integer" && actual === "number") {
        if (!Number.isInteger(value)) {
          errors.push(`${eventType}: field "${key}" is ${actual}, contract declares integer`);
        }
      } else if (declared === "integer" && actual !== "number") {
        errors.push(`${eventType}: field "${key}" is ${actual}, contract declares integer`);
      } else if (declared !== "integer" && actual !== declared) {
        errors.push(`${eventType}: field "${key}" is ${actual}, contract declares ${declared}`);
      }
    } else if (Array.isArray(declared)) {
      const actual = Array.isArray(value) ? "array" : typeof value;
      // JSON Schema "type": ["string", "null"] — accept null or the non-null type
      const nonNull = declared.filter((t: string) => t !== "null");
      if (value === null && declared.includes("null")) {
        // ok
      } else if (nonNull.includes("integer") && actual === "number") {
        // integer declared as array member: check Number.isInteger, same as the
        // single-type path above
        if (!Number.isInteger(value)) {
          errors.push(`${eventType}: field "${key}" is ${actual}, contract declares ${declared.join(" | ")}`);
        }
      } else if (!nonNull.includes(actual)) {
        errors.push(
          `${eventType}: field "${key}" is ${actual}, contract declares ${declared.join(" | ")}`,
        );
      }
    }
  }

  return errors;
}

/**
 * Asserts a payload satisfies the published schema's structural promises.
 * Throws with the first error if it does not.
 */
export function assertMatchesContract(
  eventType: string,
  payload: Record<string, unknown>,
): void {
  const errors = payloadErrors(eventType, payload);
  if (errors.length > 0) {
    throw new Error(errors[0]);
  }
}
