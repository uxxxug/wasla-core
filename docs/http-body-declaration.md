# Write routes accept only the body they declare — milestone 25

Branch `http-body-declaration`, cut from `main` at `ff0c49f`. The row was reserved
in `ROADMAP.md` (commit `6e00159`) **before any implementation file was edited**,
which is what milestone 24's record promised the next cycle would do.

## The defect, measured before anything was designed

Milestone 24 closed the query string and stated in its own record that the request
body was a separate, still-open question. That could have stayed a symmetry
argument. Measuring the body first turned it into a money defect.

Against `main` at `ff0c49f`, with a real wallet, a real 5000-minor hold and a
valid token:

```
POST /v1/payment-authorizations/<id>/capture
{"amountMinor": 500, "capture_reference": "cap-1"}

→ 200 OK, captured 5000
```

One camelCase spelling captured the entire hold, ten times what the caller asked
for, and the response said success. The mechanism is not exotic: the route reads
`amount_minor`, and an **absent** `amount_minor` means "capture the whole
remaining hold", which is the correct meaning of absence. `amountMinor` was never
read, so the request looked exactly like a request to capture everything.
`refund` has the same shape, so the same typo refunds everything.

Two more from the same measurement:

```
POST /v1/wallets
{"owner_type":"identity","owner_id":"…","currency":"SAR","nonsense":true,"CURRENCY":"USD"}
→ 201 Created
```

`nonsense` and `CURRENCY` were ignored in silence — including a caller who
believed they had specified a currency in a different case and got the wallet in
another.

And nesting, where a hand-written reader stops looking first:

```
POST /v1/plans   grants: [{"feature_key":"f","limit_value":null,"featureKey":"f"}]
→ 201 Created
```

The cause is the same in all four: each of the 29 write routes parsed
`ctx.body as Record<string, unknown>` by hand, with `objectBody`,
`requiredString`, `optionalString`, `requiredInteger`, `requiredNumber`,
`channel` and `grants` helpers **duplicated across seven files**, and not one of
them refused a property it did not read.

## The fix, structural rather than per route

Exactly the shape milestone 24 used for parameters, so there is one rule for what
a route accepts rather than two:

- **`src/platform/http/body.ts` owns every body reader.** `FieldSpec` describes
  one property (`text`, `nullable_text`, `enum`, `integer`, `nullable_integer`,
  `number`, `enum_list`, `list` of declared objects). `BodySpec` describes what a
  route accepts: `NO_BODY`, `objectBody(...fields)`, or `opaqueBody(reason)`.
- **`router.post(path, body, handler)`** takes the declaration as its second
  argument, positional and not optional. `add()` defaults to `NO_BODY`, so a
  route registered without thinking about its body refuses every property rather
  than accepting everything — the same fail-closed default as `accepts = []`.
- **The router parses the body before the handler runs**, next to
  `parseSelection`: after rate limiting, before authentication, refusals raised as
  `CoreError` and answered as 400 `invalid_request`.
- **Unknown properties are refused first**, named, and the message lists what the
  route does accept, before any declared field is validated. A caller with a typo
  *and* a bad value hears about the typo, because that is the one they must fix to
  get the request they intended.
- **`RequestContext` no longer carries a body at all.** `ctx.input` is a `Body`,
  and reading a name the route did not declare **throws** rather than returning
  `undefined`, because `undefined` is precisely how a capture of 5000 looked like
  a capture of 500.
- **Nesting is declared.** `grants` on `POST /v1/plans` declares its item fields,
  so `featureKey` inside a grant is refused as `grants[0].featureKey`.
- **A route that reads no body says `NO_BODY`** and then refuses any property. An
  absent body and `{}` are still accepted: both ask for nothing, so accepting them
  substitutes nothing. Five routes are in this class: plan activate and retire,
  period collect, and event-subscription activate and deactivate.
