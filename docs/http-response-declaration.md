# Routes document the response they return, and the documented shape is enforced — milestone 27

The fourth and last surface of the HTTP contract family. Milestone 24 closed the
query string, 25 the request body, 26 the request headers — everything a route
**reads**. Nothing governed what a route **answers**, which is the half other
systems build against: MOVE and MARKET consume `contracts/openapi/core-v1.yaml`,
and a published shape nobody checks is a guess with a version number.

## What was measured, before anything was changed

Against `main` at `f71aba2`, by parsing the published contract and driving every
operation the router registers through `core.router.handle`:

| Reading | On `main` |
| --- | --- |
| Operations documenting **no response schema** | **34 of 52** (35 counting `/metrics`, whose text body is a schema-less body by nature) |
| Tests or scripts that parse the contract as YAML | **none** |
| Tests or scripts that compare a response body to the contract | **none** |
| Response objects broken by unquoted commas inside a flow map | **2** |
| Documented shapes that diverged from the real body | **3** |

Three of those need spelling out.

### The contract had never been parsed

`scripts/check-contracts.mjs` reads the OpenAPI file with regular expressions —
it counts schemas and checks that names appear. So a structurally invalid
document passed the gate for the file's whole life. Two response descriptions
were written as flow maps containing an unquoted comma:

```yaml
"400": { description: Invalid envelope, or no consumer for this event type }
```

A YAML parser reads that as **two** keys: `description: "Invalid envelope"` and a
junk key `"or no consumer for this event type": null`. The published sentence was
truncated at the comma, and the file had a key OpenAPI does not define. Eight
further success responses were written the same way; expanding them to block form
to carry a schema fixed those incidentally, and the two refusal lines above were
quoted. The count in the reservation — "10 malformed lines" — was a text scan of
every `{ description: …, … }` line, and it is corrected here additively: **10
flow-map lines contained an unquoted comma, 8 of which stopped being flow maps
when they gained a `content:` block, and 2 were quoted in place.** The
reservation's other figure, "33 of 52 operations document no schema", was also a
text scan; the parser-derived number is **34 of 52** (35 with `/metrics`).

### `POST /v1/organizations` had never returned a tenant

```ts
// src/modules/organization/http.ts, before
return { status: 201, body: organizations.create({ ... }) };   // no await
```

`JSON.stringify` renders a promise as `{}`. So the call that creates a tenant —
the first call any integrator makes — answered `201 {}`, and the caller could not
learn the id of the thing it had just created. `GET /v1/organizations/{id}` had
the same defect. Both had passed every test in the repository since the module
shipped, because every test asserted the status code.

That is fixed at the root twice: the two `await`s, and a guard in the router that
refuses **any** route whose body is a thenable, so the next handler to forget an
`await` fails loudly instead of shipping an empty object past a green suite. The
gate reproduces that case deliberately on a throwaway app.

### `GET /v1/event-deliveries/undelivered` returned the claim token

`claim_token` is the fencing credential a worker presents to acknowledge a
delivery (B-24). The read returned the raw row, token included, to anybody
holding `organization.read`. `EventSubscription` already had exactly this
treatment for `signing_secret` — `PublicSubscription` + `redactSubscription` —
and the delivery row simply never got it. It has one now (`PublicDelivery`,
`redactDelivery`), and the gate asserts that **no** response body anywhere
contains the string `claim_token`, so a route added later cannot reintroduce it.

The third divergence: `GET /v1/sessions/current` returned six permissions the
published `Permission` enum did not list (`events.submit`, `events.replay`,
`events.revive`, `subscription.read`, `subscription.write`, `reputation.read`),
and did not document `service_name`. A client validating CORE's own answer
against CORE's own contract would have rejected it. `EventDelivery` was missing
`claimed_at` and `reclaims`; the notification list's `summary` was a free-form
integer map, now six named counters, so a state added to the notification machine
has to be published before it can appear.

## What was built

| File | What it is |
| --- | --- |
| `tests/support/openapi.ts` | A dependency-free reader for the subset of YAML this contract uses: block maps and sequences, flow maps and sequences, `>-`/`|` scalars, quoted keys, whole-line comments. Plus `$ref` resolution (`deepResolve`, cycle-guarded), `allOf` flattening, and `violations(value, schema, at)` — a strict validator. |
| `tests/support/http-scenario.ts` | Drives all **52** operations against one app on the memory backend and records the real status, content type and body of each. |
| `tests/http-response-declaration.test.ts` | The gate: 11 cases. |
| `contracts/openapi/core-v1.yaml` | 25 new component schemas, 33 response `content:` blocks, and the four corrections above. |

`violations` is strict in the directions that catch drift:

- a property in the body that the contract does not document is a **failure**,
  not an addition — that is what caught `claim_token` and `service_name`;
- `null` passes only where `nullable: true` is written, so a column that became
  nullable cannot start arriving as `null` under an unchanged contract;
- `enum` is checked against the returned value — that is what caught the six
  missing permissions;
- `format: uuid` and `format: date-time` are checked against the value.

`allOf` is merged only for objects (union of `required`, combined `properties`),
and a property declared twice with two different schemas is **refused** rather
than resolved: whichever branch won would be a coin toss. `additionalProperties`
is honoured when written as a schema; absent or `false`, an undocumented key is a
violation — stricter than OpenAPI's default, on purpose.

