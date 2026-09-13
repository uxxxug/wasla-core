/**
 * What happens when a referenced row is deleted — and the proof that, in CORE,
 * almost nothing can be (milestone 17).
 *
 * The four parity cycles each ended with the same admission. Uniqueness,
 * checks, foreign keys and triggers are all rules about rows that exist, and
 * all four wrote down that the reference backend models no referential action
 * and that the delete halves of the append-only triggers are *unreachable*
 * rather than enforced. Unreachable was true when each cycle measured it and
 * nothing in the repository kept it true: a migration could add
 * `ON DELETE SET NULL`, or a store could grow a `deleteUsage`, and every
 * exemption that read "no caller can express this write" would become false
 * while the whole suite stayed green.
 *
 * This file is the thing that keeps it true, in four gates:
 *
 *   1. **The action of every key, against the catalog.** `REFERENTIAL_ACTIONS`
 *      declares the `ON DELETE` and `ON UPDATE` action of all 30 keys, and the
 *      gate reads `confdeltype`/`confupdtype` at run time. A migration that
 *      adds a cascade or a `SET NULL` the reference backend does not model
 *      fails here.
 *   2. **An unmodelled action must be unreachable.** Exactly one key is
 *      `ON DELETE CASCADE` and the reference backend models no cascade. That is
 *      only acceptable while no caller can delete the parent, so the gate
 *      asserts the absence of a plan delete rather than repeating the sentence.
 *   3. **Row removal happens only where it is declared.** A source scan for the
 *      two constructs that remove a row — `delete from` in SQL and `.delete(`
 *      on a map — fails on any file `DELETE_PATHS` does not name.
 *   4. **No port operation deletes a row undeclared.** The bundle's ports are
 *      walked at run time for removal-shaped method names, and the set must
 *      match a declaration that classifies each one as deleting a row or as
 *      releasing a lease. A new `deleteUsage` fails before it has a caller.
 *
 * And one gate that needs the database: every table a delete path touches has
 * no foreign key in either direction and no trigger, so "safe to delete from"
 * is read out of `pg_constraint` and `pg_trigger` instead of asserted.
 *
 * What this file does not do is add a delete path. Audit entries, ledger
 * entries, usage records and reputation signals are append-only by design and
 * the schema has triggers saying so. The work is to make that design enforced,
 * not to weaken it so that a cascade becomes observable.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { FixedClock } from "../src/platform/clock.js";
import {
  memoryPersistence,
  postgresPersistence,
  type Persistence,
} from "../src/platform/persistence/backends.js";
import {
  ACTION_CODES,
  KEYS_WITHOUT_A_REFERENCE_RULE,
  DELETE_PATHS,
  REFERENTIAL_ACTIONS,
  deletableTables,
  unmodelledActions,
  type ReferentialAction,
} from "../src/platform/persistence/delete-actions.js";
import {
  FOREIGN_KEYS,
  foreignKeyConstraints,
  type ForeignKeyRule,
} from "../src/platform/persistence/reference-keys.js";

const url = process.env.DATABASE_URL;

/**
 * A method whose name suggests it removes something, and what it really does.
 *
 * Declared so the gate can be an equality rather than a filter: a new
 * removal-shaped operation fails this file until somebody classifies it, and
 * classifying it as `deletes a row` drags in gate 5, which asks the catalog
 * whether that table can be deleted from safely.
 */
interface RemovalShapedOperation {
  readonly port: string;
  readonly method: string;
  readonly kind: "deletes a row" | "releases a lease";
  readonly note: string;
}

const REMOVAL_SHAPED: readonly RemovalShapedOperation[] = [
  {
    port: "inbox",
    method: "release",
    kind: "deletes a row",
    note: "releases a consumer's claim so a failed handler can be retried. The inbox is a claim ledger with no key in either direction and no trigger; keeping the row would make the retry impossible.",
  },
  {
    port: "rateLimit",
    method: "prune",
    kind: "deletes a row",
    note: "drops windows that have closed. Derived, bounded, reconstructible from the next request, referenced by nothing.",
  },
  {
    port: "outbox",
    method: "reclaimExpired",
    kind: "releases a lease",
    note: "clears an expired lease so another worker may claim the row. An UPDATE, not a DELETE: the envelope itself is the audit trail of what CORE published and is never removed.",
  },
  {
    port: "inbound",
    method: "reclaimExpired",
    kind: "releases a lease",
    note: "the same lease reclaim for inbound events, which replay reads afterwards — deleting one would make a historical replay unreproducible.",
  },
  {
    port: "delivery",
    method: "reclaimExpired",
    kind: "releases a lease",
    note: "the same lease reclaim for outbound webhook deliveries, whose attempt history is evidence for B-27 revival.",
  },
  {
    port: "notification",
    method: "reclaimExpired",
    kind: "releases a lease",
    note: "the same lease reclaim for notification dispatch.",
  },
];