- **One opaque body exists.** `POST /v1/events` hands the envelope to
  `normalize.ts`, which validates it against `contracts/events/*`. A field list
  here would be a second, weaker copy of that contract and the two would drift, so
  the route declares `opaqueBody(reason)` with a written reason, and the gate
  asserts the list of opaque routes is exactly `["POST /v1/events"]`.
- **Every per-module body helper is deleted.** Seven copies removed from
  `identity-access`, `organization`, `notification`, `fulfillment`,
  `subscription`, `geography`, `money`, `delivery-http` and `ingress-http`.

`limit_value` on a plan grant keeps a distinction the old reader had and the new
one must not lose: it is **required and nullable**, because an omitted limit could
mean "granted without a quota" or "a quota of nothing", which are opposites. The
refusal carries the hint `use null for an unmetered grant`, and there is a test
for both halves.

## What the gate asserts

`tests/http-body-declaration.test.ts`, 16 tests, no database, driven off
`router.registrations()` rather than a list maintained in the test:

1. The premise: 29 write routes, each with a body spec, at least 50 declared
   fields in total — so the file cannot pass by asserting refusals against
   nothing.
2. Every write route refuses an unknown property, 400, naming it.
3. The refusal precedes authentication: a request with no token and a typo is
   told about the typo, not sent to fix a credential that was never the problem.
4. Every route declaring no body refuses any property, and still accepts an absent
   body and `{}`.
5. Every declared field is live: a wrong-typed value for one field at a time is
   refused **by name**, which only the parse can do (50+ probes).
6. Every required field's absence is refused by name (30+ probes).
7. A body that is not a JSON object is refused on every route that reads one.
8. An unknown property inside a `grants` item is refused as `grants[0].…`.
9. An omitted grant limit is refused with its hint; an explicit `null` is not.
10. The capture, refund and wallet requests from the measurement above are refused
    — and an *absent* capture amount is still accepted, because "capture
    everything" is a real request this route has always served.
11. Declared and read agree, measured in the source per file and attributed to the
    `router.post(...)` call each literal was written in.
12. The declarations are well formed: unique snake_case names, non-empty
    vocabularies, non-empty list item declarations, recursively.
13. The opaque list is exactly `POST /v1/events`, with a reason of real length.
14. No handler reads a body any other way: no `ctx.body`, no `objectBody(ctx`, no
    `input["…"]` outside `body.ts` and `router.ts`, and `RequestContext` has no
    `body` member.
15. `Body` throws on an undeclared read and on `raw()` for a non-opaque route.
16. The published contract agrees: every documented `requestBody` property is
    declared and every declared property is documented.

### What the contract cross-check found

Four write routes — `POST /v1/geography/countries`, `/regions`, `/cities`,
`/service-areas` — were **documented with no request body at all** while CORE has
always required three or four properties each. An integrator reading
`contracts/openapi/core-v1.yaml` could not have constructed a single one of those
calls. The bodies are now documented to match the declarations, additively, with
the countries entry recording why the gap existed. This is the same class of
finding as milestone 24's undocumented `country_code`, from the same kind of
check, which is the argument for keeping the check.

## Falsification

Every gate was broken deliberately, on purpose, and the result recorded. All nine
were caught; the tree was restored with `git checkout` after each, verified clean.

| # | Deliberate break | Result |
|---|---|---|
| F1 | `parseBody` stops refusing unknown properties | 4 tests fail |
| F2 | A field declared on `POST /v1/wallets` that no handler reads | 2 tests fail |
| F3 | A handler reads `ctx.body` again | 1 test fails (and `tsc` refuses to compile it) |
| F4 | `POST /v1/fulfillments/:id/cancel` declares a second opaque body | 1 test fails |
| F5 | A declared property the contract does not document | 2 tests fail |
| F6 | A `NO_BODY` route stops refusing properties | 2 tests fail |
| F7 | An undeclared read returns `undefined` instead of throwing | 1 test fails |
| F8 | A non-object body is accepted | 1 test fails |
| F9 | An `enum` field declared with an empty vocabulary | 3 tests fail |

