import { AUTHENTICATED } from "../../platform/http/authentication.js";
import { objectBody } from "../../platform/http/body.js";
import type { Router } from "../../platform/http/router.js";
import { requirePrincipal } from "../identity-access/http.js";
import type { AuthenticatedPrincipal, IdentityService } from "../identity-access/service.js";
import type { GeographyService } from "./service.js";

export function registerGeographyRoutes(
  router: Router<AuthenticatedPrincipal>,
  geography: GeographyService,
  identity: IdentityService,
): void {
  // Reference reads are open to any authenticated principal.
  router.get("/v1/geography/countries", [], AUTHENTICATED, async (ctx) => {
    await requirePrincipal(ctx, identity, "organization.read");
    return { status: 200, body: { countries: await geography.countries() } };
  });

  router.get("/v1/geography/countries/:country_code/regions", [], AUTHENTICATED, async (ctx) => {
    await requirePrincipal(ctx, identity, "organization.read");
    return { status: 200, body: { regions: await geography.regions(ctx.params["country_code"] ?? "") } };
  });

  router.get("/v1/geography/regions/:region_id/cities", [], AUTHENTICATED, async (ctx) => {
    await requirePrincipal(ctx, identity, "organization.read");
    return { status: 200, body: { cities: await geography.cities(ctx.params["region_id"] ?? "") } };
  });

  router.get(
    "/v1/geography/service-areas/resolve",
    [
      { name: "latitude", kind: "decimal", required: true },
      { name: "longitude", kind: "decimal", required: true },
      { name: "country_code", kind: "text" },
    ],
    AUTHENTICATED,
    async (ctx) => {
    await requirePrincipal(ctx, identity, "organization.read");
    const countryCode = ctx.selection.text("country_code");
    const matches = await geography.resolve(
      {
        latitude: ctx.selection.number("latitude"),
        longitude: ctx.selection.number("longitude"),
      },
      countryCode === undefined ? {} : { country_code: countryCode },
    );
    return { status: 200, body: { serviceable: matches.length > 0, matches } };
  });

  // Reference writes are administrative.
  router.post(
    "/v1/geography/countries",
    objectBody(
      { name: "country_code", kind: "text", required: true },
      { name: "name", kind: "text", required: true },
      { name: "default_currency", kind: "text", required: true },
    ),
    AUTHENTICATED,
    async (ctx) => {
    await requirePrincipal(ctx, identity, "organization.write");
    return {
      status: 201,
      body: await geography.registerCountry({
        country_code: ctx.input.requiredText("country_code"),
        name: ctx.input.requiredText("name"),
        default_currency: ctx.input.requiredText("default_currency"),
        correlation_id: ctx.correlation_id,
      }),
    };
  });

  router.post(
    "/v1/geography/regions",
    objectBody(
      { name: "country_code", kind: "text", required: true },
      { name: "code", kind: "text", required: true },
      { name: "name", kind: "text", required: true },
    ),
    AUTHENTICATED,
    async (ctx) => {
    await requirePrincipal(ctx, identity, "organization.write");
    return {
      status: 201,
      body: await geography.addRegion({
        country_code: ctx.input.requiredText("country_code"),
        code: ctx.input.requiredText("code"),
        name: ctx.input.requiredText("name"),
        correlation_id: ctx.correlation_id,
      }),
    };
  });

  router.post(
    "/v1/geography/cities",
    objectBody(
      { name: "region_id", kind: "text", required: true },
      { name: "name", kind: "text", required: true },
      { name: "latitude", kind: "number", required: true },
      { name: "longitude", kind: "number", required: true },
    ),
    AUTHENTICATED,
    async (ctx) => {
    await requirePrincipal(ctx, identity, "organization.write");
    return {
      status: 201,
      body: await geography.addCity({
        region_id: ctx.input.requiredText("region_id"),
        name: ctx.input.requiredText("name"),
        latitude: ctx.input.requiredNumber("latitude"),
        longitude: ctx.input.requiredNumber("longitude"),
        correlation_id: ctx.correlation_id,
      }),
    };
  });

  router.post(
    "/v1/geography/service-areas",
    objectBody(
      { name: "city_id", kind: "text", required: true },
      { name: "name", kind: "text", required: true },
      { name: "radius_metres", kind: "number", required: true },
      { name: "centre_latitude", kind: "number" },
      { name: "centre_longitude", kind: "number" },
    ),
    AUTHENTICATED,
    async (ctx) => {
    await requirePrincipal(ctx, identity, "organization.write");
    const latitude = ctx.input.number("centre_latitude");
    const longitude = ctx.input.number("centre_longitude");
    return {
      status: 201,
      body: await geography.defineServiceArea({
        city_id: ctx.input.requiredText("city_id"),
        name: ctx.input.requiredText("name"),
        radius_metres: ctx.input.requiredNumber("radius_metres"),
        ...(typeof latitude === "number" ? { centre_latitude: latitude } : {}),
        ...(typeof longitude === "number" ? { centre_longitude: longitude } : {}),
        correlation_id: ctx.correlation_id,
      }),
    };
  });
}