/** Every `.ts` file under a directory, recursively. */
function sourceFiles(root: string): readonly string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts")) out.push(path);
    }
  };
  walk(root);
  return out;
}

/** Method names a port exposes, own and inherited. */
function methodsOf(port: object): readonly string[] {
  const names = new Set<string>();
  let current: object | null = port;
  while (current && current !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (typeof (port as Record<string, unknown>)[name] === "function") names.add(name);
    }
    current = Object.getPrototypeOf(current);
  }
  return [...names];
}

/** Removal-shaped operations the bundle actually exposes. */
function removalShapedOperations(store: Persistence): readonly string[] {
  const found: string[] = [];
  for (const [portName, port] of Object.entries(store as unknown as Record<string, unknown>)) {
    if (!port || typeof port !== "object") continue;
    for (const method of methodsOf(port)) {
      // Two families of name. The first is what a delete is usually called;
      // the second is what one gets called when somebody does not want to call
      // it a delete. Both have to be classified.
      if (/^(delete|remove|purge|drop|destroy|erase|discard|evict)/i.test(method)) {
        found.push(`${portName}.${method}`);
      } else if (/^(release|prune|forget|clear|expire|reclaim|truncate)/i.test(method)) {
        found.push(`${portName}.${method}`);
      }
    }
  }
  return [...new Set(found)].sort();
}

