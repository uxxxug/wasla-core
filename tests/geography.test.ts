import { describe, expect, it } from "vitest";
import { createCoreApp } from "../src/app.js";
import { FixedClock } from "../src/platform/clock.js";
import { distanceMetres } from "../src/modules/geography/domain.js";

async function seed() {
  const core = createCoreApp({ clock: new FixedClock() });
  await core.geography.registerCountry({
    country_code: "sa",
    name: "Saudi Arabia",
    default_currency: "sar",
    correlation_id: "c",
  });
  const region = await core.geography.addRegion({
    country_code: "SA",
    code: "riyadh",
    name: "Riyadh Region",
    correlation_id: "c",
  });
  const city = await core.geography.addCity({
    region_id: region.region_id,
    name: "Riyadh",
    latitude: 24.7136,
    longitude: 46.6753,
    correlation_id: "c",
  });
  return { core, region, city };
}

describe("geography", () => {
  it("normalises reference codes and keeps region codes unique per country", async () => {
    const { core, region } = await seed();
    expect((await core.geography.countries())[0]?.country_code).toBe("SA");
    expect((await core.geography.countries())[0]?.default_currency).toBe("SAR");
    const repeated = await core.geography.addRegion({
      country_code: "SA",
      code: "RIYADH",
      name: "Duplicate attempt",
      correlation_id: "c",
    });
    expect(repeated.region_id).toBe(region.region_id);
    expect(await core.geography.regions("sa")).toHaveLength(1);
  });

  it("resolves serviceable points, nearest area first, and rejects points outside", async () => {
    const { core, city } = await seed();
    const wide = await core.geography.defineServiceArea({
      city_id: city.city_id,
      name: "Riyadh metropolitan",
      radius_metres: 40_000,
      correlation_id: "c",
    });
    const narrow = await core.geography.defineServiceArea({
      city_id: city.city_id,
      name: "Olaya core",
      radius_metres: 6_000,
      centre_latitude: 24.6949,
      centre_longitude: 46.6863,
      correlation_id: "c",
    });

    const inside = await core.geography.resolve({ latitude: 24.6949, longitude: 46.6863 });
    expect(inside.map((match) => match.service_area.service_area_id as string)).toEqual([
      narrow.service_area_id,
      wide.service_area_id,
    ]);
    expect(inside[0]?.distance_metres).toBe(0);

    expect(await core.geography.resolve({ latitude: 21.4858, longitude: 39.1925 })).toHaveLength(0);
  });

  it("validates coordinates and unknown parents", async () => {
    const { core, region } = await seed();
    await expect(
      core.geography.addCity({
        region_id: region.region_id,
        name: "Nowhere",
        latitude: 120,
        longitude: 0,
        correlation_id: "c",
      }),
    ).rejects.toThrow(/latitude/);
    await expect(
      core.geography.defineServiceArea({
        city_id: "missing",
        name: "x",
        radius_metres: 100,
        correlation_id: "c",
      }),
    ).rejects.toThrow(/city not found/);
    await expect(core.geography.regions("XX")).rejects.toThrow(/country not found/);
  });

  it("measures great-circle distance deterministically", async () => {
    const riyadh = { latitude: 24.7136, longitude: 46.6753 };
    const jeddah = { latitude: 21.4858, longitude: 39.1925 };
    const metres = distanceMetres(riyadh, jeddah);
    expect(metres).toBeGreaterThan(840_000);
    expect(metres).toBeLessThan(870_000);
    expect(distanceMetres(riyadh, riyadh)).toBe(0);
  });
});
