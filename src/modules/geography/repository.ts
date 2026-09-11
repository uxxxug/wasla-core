import type { City, Country, Region, ServiceArea } from "./domain.js";

export interface GeographyRepository {
  upsertCountry(country: Country): void;
  getCountry(countryCode: string): Country | undefined;
  listCountries(): readonly Country[];
  insertRegion(region: Region): void;
  getRegion(regionId: string): Region | undefined;
  findRegion(countryCode: string, code: string): Region | undefined;
  listRegions(countryCode: string): readonly Region[];
  insertCity(city: City): void;
  getCity(cityId: string): City | undefined;
  listCities(regionId: string): readonly City[];
  insertServiceArea(area: ServiceArea): void;
  getServiceArea(serviceAreaId: string): ServiceArea | undefined;
  listServiceAreas(countryCode?: string): readonly ServiceArea[];
}

export class InMemoryGeographyRepository implements GeographyRepository {
  private countries = new Map<string, Country>();
  private regions = new Map<string, Region>();
  private cities = new Map<string, City>();
  private areas = new Map<string, ServiceArea>();

  upsertCountry(country: Country): void {
    this.countries.set(country.country_code, country);
  }
  getCountry(countryCode: string): Country | undefined {
    return this.countries.get(countryCode);
  }
  listCountries(): readonly Country[] {
    return [...this.countries.values()];
  }
  insertRegion(region: Region): void {
    this.regions.set(region.region_id, region);
  }
  getRegion(regionId: string): Region | undefined {
    return this.regions.get(regionId);
  }
  findRegion(countryCode: string, code: string): Region | undefined {
    return [...this.regions.values()].find((row) => row.country_code === countryCode && row.code === code);
  }
  listRegions(countryCode: string): readonly Region[] {
    return [...this.regions.values()].filter((row) => row.country_code === countryCode);
  }
  insertCity(city: City): void {
    this.cities.set(city.city_id, city);
  }
  getCity(cityId: string): City | undefined {
    return this.cities.get(cityId);
  }
  listCities(regionId: string): readonly City[] {
    return [...this.cities.values()].filter((row) => row.region_id === regionId);
  }
  insertServiceArea(area: ServiceArea): void {
    this.areas.set(area.service_area_id, area);
  }
  getServiceArea(serviceAreaId: string): ServiceArea | undefined {
    return this.areas.get(serviceAreaId);
  }
  listServiceAreas(countryCode?: string): readonly ServiceArea[] {
    const rows = [...this.areas.values()];
    return countryCode ? rows.filter((row) => row.country_code === countryCode) : rows;
  }
}