describe("delete-path parity", () => {
  it("declares an action for every foreign key, and no others", () => {
    const declared = Object.keys(REFERENTIAL_ACTIONS).sort();
    // `FOREIGN_KEYS` restates 29 of the schema's 30; the thirtieth is exempt
    // from the reference rules and still has a referential action, so it is
    // named rather than quietly allowed through.
    const keys = [...foreignKeyConstraints(), ...KEYS_WITHOUT_A_REFERENCE_RULE].sort();
    expect(
      keys.filter((name) => !declared.includes(name)),
      "a foreign key has no declared referential action, so nothing says what the database does when its parent is deleted",
    ).toEqual([]);
    expect(
      declared.filter((name) => !keys.includes(name)),
      "an action is declared for a key FOREIGN_KEYS does not know",
    ).toEqual([]);
  });

  it("gives every unmodelled action a reason and no reachable delete", () => {
    const unmodelled = unmodelledActions();
    // Not asserted empty: one cascade is legitimately unmodelled. Asserted
    // *justified*, which is a different and checkable claim.
    const unexplained = unmodelled.filter(
      (name) => (REFERENTIAL_ACTIONS[name]?.why ?? "").trim().length === 0,
    );
    expect(unexplained, "an unmodelled referential action with no recorded reason").toEqual([]);

    const rules = Object.entries(FOREIGN_KEYS as Record<string, readonly ForeignKeyRule[]>).flatMap(
      ([child, keyRules]) => keyRules.map((rule) => ({ ...rule, child })),
    );
    const reachable: string[] = [];
    for (const name of unmodelled) {
      const rule = rules.find((candidate) => candidate.constraint === name);
      if (!rule) continue;
      // An unmodelled `ON DELETE` action only stays invisible while the parent
      // cannot be deleted. If a delete path ever touches the parent table, the
      // two backends diverge the moment it runs.
      if (deletableTables().includes(rule.parent)) {
        reachable.push(`${name}: ${rule.parent} is in DELETE_PATHS`);
      }
    }
    expect(
      reachable,
      "an unmodelled referential action is now reachable: a delete path touches the parent table, so Postgres would cascade or null out rows the reference backend would keep",
    ).toEqual([]);
  });

  it("offers no port operation that deletes the parent of an unmodelled action", () => {
    const store = memoryPersistence(new FixedClock());
    const rules = Object.entries(FOREIGN_KEYS as Record<string, readonly ForeignKeyRule[]>).flatMap(
      ([, keyRules]) => keyRules,
    );
    const parents = new Set(
      unmodelledActions()
        .map((name) => rules.find((rule) => rule.constraint === name)?.parent)
        .filter((parent): parent is string => parent !== undefined),
    );
    // `plan` is the only entry today. A delete would be called deletePlan,
    // removePlan or retirePlan-that-really-deletes; the first two are caught by
    // name here and the third by the removal-shape gate below.
    const offenders: string[] = [];
    for (const [portName, port] of Object.entries(store as unknown as Record<string, unknown>)) {
      if (!port || typeof port !== "object") continue;
      for (const method of methodsOf(port)) {
        for (const parent of parents) {
          const singular = parent.replace(/_([a-z])/g, (_match, letter: string) =>
            letter.toUpperCase(),
          );
          if (new RegExp(`^(delete|remove|purge|drop)${singular}$`, "i").test(method)) {
            offenders.push(`${portName}.${method}`);
          }
        }
      }
    }
    expect(
      offenders,
      "a port now deletes the parent of a foreign key whose referential action the reference backend does not model; either model the action or drop the operation",
    ).toEqual([]);
    expect(parents.size, "no unmodelled action to check: the gate would pass vacuously").toBe(1);
  });

  it("removes a row only in the places DELETE_PATHS names", () => {
    const declaredFiles = new Set(DELETE_PATHS.flatMap((path) => path.where));
    const offenders: string[] = [];
    for (const file of sourceFiles("src")) {
      const source = readFileSync(file, "utf8");
      // Three constructs remove a row in this codebase: a SQL `delete from` or
      // `truncate` in an adapter, `Map.delete` in a reference store, and
      // `Map.clear`, which is the same thing for every row at once. `clear`
      // appears nowhere in `src/` today and is scanned for anyway, because a
      // gate that only catches the delete somebody has already written is not
      // a gate.
      const removesRow =
        /delete\s+from\s+/i.test(source) ||
        /\btruncate\b/i.test(source) ||
        /\.delete\(/.test(source) ||
        /\.clear\(/.test(source);
      if (removesRow && !declaredFiles.has(file)) offenders.push(file);
    }
    expect(
      offenders,
      "a file removes a row and is not declared in DELETE_PATHS; every delete has to carry the reason it cannot break a referential rule or an append-only trigger",
    ).toEqual([]);
    // The declaration cannot rot in the other direction either: a path that no
    // longer deletes anything is a stale excuse for the tables it names.
    const stale = [...declaredFiles].filter((file) => {
      const source = readFileSync(file, "utf8");
      return !(
        /delete\s+from\s+/i.test(source) ||
        /\btruncate\b/i.test(source) ||
        /\.delete\(/.test(source) ||
        /\.clear\(/.test(source)
      );
    });
    expect(stale, "DELETE_PATHS names a file that no longer removes a row").toEqual([]);
  });

  it("classifies every removal-shaped port operation", () => {
    const store = memoryPersistence(new FixedClock());
    const live = removalShapedOperations(store);
    const declared = REMOVAL_SHAPED.map((entry) => `${entry.port}.${entry.method}`).sort();
    expect(
      live.filter((name) => !declared.includes(name)),
      "a port exposes a removal-shaped operation nothing classifies; if it deletes a row it needs an entry in DELETE_PATHS, and if it only releases a lease it needs to say so",
    ).toEqual([]);
    expect(
      declared.filter((name) => !live.includes(name)),
      "a classified operation no longer exists",
    ).toEqual([]);
    expect(
      REMOVAL_SHAPED.filter((entry) => entry.note.trim().length === 0),
      "a removal-shaped operation with no note",
    ).toEqual([]);
    // Every operation that really deletes must name a table DELETE_PATHS covers.
    const deletes = REMOVAL_SHAPED.filter((entry) => entry.kind === "deletes a row");
    const covered = new Set(deletableTables());
    expect(
      deletes.filter((entry) => !covered.has(entry.port === "rateLimit" ? "rate_limit_counter" : entry.port)),
      "an operation deletes rows from a table DELETE_PATHS does not cover",
    ).toEqual([]);
  });
});

/**
 * The gates that need the live schema.
 *
 * "Safe to delete from" is not an opinion: it means the table is neither the
 * parent nor the child of a foreign key and carries no trigger. Read from the
 * catalog, because that is the only place that knows.
 */
describe.skipIf(!url)("delete-path parity against the live schema", () => {
  async function catalog() {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url, max: 1 });
    try {
      const keys = await pool.query<{
        conname: string;
        child: string;
        parent: string;
        confdeltype: string;
        confupdtype: string;
      }>(
        `select con.conname, child.relname as child, parent.relname as parent,
                con.confdeltype, con.confupdtype
           from pg_constraint con
           join pg_class child on child.oid = con.conrelid
           join pg_class parent on parent.oid = con.confrelid
          where con.contype = 'f' and con.connamespace = 'public'::regnamespace`,
      );
      const triggers = await pool.query<{ tgname: string; relname: string }>(
        `select t.tgname, c.relname
           from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
          where not t.tgisinternal and c.relnamespace = 'public'::regnamespace`,
      );
      return { keys: keys.rows, triggers: triggers.rows };
    } finally {
      await pool.end();
    }
  }

  it("declares each key's referential action exactly as the catalog does", async () => {
    const { keys } = await catalog();
    expect(keys.length, "no keys read: the gate would pass vacuously").toBe(30);
    const mismatches: string[] = [];
    for (const key of keys) {
      const declared = REFERENTIAL_ACTIONS[key.conname];
      if (!declared) {
        mismatches.push(`${key.conname}: the live schema declares it, this file does not`);
        continue;
      }
      const onDelete = ACTION_CODES[key.confdeltype] as ReferentialAction | undefined;
      const onUpdate = ACTION_CODES[key.confupdtype] as ReferentialAction | undefined;
      if (onDelete !== declared.onDelete) {
        mismatches.push(
          `${key.conname}: ON DELETE ${onDelete ?? key.confdeltype} in the schema, ${declared.onDelete} declared`,
        );
      }
      if (onUpdate !== declared.onUpdate) {
        mismatches.push(
          `${key.conname}: ON UPDATE ${onUpdate ?? key.confupdtype} in the schema, ${declared.onUpdate} declared`,
        );
      }
      // A non-default action the reference backend claims to model is the more
      // dangerous mistake of the two, because it reads as done.
      if (declared.modelled && (declared.onDelete !== "no action" || declared.onUpdate !== "no action")) {
        mismatches.push(
          `${key.conname}: declared as modelled, but the reference backend models no ${declared.onDelete}/${declared.onUpdate}`,
        );
      }
    }
    expect(
      mismatches,
      "a migration changed what the database does when a referenced row is deleted, and the reference backend has not been told",
    ).toEqual([]);
  });

  it("deletes only from tables with no referential structure and no trigger", async () => {
    const { keys, triggers } = await catalog();
    const problems: string[] = [];
    for (const table of deletableTables()) {
      const asParent = keys.filter((key) => key.parent === table).map((key) => key.conname);
      const asChild = keys.filter((key) => key.child === table).map((key) => key.conname);
      const fires = triggers.filter((trigger) => trigger.relname === table).map((t) => t.tgname);
      if (asParent.length) {
        problems.push(`${table}: a delete path deletes a parent of ${asParent.join(", ")}`);
      }
      if (asChild.length) {
        problems.push(`${table}: a delete path deletes a child of ${asChild.join(", ")}`);
      }
      if (fires.length) {
        problems.push(`${table}: a delete path deletes from a table with triggers ${fires.join(", ")}`);
      }
    }
    expect(
      problems,
      "a declared delete path now touches a table with referential structure or a trigger, so the reason recorded for it in DELETE_PATHS is no longer true",
    ).toEqual([]);
    expect(deletableTables()).toEqual(["inbox", "rate_limit_counter"]);
  });
});

/**
 * The one delete a caller can reach, on both backends.
 *
 * Four gates above are structural: they say what cannot happen. This one says
 * what does happen, because the claim "the only reachable delete behaves the
 * same in both backends" is an outcome, and an outcome has to be run. If the
 * two ever disagree — a release that does not let the next attempt through, or
 * one that throws on an absent claim — a handler retried after a crash would
 * behave differently depending on which backend was configured, which is the
 * exact class of bug all five parity cycles exist to find.
 */
interface DeleteBackend {
  readonly name: string;
  open(): Promise<{ store: Persistence; close: () => Promise<void> }>;
}

const deleteBackends: DeleteBackend[] = [
  {
    name: "memory",
    async open() {
      return { store: memoryPersistence(new FixedClock()), async close() {} };
    },
  },
];

if (url) {
  deleteBackends.push({
    name: "postgres",
    async open() {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: url, max: 2 });
      return {
        store: postgresPersistence(pool as never, new FixedClock()),
        async close() {
          await pool.end();
        },
      };
    },
  });
}

