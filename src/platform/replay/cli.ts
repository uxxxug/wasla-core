/**
 * Operator surface for historical replay.
 *
 * A CLI, deliberately, and not an HTTP endpoint. Replay is an internal
 * operational action performed by a person a handful of times a year; putting it
 * on the ingress router would mean a route reachable from wherever ingress is
 * reachable, needing its own rate limits, its own OpenAPI contract and its own
 * exposure review — permanent surface area for an occasional action. A command
 * that must be run where the database credentials already live is both smaller
 * and harder to reach by accident. When CORE's deployment topology is settled
 * (blocker B-5) the same `ReplayService` can be given an admin-plane route
 * without changing anything here.
 *
 * Authorisation is not skipped because it is a CLI. Whoever runs it presents an
 * operator session token and must hold `events.replay`, which only
 * `platform_admin` has — shell access is not authority, and the journal has to
 * name a person rather than "whoever was on the box".
 *
 * Usage:
 *
 *   REPLAY_TOKEN=… DATABASE_URL=… npm run replay -- \
 *     --event-types move.job.completed --received-from 2026-09-01T00:00:00Z \
 *     --limit 50 [--execute] [--mode reapply] [--continue-on-error] \
 *     [--organization <id>] [--after-received-at <ts> --after-event-id <id>]
 *
 * Without `--execute` it is a dry-run, because the safe thing must be the thing
 * that happens when an argument is forgotten.
 */
import { Pool } from "pg";
import { createCoreApp } from "../../app.js";
import { systemClock } from "../clock.js";
import { postgresPersistence } from "../persistence/backends.js";
import type { ReplayMode, ReplayScope } from "./service.js";

export interface ParsedArgs {
  scope: ReplayScope;
  mode: ReplayMode;
  execute: boolean;
  stopOnError: boolean;
}

/**
 * A usage error, thrown rather than exited on.
 *
 * `process.exit` inside a parser makes the parser untestable, and an untestable
 * parser is how this surface shipped silently broken once already: the entry
 * point used to be guarded on `process.argv[1]`, which the runner rewrites, so
 * the command printed nothing at all. The guard is gone, the parser is exported,
 * and the only place that exits is the entry point in `main.ts`.
 */
export class CliUsageError extends Error {
  readonly exitCode = 2;
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

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (!arg.startsWith("--")) fail(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (name === "execute" || name === "continue-on-error") {
      flags.add(name);
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

  const afterReceivedAt = values.get("after-received-at");
  const afterEventId = values.get("after-event-id");
  if ((afterReceivedAt === undefined) !== (afterEventId === undefined)) {
    // Half a cursor is not a cursor: resuming from a timestamp without the
    // tiebreak would repeat or skip every event sharing that timestamp.
    fail("--after-received-at and --after-event-id must be given together");
  }

  const mode = (values.get("mode") ?? "pending_only") as ReplayMode;
  if (mode !== "pending_only" && mode !== "reapply") {
    fail(`--mode must be pending_only or reapply`);
  }

  const limitRaw = values.get("limit") ?? "100";
  const limit = Number(limitRaw);
  if (!Number.isInteger(limit)) fail(`--limit must be an integer: ${limitRaw}`);

  const scope: ReplayScope = {
    limit,
    ...(list("event-ids") ? { event_ids: list("event-ids") } : {}),
    ...(list("event-types") ? { event_types: list("event-types") } : {}),
    ...(values.get("producer") !== undefined ? { producer: values.get("producer") as string } : {}),
    ...(list("statuses") ? { statuses: list("statuses") as ReplayScope["statuses"] } : {}),
    ...(values.get("received-from") !== undefined
      ? { received_from: instant("--received-from", values.get("received-from") as string) }
      : {}),
    ...(values.get("received-to") !== undefined
      ? { received_to: instant("--received-to", values.get("received-to") as string) }
      : {}),
    ...(values.get("occurred-from") !== undefined
      ? { occurred_from: instant("--occurred-from", values.get("occurred-from") as string) }
      : {}),
    ...(values.get("occurred-to") !== undefined
      ? { occurred_to: instant("--occurred-to", values.get("occurred-to") as string) }
      : {}),
    ...(values.get("organization") !== undefined
      ? { organization_id: values.get("organization") as string }
      : {}),
    ...(afterReceivedAt !== undefined && afterEventId !== undefined
      ? {
          after: {
            received_at: instant("--after-received-at", afterReceivedAt),
            event_id: afterEventId,
          },
        }
      : {}),
  };

  return {
    scope,
    mode,
    execute: flags.has("execute"),
    stopOnError: !flags.has("continue-on-error"),
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) fail("DATABASE_URL is required: replay reads the durable event history");
  const token = process.env["REPLAY_TOKEN"];
  if (!token) {
    // Read from the environment, never from an argument: a token in argv is a
    // token in the shell history and in every `ps` listing on the host.
    fail("REPLAY_TOKEN is required: replay is authorised as an operator, not by shell access");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const app = createCoreApp({
      clock: systemClock,
      persistence: postgresPersistence(pool, systemClock),
    });
    const actor = await app.identity.authenticate(token);
    // Not scoped to an organization: replay reads the inbound history, which is
    // not owned by one tenant. `events.replay` belongs to `platform_admin`
    // alone, so this is the check that keeps a service credential — every one of
    // which holds `events.submit` — out of the history.
    await app.identity.authorize(actor, "events.replay");

    const report = parsed.execute
      ? await app.replay.run(
          parsed.scope,
          parsed.mode,
          { actor_type: "principal", actor_id: actor.principal_id },
          { stopOnError: parsed.stopOnError },
        )
      : await app.replay.plan(parsed.scope, parsed.mode);

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    // A non-zero exit for a run that failed or stopped short, so a wrapper
    // script cannot mistake a partial replay for a finished one.
    return report.counts.failed > 0 || report.stopped_early ? 1 : 0;
  } finally {
    await pool.end();
  }
}
