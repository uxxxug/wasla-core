import { AUTHENTICATED } from "../../platform/http/authentication.js";
import { objectBody } from "../../platform/http/body.js";
import { natural } from "../../platform/http/retry.js";
import type { Router } from "../../platform/http/router.js";
import { requirePrincipal } from "../identity-access/http.js";
import type { AuthenticatedPrincipal, IdentityService } from "../identity-access/service.js";
import type { WalletOwnerType } from "./domain.js";
import type { MoneyService } from "./service.js";

export function registerMoneyRoutes(router: Router<AuthenticatedPrincipal>, money: MoneyService, identity: IdentityService): void {
  router.post(
    "/v1/wallets",
    objectBody(
      { name: "owner_type", kind: "enum", values: ["identity", "organization"], required: true },
      { name: "owner_id", kind: "text", required: true },
      { name: "currency", kind: "text", required: true },
    ),
    AUTHENTICATED,
    natural(
      "openWallet is an upsert on (owner_type, owner_id, currency): measured on main at bd92b69 the second call answered 200 rather than 201 and the wallet count did not change",
    ),
    async (ctx) => {
    await requirePrincipal(ctx, identity, "money.authorize");
    const result = await money.createWallet({
      owner_type: ctx.input.requiredText("owner_type") as WalletOwnerType,
      owner_id: ctx.input.requiredText("owner_id"),
      currency: ctx.input.requiredText("currency"),
      correlation_id: ctx.correlation_id,
    });
    return { status: result.created ? 201 : 200, body: result.wallet };
  });

  router.get("/v1/wallets/:wallet_id/balance", [], AUTHENTICATED, async (ctx) => {
    await requirePrincipal(ctx, identity, "money.authorize");
    return { status: 200, body: await money.balance(ctx.params["wallet_id"] ?? "") };
  });

  router.post(
    "/v1/payment-authorizations",
    objectBody(
      { name: "wallet_id", kind: "text", required: true },
      { name: "amount_minor", kind: "integer", required: true },
      { name: "business_reference", kind: "text", required: true },
      { name: "expires_at", kind: "text" },
    ),
    AUTHENTICATED,
    natural(
      "the caller supplies business_reference, which is unique per wallet: measured on main at bd92b69 a repeat returned the same authorization_id and added no payment_authorization row, so the amount is not held twice",
    ),
    async (ctx) => {
    await requirePrincipal(ctx, identity, "money.authorize");
    const expiresAt = ctx.input.text("expires_at");
    return {
      status: 201,
      body: await money.authorize({
        wallet_id: ctx.input.requiredText("wallet_id"),
        amount_minor: ctx.input.requiredNumber("amount_minor"),
        business_reference: ctx.input.requiredText("business_reference"),
        correlation_id: ctx.correlation_id,
        ...(typeof expiresAt === "string" ? { expires_at: expiresAt } : {}),
      }),
    };
  });

  router.post(
    "/v1/payment-authorizations/:authorization_id/void",
    objectBody({ name: "reason", kind: "text", required: true }),
    AUTHENTICATED,
    natural(
      "voiding is a transition that cannot happen twice: a voided authorization is already void, and the repeat is answered from that state",
    ),
    async (ctx) => {
    await requirePrincipal(ctx, identity, "money.authorize");
    return {
      status: 200,
      body: await money.voidAuthorization({
        authorization_id: ctx.params["authorization_id"] ?? "",
        reason: ctx.input.requiredText("reason"),
        correlation_id: ctx.correlation_id,
      }),
    };
  });

  router.post(
    "/v1/payment-authorizations/:authorization_id/capture",
    // A body is optional here: omitting it captures the whole remaining hold,
    // which is what this route has always meant — and is exactly why an
    // undeclared property must be refused rather than ignored. Milestone 25 was
    // reserved because `{"amountMinor": 500}` captured 5000 and answered 200.
    objectBody(
      { name: "amount_minor", kind: "integer" },
      { name: "capture_reference", kind: "text" },
    ),
    AUTHENTICATED,
    natural(
      "a capture is recorded under capture:<authorization_id>:<capture_reference>, which is unique: measured on main at bd92b69 a repeat answered 200 and created no second ledger_transaction, so the same money cannot be captured twice under one reference",
    ),
    async (ctx) => {
    await requirePrincipal(ctx, identity, "money.authorize");
    const amount = ctx.input.number("amount_minor");
    const reference = ctx.input.text("capture_reference");
    const transaction = await money.capture({
      authorization_id: ctx.params["authorization_id"] ?? "",
      correlation_id: ctx.correlation_id,
      ...(typeof amount === "number" ? { amount_minor: amount } : {}),
      ...(typeof reference === "string" ? { capture_reference: reference } : {}),
    } as Parameters<MoneyService["capture"]>[0]);
    return { status: 200, body: transaction };
  });

  router.post(
    "/v1/payment-authorizations/:authorization_id/refund",
    objectBody(
      { name: "refund_reference", kind: "text", required: true },
      { name: "reason", kind: "text", required: true },
      { name: "amount_minor", kind: "integer" },
    ),
    AUTHENTICATED,
    natural(
      "a refund is recorded under refund:<authorization_id>:<refund_reference> in the same way: measured on main at bd92b69 a repeat answered 200 and created no second ledger_transaction",
    ),
    async (ctx) => {
    await requirePrincipal(ctx, identity, "money.authorize");
    const amount = ctx.input.number("amount_minor");
    return {
      status: 200,
      body: await money.refund({
        authorization_id: ctx.params["authorization_id"] ?? "",
        // Required, unlike capture: there is no "the" refund of an
        // authorization, so there is no key CORE could derive on the
        // caller's behalf and no way to make a retry safe without one.
        refund_reference: ctx.input.requiredText("refund_reference"),
        reason: ctx.input.requiredText("reason"),
        correlation_id: ctx.correlation_id,
        ...(typeof amount === "number" ? { amount_minor: amount } : {}),
      }),
    };
  });
}