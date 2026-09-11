import { invalid } from "../../platform/errors.js";
import type { RequestContext, Router } from "../../platform/http/router.js";
import { requirePrincipal } from "../identity-access/http.js";
import type { IdentityService } from "../identity-access/service.js";
import type { WalletOwnerType } from "./domain.js";
import type { MoneyService } from "./service.js";

function objectBody(ctx: RequestContext): Record<string, unknown> {
  if (typeof ctx.body !== "object" || ctx.body === null) throw invalid("JSON object body required");
  return ctx.body as Record<string, unknown>;
}
function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw invalid(`${key} is required`);
  return value;
}
function requiredAmount(input: Record<string, unknown>): number {
  const value = input["amount_minor"];
  if (typeof value !== "number") throw invalid("amount_minor is required");
  return value;
}
/**
 * An absent amount means "all of it", which is not the same as zero and must
 * not be coerced into one. A present non-number is a malformed request rather
 * than a request for everything, so it is refused instead of defaulted.
 */
function optionalAmount(input: Record<string, unknown>): { amount_minor?: number } {
  if (!("amount_minor" in input) || input["amount_minor"] === undefined) return {};
  const value = input["amount_minor"];
  if (typeof value !== "number") throw invalid("amount_minor must be a number when present");
  return { amount_minor: value };
}
function optionalString(input: Record<string, unknown>, key: string): Record<string, string> {
  const value = input[key];
  if (value === undefined) return {};
  if (typeof value !== "string" || !value.trim()) throw invalid(`${key} must be a non-empty string`);
  return { [key]: value };
}

export function registerMoneyRoutes(router: Router, money: MoneyService, identity: IdentityService): void {
  router.post("/v1/wallets", async (ctx) => {
    await requirePrincipal(ctx, identity, "money.authorize");
    const input = objectBody(ctx);
    const ownerType = requiredString(input, "owner_type");
    if (ownerType !== "identity" && ownerType !== "organization") throw invalid("unsupported owner_type");
    const result = await money.createWallet({
      owner_type: ownerType as WalletOwnerType,
      owner_id: requiredString(input, "owner_id"),
      currency: requiredString(input, "currency"),
      correlation_id: ctx.correlation_id,
    });
    return { status: result.created ? 201 : 200, body: result.wallet };
  });

  router.get("/v1/wallets/:wallet_id/balance", async (ctx) => {
    await requirePrincipal(ctx, identity, "money.authorize");
    return { status: 200, body: await money.balance(ctx.params["wallet_id"] ?? "") };
  });

  router.post("/v1/payment-authorizations", async (ctx) => {
    await requirePrincipal(ctx, identity, "money.authorize");
    const input = objectBody(ctx);
    return {
      status: 201,
      body: await money.authorize({
        wallet_id: requiredString(input, "wallet_id"),
        amount_minor: requiredAmount(input),
        business_reference: requiredString(input, "business_reference"),
        correlation_id: ctx.correlation_id,
        ...(typeof input["expires_at"] === "string" ? { expires_at: input["expires_at"] } : {}),
      }),
    };
  });

  router.post("/v1/payment-authorizations/:authorization_id/void", async (ctx) => {
    await requirePrincipal(ctx, identity, "money.authorize");
    const input = objectBody(ctx);
    return {
      status: 200,
      body: await money.voidAuthorization({
        authorization_id: ctx.params["authorization_id"] ?? "",
        reason: requiredString(input, "reason"),
        correlation_id: ctx.correlation_id,
      }),
    };
  });

  router.post("/v1/payment-authorizations/:authorization_id/capture", async (ctx) => {
    await requirePrincipal(ctx, identity, "money.authorize");
    // A body is optional here: omitting it captures the whole remaining hold,
    // which is what this route has always meant.
    const input = typeof ctx.body === "object" && ctx.body !== null
      ? (ctx.body as Record<string, unknown>)
      : {};
    const transaction = await money.capture({
      authorization_id: ctx.params["authorization_id"] ?? "",
      correlation_id: ctx.correlation_id,
      ...optionalAmount(input),
      ...optionalString(input, "capture_reference"),
    } as Parameters<MoneyService["capture"]>[0]);
    return { status: 200, body: transaction };
  });

  router.post("/v1/payment-authorizations/:authorization_id/refund", async (ctx) => {
    await requirePrincipal(ctx, identity, "money.authorize");
    const input = objectBody(ctx);
    return {
      status: 200,
      body: await money.refund({
        authorization_id: ctx.params["authorization_id"] ?? "",
        // Required, unlike capture: there is no "the" refund of an
        // authorization, so there is no key CORE could derive on the
        // caller's behalf and no way to make a retry safe without one.
        refund_reference: requiredString(input, "refund_reference"),
        reason: requiredString(input, "reason"),
        correlation_id: ctx.correlation_id,
        ...optionalAmount(input),
      }),
    };
  });
}