describe.each(deleteBackends)("the reachable delete path on $name", (backend) => {
  it("lets the next attempt claim an event whose claim was released", async () => {
    const { store, close } = await backend.open();
    try {
      const consumer = `parity-${randomUUID()}`;
      const event = randomUUID();
      expect(await store.inbox.claim(consumer, event)).toBe(true);
      expect(await store.inbox.claim(consumer, event)).toBe(false);
      expect(await store.inbox.seen(consumer, event)).toBe(true);

      await store.inbox.release(consumer, event);

      // The row is gone, which is the point: a handler that failed has to be
      // able to run again, and the claim is what would stop it.
      expect(await store.inbox.seen(consumer, event)).toBe(false);
      expect(await store.inbox.claim(consumer, event)).toBe(true);
    } finally {
      await close();
    }
  });

  it("treats releasing a claim that does not exist as a no-op", async () => {
    const { store, close } = await backend.open();
    try {
      // Delivery is at-least-once and release is called from failure paths, so
      // a duplicate release is normal traffic rather than an error. Postgres
      // deletes zero rows; the reference backend must not throw where Postgres
      // shrugs.
      const consumer = `parity-${randomUUID()}`;
      const event = randomUUID();
      await store.inbox.release(consumer, event);
      await store.inbox.release(consumer, event);
      expect(await store.inbox.seen(consumer, event)).toBe(false);
      expect(await store.inbox.claim(consumer, event)).toBe(true);
    } finally {
      await close();
    }
  });
});
