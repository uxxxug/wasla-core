import type { TransactionScope } from "../../platform/persistence/transaction.js";
import type { City, Country, Region, ServiceArea } from "./domain.js";

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

  async upsertCountry(country: Country, _scope?: TransactionScope): Promise<void> {
    this.countries.set(country.country_code, country);
  }
  async getCountry(countryCode: string): Promise<Country | undefined> {
    return this.countries.get(countryCode);
  }
  async listCountries(): Promise<readonly Country[]> {
    return [...this.countries.values()];
  }
  async insertRegion(region: Region, _scope?: TransactionScope): Promise<void> {
    this.regions.set(region.region_id, region);
  }
  async getRegion(regionId: string): Promise<Region | undefined> {
    return this.regions.get(regionId);
  }
  async findRegion(countryCode: string, code: string): Promise<Region | undefined> {
    return [...this.regions.values()].find((row) => row.country_code === countryCode && row.code === code);
  }
  async listRegions(countryCode: string): Promise<readonly Region[]> {
    return [...this.regions.values()].filter((row) => row.country_code === countryCode);
  }
  async insertCity(city: City, _scope?: TransactionScope): Promise<void> {
    this.cities.set(city.city_id, city);
  }
  async getCity(cityId: string): Promise<City | undefined> {
    return this.cities.get(cityId);
  }
  async listCities(regionId: string): Promise<readonly City[]> {
    return [...this.cities.values()].filter((row) => row.region_id === regionId);
  }
  async insertServiceArea(area: ServiceArea, _scope?: TransactionScope): Promise<void> {
    this.areas.set(area.service_area_id, area);
  }
  async getServiceArea(serviceAreaId: string): Promise<ServiceArea | undefined> {
    return this.areas.get(serviceAreaId);
  }
  async listServiceAreas(countryCode?: string): Promise<readonly ServiceArea[]> {
    const rows = [...this.areas.values()];
    return countryCode ? rows.filter((row) => row.country_code === countryCode) : rows;
  }
}
