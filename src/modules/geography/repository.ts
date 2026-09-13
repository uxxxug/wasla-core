import type { ReferenceKeys } from "../../platform/persistence/reference-keys.js";
import {
  journalMapWrite,
  type TransactionScope,
} from "../../platform/persistence/transaction.js";
import type { City, Country, Region, ServiceArea } from "./domain.js";
import { putRow } from "../../platform/persistence/row-rules.js";
import { orderedBy } from "../../platform/persistence/list-order.js";

export interface GeographyRepository {
  upsertCountry(country: Country, scope: TransactionScope): Promise<void>;
  getCountry(countryCode: string): Promise<Country | undefined>;
  listCountries(): Promise<readonly Country[]>;
  insertRegion(region: Region, scope: TransactionScope): Promise<void>;
  getRegion(regionId: string): Promise<Region | undefined>;
  findRegion(countryCode: string, code: string): Promise<Region | undefined>;
  listRegions(countryCode: string): Promise<readonly Region[]>;
  insertCity(city: City, scope: TransactionScope): Promise<void>;
  getCity(cityId: string): Promise<City | undefined>;
  listCities(regionId: string): Promise<readonly City[]>;
  insertServiceArea(area: ServiceArea, scope: TransactionScope): Promise<void>;
  getServiceArea(serviceAreaId: string): Promise<ServiceArea | undefined>;
  listServiceAreas(countryCode?: string): Promise<readonly ServiceArea[]>;
}

export class InMemoryGeographyRepository implements GeographyRepository {
  private countries = new Map<string, Country>();
  private regions = new Map<string, Region>();
  private cities = new Map<string, City>();
  private areas = new Map<string, ServiceArea>();

  /**
   * Geography is where the reference backend used to diverge most cheaply: a
   * city naming a country nobody inserted still answered `getCity`, and the
   * five keys registered here are the ones that make that impossible.
   */
  constructor(keys?: ReferenceKeys) {
    keys?.attach("country", this.countries);
    keys?.attach("region", this.regions);
    keys?.attach("city", this.cities);
    keys?.attach("service_area", this.areas);
  }

  async upsertCountry(country: Country, _scope?: TransactionScope): Promise<void> {
    journalMapWrite(_scope, this.countries, country.country_code);
    putRow("country", this.countries, country.country_code, country);
  }
  async getCountry(countryCode: string): Promise<Country | undefined> {
    return this.countries.get(countryCode);
  }
  /** By code, which is what `select ... order by country_code` returns. */
  async listCountries(): Promise<readonly Country[]> {
    return orderedBy(this.countries.values(), (row) => row.country_code);
  }
  /**
   * `region_country_code_code_key`: a region code is unique inside its country,
   * so a service area resolved by code cannot mean two places.
   */
  async insertRegion(region: Region, _scope?: TransactionScope): Promise<void> {
    for (const existing of this.regions.values()) {
      if (existing.region_id === region.region_id) continue;
      if (existing.country_code === region.country_code && existing.code === region.code) {
        throw new Error(
          'duplicate key value violates unique constraint "region_country_code_code_key"',
        );
      }
    }
    journalMapWrite(_scope, this.regions, region.region_id);
    putRow("region", this.regions, region.region_id, region);
  }
  async getRegion(regionId: string): Promise<Region | undefined> {
    return this.regions.get(regionId);
  }
  async findRegion(countryCode: string, code: string): Promise<Region | undefined> {
    return [...this.regions.values()].find((row) => row.country_code === countryCode && row.code === code);
  }
  /** By code: unique inside the country, so the order is total. */
  async listRegions(countryCode: string): Promise<readonly Region[]> {
    return orderedBy(
      [...this.regions.values()].filter((row) => row.country_code === countryCode),
      (row) => row.code,
    );
  }
  async insertCity(city: City, _scope?: TransactionScope): Promise<void> {
    journalMapWrite(_scope, this.cities, city.city_id);
    putRow("city", this.cities, city.city_id, city);
  }
  async getCity(cityId: string): Promise<City | undefined> {
    return this.cities.get(cityId);
  }
  /** By name, then id: two cities may share a name, and the SQL says so too. */
  async listCities(regionId: string): Promise<readonly City[]> {
    return orderedBy(
      [...this.cities.values()].filter((row) => row.region_id === regionId),
      (row) => row.name,
      (row) => row.city_id,
    );
  }
  async insertServiceArea(area: ServiceArea, _scope?: TransactionScope): Promise<void> {
    journalMapWrite(_scope, this.areas, area.service_area_id);
    putRow("service_area", this.areas, area.service_area_id, area);
  }
  async getServiceArea(serviceAreaId: string): Promise<ServiceArea | undefined> {
    return this.areas.get(serviceAreaId);
  }
  /** By name, then id, with or without the country filter. */
  async listServiceAreas(countryCode?: string): Promise<readonly ServiceArea[]> {
    const rows = [...this.areas.values()];
    return orderedBy(
      countryCode ? rows.filter((row) => row.country_code === countryCode) : rows,
      (row) => row.name,
      (row) => row.service_area_id,
    );
  }
}
