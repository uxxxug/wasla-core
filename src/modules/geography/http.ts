import { invalid } from "../../platform/errors.js";
import type { RequestContext, Router } from "../../platform/http/router.js";
import { requirePrincipal } from "../identity-access/http.js";
import type { IdentityService } from "../identity-access/service.js";
import type { GeographyService } from "./service.js";

function objectBody(ctx: RequestContext): Record<string, unknown> {
  if (typeof ctx.body !== "object" || ctx.body === null) throw invalid("JSON object body required");
  return ctx.body as Record<string, unknown>;
}
function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw invalid(`${key} is required`);
  return value;
}
function requiredNumber(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== "number") throw invalid(`${key} is required`);
  return value;
}
function numberParam(ctx: RequestContext, key: string): number {
  const raw = ctx.query.get(key);
  if (raw === null || raw.trim() === "") throw invalid(`${key} is required`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw invalid(`${key} must be a number`);
  return value;
}

export function registerGeographyRoutes(
  router: Router,
  geography: GeographyService,
  identity: IdentityService,
): void {
  // Reference reads are open to any authenticated principal.
  router.get("/v1/geography/countries", (ctx) => {
    requirePrincipal(ctx, identity, "organization.read");
    return { status: 200, body: { countries: geography.countries() } };
  });

  router.get("/v1/geography/countries/:country_code/regions", (ctx) => {
    requirePrincipal(ctx, identity, "organization.read");
    return { status: 200, body: { regions: geography.regions(ctx.params["country_code"] ?? "") } };
  });

  router.get("/v1/geography/regions/:region_id/cities", (ctx) => {
    requirePrincipal(ctx, identity, "organization.read");
    return { status: 200, body: { cities: geography.cities(ctx.params["region_id"] ?? "") } };
  });

  router.get("/v1/geography/service-areas/resolve", (ctx) => {
    requirePrincipal(ctx, identity, "organization.read");
    const countryCode = ctx.query.get("country_code");
    const matches = geography.resolve(
      { latitude: numberParam(ctx, "latitude"), longitude: numberParam(ctx, "longitude") },
      countryCode !== null && countryCode.trim() !== "" ? { country_code: countryCode } : {},
    );
    return { status: 200, body: { serviceable: matches.length > 0, matches } };
  });

  // Reference writes are administrative.
  router.post("/v1/geography/countries", (ctx) => {
    requirePrincipal(ctx, identity, "organization.write");
    const input = objectBody(ctx);
    return {
      status: 201,
      body: geography.registerCountry({
        country_code: requiredString(input, "country_code"),
        name: requiredString(input, "name"),
        default_currency: requiredString(input, "default_currency"),
        correlation_id: ctx.correlation_id,
      }),
    };
  });

  router.post("/v1/geography/regions", (ctx) => {
    requirePrincipal(ctx, identity, "organization.write");
    const input = objectBody(ctx);
    return {
      status: 201,
      body: geography.addRegion({
        country_code: requiredString(input, "country_code"),
        code: requiredString(input, "code"),
        name: requiredString(input, "name"),
        correlation_id: ctx.correlation_id,
      }),
    };
  });

  router.post("/v1/geography/cities", (ctx) => {
    requirePrincipal(ctx, identity, "organization.write");
    const input = objectBody(ctx);
    return {
      status: 201,
      body: geography.addCity({
        region_id: requiredString(input, "region_id"),
        name: requiredString(input, "name"),
        latitude: requiredNumber(input, "latitude"),
        longitude: requiredNumber(input, "longitude"),
        correlation_id: ctx.correlation_id,
      }),
    };
  });

  router.post("/v1/geography/service-areas", (ctx) => {
    requirePrincipal(ctx, identity, "organization.write");
    const input = objectBody(ctx);
    const latitude = input["centre_latitude"];
    const longitude = input["centre_longitude"];
    return {
      status: 201,
      body: geography.defineServiceArea({
        city_id: requiredString(input, "city_id"),
        name: requiredString(input, "name"),
        radius_metres: requiredNumber(input, "radius_metres"),
        ...(typeof latitude === "number" ? { centre_latitude: latitude } : {}),
        ...(typeof longitude === "number" ? { centre_longitude: longitude } : {}),
        correlation_id: ctx.correlation_id,
      }),
    };
  });
}