F3 and F7 are each caught by a single test, and that is worth stating rather than
smoothing over: F3 has the type system as a second barrier, F7 has nothing but its
own probe. The probe is therefore the load-bearing test of this milestone, and it
asserts the property directly on `Body` rather than through a route.

## A gate belonging to milestone 24 was sharpened, not weakened

Milestone 25's own source broke two of milestone 24's checks, and neither break
was a real defect:

- `body.ts` explains in a comment *why* `RequestContext` carries no
  `URLSearchParams`, and a `String.includes` scan counted the word in the prose as
  a second query-string reader.
- Body field specs are written `{ name: "endpoint_url", kind: "text" }` — the same
  literal shape as parameter specs — so milestone 24's file-wide regex read them as
  query parameters that no handler reads.

The scanning helpers moved to `tests/support/source.ts`, shared by both gates, and
are now comment-blind and call-scoped: a declaration belongs to the
`router.get(...)` or `router.post(...)` call it was written in, and a comment is
not code. **What either gate asserts is unchanged** — F3 above puts a real
`ctx.body` back in real code and is still caught, and milestone 24's own
falsification F2 (a declared-but-unread parameter) is still caught by the sharpened
version. String *contents* are deliberately kept in the scan, because the names
these cross-checks look for live inside string literals; the cost is that a gate
word appearing inside a runtime message would still count as code, which is
recorded here rather than hidden.

## Measurement

Identically, locally and in CI:

- Without `DATABASE_URL`: **674 passed**, 147 skipped, plus 1 skipped cluster test.
  Baseline on `main` at `ff0c49f`: 658 passed, 147 skipped.
- With `DATABASE_URL`: **1236 + 1 = 1237 passed**, none skipped. Baseline: 1221.
- `npm run typecheck`, `check-governance.mjs`, `check-contracts.mjs`,
  `check-migrations.mjs`, `check-roadmap.mjs`: all pass.

No existing test needed changing to accommodate the new strictness, which is a
measurement in itself: every request the suite makes was already made of declared
properties, so the 29 routes were strict in intent and loose only in enforcement.

## What this cycle does not claim

- **It does not claim the body is now fully validated.** A declared `text` field
  is any non-empty string: `currency: "banana"` is still the domain's business,
  and `wallet_id` is not checked to be a UUID here. This milestone closes *which
  properties are read*, not what their values may be.
- **It does not claim the declared-vs-read cross-check is per handler.** It is
  per file, as in milestone 24. Two routes in one file that declare different
  fields and read each other's would pass it. The router still refuses per route;
  only the cross-check is file-wide.
- **It does not claim the opaque body on `POST /v1/events` is checked here.** It
  is validated by `normalize.ts` against the published event contracts, and this
  milestone only records that the exemption exists, why, and that there is exactly
  one.
- **It does not claim response bodies are declared.** Nothing in this cycle
  measures what CORE *sends*; the contract cross-check reads `requestBody` only.
- **It does not claim to have found every silent-substitution defect.** It found
  four by measuring one surface. Headers are the third surface after query and
  body, and nothing here touches them.
- **It does not claim the change is non-breaking.** It refuses requests that
  previously succeeded, by design. Milestone 5 records that no external system has
  adopted these contracts yet, which is why now is the cheapest moment; a capture
  that silently takes ten times what was asked is not a compatibility feature.

## Process note, recorded rather than tidied

During falsification a script reverted patches with `git checkout --` while
`body.ts` and the two new test files were still untracked. The revert silently
failed for the untracked file and silently reverted **the whole of three migrated
route modules** (`money`, `organization`, `fulfillment`), so three falsification
readings in that first round were taken against a tree that no longer contained
the work. The three modules were re-migrated, the tree was verified against
`npm run typecheck` and the full suite, the implementation was **committed before
falsification was attempted again**, and every reading in the table above was
taken with a clean tree and confirmed clean after the revert. The first round's
numbers are discarded, not reported. The lesson is recorded here because the
falsification log is only worth what its method is worth.
