/**
 * Operator surface for queue revival (B-27).
 *
 * A CLI, and a separate one from `replay`, for the same reasons `cli.ts` gives:
 * reviving a dead row is an internal action performed by a person a handful of
 * times a year, and an HTTP route for it would be permanent surface area needing
 * its own rate limits, contract and exposure review. Sharing the replay command
 * and switching on a flag was the alternative, and was rejected — the two take
 * different filters, different cursors and a different permission, and one parser
 * covering both would be the place an operator typos `--mode reapply` at a queue
 * that has no modes.
 *
 * Authorisation is not skipped because it is a CLI: whoever runs it presents an
 * operator session token and must hold `events.revive`, which only
 * `platform_admin` has. Shell access is not authority, and the journal has to
 * name a person rather than "whoever was on the box".
 *
 * Usage:
 *
 *   REVIVE_TOKEN=… DATABASE_URL=… npm run revive -- \
 *     --queue outbox --event-types core.fulfillment.completed --limit 50 [--execute]
 *
 *   REVIVE_TOKEN=… DATABASE_URL=… npm run revive -- \
 *     --queue event-delivery --subscription <id> --limit 50 [--execute] \
 *     [--after-created-at <ts> --after-delivery-id <id>]
 *
 * Without `--execute` it is a dry run, because the safe thing must be the thing
 * that happens when an argument is forgotten.
 */
import { Pool } from "pg";
import { createCoreApp } from "../../app.js";
import { systemClock } from "../clock.js";
import { postgresPersistence } from "../persistence/backends.js";
import { CliUsageError } from "./cli.js";
import type { RevivalScope } from "./revive.js";

export interface ParsedReviveArgs {
  scope: RevivalScope;
  execute: boolean;
}

function fail(message: string): never {
  throw new CliUsageError(message);
}

/** ISO-8601 in, ISO-8601 out; anything else stops before a run begins. */
function instant(flag: string, value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) fail(`${flag} is not a readable timestamp: ${value}`);
  return parsed.toISOString();
}

export function parseReviveArgs(argv: readonly string[]): ParsedReviveArgs {
  const values = new Map<string, string>();
  let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (!arg.startsWith("--")) fail(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (name === "execute") {
      execute = true;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) fail(`--${name} needs a value`);
    values.set(name, next);
    index += 1;
  }

  const list = (name: string): readonly string[] | undefined => {
    const raw = values.get(name);
    return raw === undefined ? undefined : raw.split(",").map((part) => part.trim()).filter(Boolean);
  };

  const limitRaw = values.get("limit") ?? "100";
  const limit = Number(limitRaw);
  if (!Number.isInteger(limit)) fail(`--limit must be an integer: ${limitRaw}`);

  // Hyphenated on the command line, underscored in the code: the queue name an
  // operator types should not have to match a table name character for character.
  const queue = values.get("queue");
  if (queue !== "outbox" && queue !== "event-delivery") {
    fail("--queue must be outbox or event-delivery");
  }

  if (queue === "outbox") {
    return {
      execute,
      scope: {
        queue: "outbox",
        limit,
        ...(list("event-ids") ? { event_ids: list("event-ids") } : {}),
        ...(list("event-types") ? { event_types: list("event-types") } : {}),
        ...(values.get("producer") !== undefined
          ? { producer: values.get("producer") as string }
          : {}),
        ...(values.get("entity-type") !== undefined
          ? { entity_type: values.get("entity-type") as string }
          : {}),
        ...(values.get("entity-id") !== undefined
          ? { entity_id: values.get("entity-id") as string }
          : {}),
        ...(values.get("occurred-from") !== undefined
          ? { occurred_from: instant("--occurred-from", values.get("occurred-from") as string) }
          : {}),
        ...(values.get("occurred-to") !== undefined
          ? { occurred_to: instant("--occurred-to", values.get("occurred-to") as string) }
          : {}),
        ...cursor(values, "occurred-at", "event-id", "occurred_at", "event_id"),
      },
    };
  }

  return {
    execute,
    scope: {
      queue: "event_delivery",
      limit,
      ...(list("delivery-ids") ? { delivery_ids: list("delivery-ids") } : {}),
      ...(list("event-ids") ? { event_ids: list("event-ids") } : {}),
      ...(values.get("subscription") !== undefined
        ? { subscription_id: values.get("subscription") as string }
        : {}),
      ...(values.get("created-from") !== undefined
        ? { created_from: instant("--created-from", values.get("created-from") as string) }
        : {}),
      ...(values.get("created-to") !== undefined
        ? { created_to: instant("--created-to", values.get("created-to") as string) }
        : {}),
      ...cursor(values, "created-at", "delivery-id", "created_at", "delivery_id"),
    },
  };
}

/**
 * Both halves of a cursor or neither.
 *
 * Half a cursor is not a cursor: resuming from a timestamp without the tiebreak
 * would repeat or skip every row sharing that timestamp, which is the difference
 * between a resumable command and one that quietly loses a row on resume.
 */
function cursor(
  values: Map<string, string>,
  timeFlag: string,
  idFlag: string,
  timeField: string,
  idField: string,
): Record<string, unknown> {
  const time = values.get(`after-${timeFlag}`);
  const id = values.get(`after-${idFlag}`);
  if ((time === undefined) !== (id === undefined)) {
    fail(`--after-${timeFlag} and --after-${idFlag} must be given together`);
  }
  if (time === undefined || id === undefined) return {};
  return { after: { [timeField]: instant(`--after-${timeFlag}`, time), [idField]: id } };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseReviveArgs(argv);
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) fail("DATABASE_URL is required: revival reads the durable queues");
  const token = process.env["REVIVE_TOKEN"];
  if (!token) {
    // Read from the environment, never from an argument: a token in argv is a
    // token in the shell history and in every `ps` listing on the host.
    fail("REVIVE_TOKEN is required: revival is authorised as an operator, not by shell access");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const app = createCoreApp({
      clock: systemClock,
      persistence: postgresPersistence(pool, systemClock),
    });
    const actor = await app.identity.authenticate(token);
    // Not scoped to an organization: the two queues hold events for every tenant,
    // and `events.revive` belongs to `platform_admin` alone, which is what keeps a
    // service credential — every one of which holds `events.submit` — out of the
    // dead-letter queue.
    await app.identity.authorize(actor, "events.revive");

    const report = parsed.execute
      ? await app.revival.run(parsed.scope, {
          actor_type: "principal",
          actor_id: actor.principal_id,
        })
      : await app.revival.plan(parsed.scope);

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    // Non-zero for a run that failed or stopped short, so a wrapper script cannot
    // mistake a partial revival for a finished one.
    return report.counts.failed > 0 || report.stopped_early ? 1 : 0;
  } finally {
    await pool.end();
  }
}
