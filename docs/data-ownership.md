# WASLA — Data Ownership

One entity, one source of truth. Other systems may hold an id, an opaque
reference or a projection — never a second source of truth.

## CORE owns

Identity, Identity Link, Session, Principal, Role, Permission grant,
Organization, Membership, Geography reference, shared Pricing rules,
Negotiation model, Payment, Wallet, Ledger, Settlement, Plan, Subscription,
Period, Entitlement, Usage, Reputation, Trust signal, Notification, Message,
Support case, Document, KYC record, Referral, Audit entry, Outbox, Inbox,
Channel, Channel adapter, Integration, Fulfillment.

## MOVE owns (`noor-seez/ceezr`)

Driver, driver profile/capability/eligibility/availability, Vehicle, Fleet,
Operational Job, Ride, Delivery execution, Dispatch, Matching, Offer,
Assignment, Tracking, route/execution state, Proof of Delivery, Safety, SOS,
driver and rider operational surfaces.

## MARKET owns (`skyosv10-art/wasla`)

Merchant, Store, store staff, Product, Category, Catalog, Inventory,
Reservation, Commercial Order, Order Item, Search, commercial review content,
marketplace and B2B/partner commerce surfaces, store pricing.

## Forbidden

- Cross-database reads of another system's tables.
- Direct foreign keys across system boundaries.
- Shared mutable tables.
- A CORE endpoint returning MOVE- or MARKET-owned data.
- A direct MOVE ↔ MARKET business call.

Enforced by `scripts/check-governance.mjs` and `tests/governance.test.ts`.

## Cross-references CORE may hold

`order_ref`, `job_ref`, `fulfillment_ref` — opaque strings. CORE stores them to
correlate a fulfillment; it does not interpret or expose their contents.