## The gate

1. The contract parses, and no response object carries a key that is not
   `description`, `content`, `headers` or `$ref`.
2. Every operation documents the status it actually answers with.
3. Every operation that returns a body documents a schema for it — and a bodyless
   `204` (`POST /v1/sessions/revoke`) documents **no** content, asserted rather
   than left to omission.
4. The documented content type is the one actually sent (`/metrics` is
   `text/plain`).
5. Every real body satisfies its documented schema, strictly.
6. Coverage: the set of operations driven **equals** the set the contract
   publishes, and equals the set the router registers. A route added later cannot
   go unmeasured; a route deleted cannot keep a stale schema.
7. Every operation answers with a success status, so no schema is ever validated
   against a refusal that happened to be returned instead.
8. A real `400` satisfies the documented `Error` shape.
9. No response body contains a claim token.
10. A route returning a promise as its body is refused by the router.

## Getting all 52 to a success status

A gate that validates the shape of a refusal proves nothing, so every operation
had to genuinely succeed first. Four things had to be built rather than asserted:

- The three reconciliation reads and both reputation reads require
  `organization_id`; the driver was sending none, so they were answering `400`.
- The notification recipient requires a **verified channel link**, so the
  subject identity is registered with `channel_type: "telegram"` and its session
  issued the same way.
- `GET /v1/fulfillments/reconciliation/{decision-required,stale-holds}` return
  `count: 0` on any ordinary scenario, and **an empty `items: []` satisfies any
  item schema** — so the schemas would have been unvalidated. The scenario now
  produces a real row for each: a funded fulfillment partially captured and then
  cancelled (`settlement_state: partially_captured`,
  `financial_disposition: decision_required`), and an authorization voided under
  an open fulfillment.

## Falsification

Every mutation below was applied to a **committed** tree, the gate was run, the
tree was restored with `git checkout -- .` and `git status --porcelain` verified
empty afterwards. Baseline: 11 passed.

| # | Mutation | Gate |
| --- | --- | --- |
| F1 | Drop the `await` in `POST /v1/organizations` — the original defect | **2 failed** |
| F2 | Stop redacting delivery rows (`items` instead of `items.map(redactDelivery)`) | **2 failed** |
| F3 | Remove `service_name` from `AuthenticatedPrincipal` | **1 failed** |
| F4 | Remove `reputation.read` from the `Permission` enum | **1 failed** |
| F5 | Re-break a response description into an unquoted flow map | **1 failed** |
| F6 | Remove the router's thenable guard | **1 failed** |
| F7 | Delete `GET /health`'s response schema | **2 failed** |
| F8 | Register a route the contract does not publish | **1 failed** |
| F9 | Drop `nullable: true` from `EventDelivery.last_error`, which returns null | **1 failed** |
| F10 | Document a body for the bodyless `204 POST /v1/sessions/revoke` | **2 failed** |
| F11 | Make the decision-required reconciliation read answer `items: []` | **11 passed — not caught** |

**F11 is the limitation, measured rather than asserted.** An empty array satisfies
any item schema, so a read that silently stops returning rows passes this gate
untouched. That is why the scenario was extended to produce a real row for each
reconciliation read in the first place — the schemas are validated against actual
rows today — but nothing *forces* it to keep doing so. A cycle that wants that
guarantee has to assert non-emptiness per operation, and this one does not.

A twelfth mutation was attempted first (replacing the scenario's `organization_id`
with a random uuid, intending to empty the list) and is recorded as **invalid**:
it broke the scenario's setup so no test ran at all, which measures nothing about
the gate. It was replaced with F11 rather than deleted from the record.

## Measurement

| Run | Before | After |
| --- | --- | --- |
| No `DATABASE_URL` | 689 passed / 147 skipped | **700 passed / 147 skipped** |
| With `DATABASE_URL` | 1251 + 1 = 1252 | recorded in `ROADMAP.md` |

Locally on an embedded PostgreSQL 18.4 with `C` collation; the CI verdict against
`postgres:16` with `en_US.utf8` is the judgment and is recorded in `ROADMAP.md`.
`tsc --noEmit` clean; governance, contract, migration and roadmap gates pass. No
existing test was changed, loosened or skipped. Both readers agree the contract
now has no junk keys: the new reader, and Python's `yaml.safe_load` used as an
independent cross-check during the cycle.

## What this cycle does not claim

- **It does not prove the schemas describe every value a property can take.**
  They describe what CORE produced in this scenario, plus the enums its own
  domain types declare. `financial_disposition: inconsistent` is documented from
  the source and reached by no scenario here.
- **It does not validate error bodies operation by operation.** One real `400` is
  checked against the canonical `Error` shape; the other refusal statuses are
  documented with prose, as before.
- **It does not check response *headers*.** CORE sets `x-correlation-id`,
  `retry-after` and three `x-ratelimit-*` headers, and the contract still
  describes them in prose only.
- **It does not make `tests/support/openapi.ts` a general OpenAPI validator.** It
  reads the subset this contract uses and throws on anything else — which is the
  intent: an unreadable construct fails the gate instead of being skipped.
- **It does not govern the `/metrics` text body's contents**, only that it is
  documented as text and returns text.
- **It does not replace `scripts/check-contracts.mjs`.** That script still scans
  for event-schema coverage; this gate now covers the structural half it could
  never see.
