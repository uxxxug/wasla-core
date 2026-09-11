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

export function registerMoneyRoutes(router: Router, money: MoneyService, identity: IdentityService): void {
  router.post("/v1/wallets", (ctx) => {
    requirePrincipal(ctx, identity, "money.authorize");
    const input = objectBody(ctx);
    const ownerType = requiredString(input, "owner_type");
    if (ownerType !== "identity" && ownerType !== "organization") throw invalid("unsupported owner_type");
    const result = money.createWallet({
      owner_type: ownerType as WalletOwnerType,
      owner_id: requiredString(input, "owner_id"),
      currency: requiredString(input, "currency"),
      correlation_id: ctx.correlation_id,
    });
    return { status: result.created ? 201 : 200, body: result.wallet };
  });

  router.get("/v1/wallets/:wallet_id/balance", (ctx) => {
    requirePrincipal(ctx, identity, "money.authorize");
    return { status: 200, body: money.balance(ctx.params["wallet_id"] ?? "") };
  });

  router.post("/v1/payment-authorizations", async (ctx) => {
    requirePrincipal(ctx, identity, "money.authorize");
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
    requirePrincipal(ctx, identity, "money.authorize");
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
    requirePrincipal(ctx, identity, "money.authorize");
    const transaction = await money.capture({
      authorization_id: ctx.params["authorization_id"] ?? "",
      correlation_id: ctx.correlation_id,
    });
    return { status: 200, body: transaction };
  });
}