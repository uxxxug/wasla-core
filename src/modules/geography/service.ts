import type { AuditLog } from "../../platform/audit/audit.js";
import type { TransactionBoundary } from "../../platform/persistence/transaction.js";
import { withTransaction } from "../../platform/eventing/unit-of-work.js";
import { conflict, invalid, notFound } from "../../platform/errors.js";
import { newId } from "../../platform/ids.js";
import {
  assertCountryCode,
  assertPoint,
  covers,
  distanceMetres,
  type City,
  type Country,
  type Point,
  type Region,
  type ServiceArea,
} from "./domain.js";
import type { GeographyRepository } from "./repository.js";

/**
 * Reference geography service. Reads are the hot path for both products;
 * writes are administrative and audited. No events are published: reference
 * data changes rarely and consumers read it through the API (ADR 0009 —
 * events carry business facts, not reference-table churn).
 */
export class GeographyService {
  constructor(
    private readonly repo: GeographyRepository,
    private readonly audit: AuditLog,
    private readonly boundary: TransactionBoundary,
  ) {}

  /**
   * Reference-data writes publish no event (ADR 0009) but are still
   * transactional, because the row and the audit entry describing it have to
   * land together. This was B-9.
   */
  private get tx() {
    return { boundary: this.boundary, audit: this.audit };
  }

  async registerCountry(input: {
    country_code: string;
    name: string;
    default_currency: string;
    correlation_id: string;
  }): Promise<Country> {
    const countryCode = this.countryCode(input.country_code);
    if (!input.name.trim()) throw invalid("name is required");
    const currency = input.default_currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw invalid("default_currency must be an ISO 4217 code");
    const country: Country = {
      country_code: countryCode,
      name: input.name.trim(),
      default_currency: currency,
      status: "active",
    };
    await withTransaction(this.tx, (uow) => {
      uow.stage((scope) => this.repo.upsertCountry(country, scope));
      uow.audit({
        actor_type: "service",
        actor_id: null,
        action: "geography.country.registered",
        entity_type: "country",
        entity_id: countryCode,
        correlation_id: input.correlation_id,
        metadata: { default_currency: currency },
      });
    });
    return country;
  }

  async addRegion(input: { country_code: string; code: string; name: string; correlation_id: string }): Promise<Region> {
    const countryCode = this.countryCode(input.country_code);
    await this.requireCountry(countryCode);
    const code = input.code.trim().toUpperCase();
    if (!code) throw invalid("code is required");
    const existing = await this.repo.findRegion(countryCode, code);
    if (existing) return existing;
    const region: Region = {
      region_id: newId(),
      country_code: countryCode,
      code,
      name: input.name.trim() || code,
      status: "active",
    };
    await withTransaction(this.tx, (uow) => {
      uow.stage((scope) => this.repo.insertRegion(region, scope));
      uow.audit({
        actor_type: "service",
        actor_id: null,
        action: "geography.region.added",
        entity_type: "region",
        entity_id: region.region_id,
        correlation_id: input.correlation_id,
        metadata: { country_code: countryCode, code },
      });
    });
    return region;
  }

  async addCity(input: {
    region_id: string;
    name: string;
    latitude: number;
    longitude: number;
    correlation_id: string;
  }): Promise<City> {
    const region = await this.repo.getRegion(input.region_id);
    if (!region) throw notFound("region not found");
    if (!input.name.trim()) throw invalid("name is required");
    this.point({ latitude: input.latitude, longitude: input.longitude });
    const city: City = {
      city_id: newId(),
      region_id: region.region_id,
      country_code: region.country_code,
      name: input.name.trim(),
      latitude: input.latitude,
      longitude: input.longitude,
      status: "active",
    };
    await withTransaction(this.tx, (uow) => {
      uow.stage((scope) => this.repo.insertCity(city, scope));
      uow.audit({
        actor_type: "service",
        actor_id: null,
        action: "geography.city.added",
        entity_type: "city",
        entity_id: city.city_id,
        correlation_id: input.correlation_id,
        metadata: { region_id: region.region_id },
      });
    });
    return city;
  }

  async defineServiceArea(input: {
    city_id: string;
    name: string;
    radius_metres: number;
    centre_latitude?: number;
    centre_longitude?: number;
    correlation_id: string;
  }): Promise<ServiceArea> {
    const city = await this.repo.getCity(input.city_id);
    if (!city) throw notFound("city not found");
    if (!input.name.trim()) throw invalid("name is required");
    if (!Number.isFinite(input.radius_metres) || input.radius_metres <= 0) {
      throw invalid("radius_metres must be a positive number");
    }
    if (input.radius_metres > 500_000) throw conflict("radius_metres exceeds the reference-data limit");
    const centre = this.point({
      latitude: input.centre_latitude ?? city.latitude,
      longitude: input.centre_longitude ?? city.longitude,
    });
    const area: ServiceArea = {
      service_area_id: newId(),
      city_id: city.city_id,
      country_code: city.country_code,
      name: input.name.trim(),
      centre_latitude: centre.latitude,
      centre_longitude: centre.longitude,
      radius_metres: Math.round(input.radius_metres),
      status: "active",
    };
    await withTransaction(this.tx, (uow) => {
      uow.stage((scope) => this.repo.insertServiceArea(area, scope));
      uow.audit({
        actor_type: "service",
        actor_id: null,
        action: "geography.service_area.defined",
        entity_type: "service_area",
        entity_id: area.service_area_id,
        correlation_id: input.correlation_id,
        metadata: { city_id: city.city_id, radius_metres: area.radius_metres },
      });
    });
    return area;
  }

  async countries(): Promise<readonly Country[]> {
    return await this.repo.listCountries();
  }

  async regions(countryCode: string): Promise<readonly Region[]> {
    const code = this.countryCode(countryCode);
    await this.requireCountry(code);
    return await this.repo.listRegions(code);
  }

  async cities(regionId: string): Promise<readonly City[]> {
    if (!await this.repo.getRegion(regionId)) throw notFound("region not found");
    return await this.repo.listCities(regionId);
  }

  async requireServiceArea(serviceAreaId: string): Promise<ServiceArea> {
    const area = await this.repo.getServiceArea(serviceAreaId);
    if (!area) throw notFound("service area not found");
    return area;
  }

  /**
   * Resolves which active service areas contain a point, nearest centre first.
   * This is a reference lookup, not dispatch: it says where the platform
   * operates, never who is available or how to get there.
   */
  async resolve(
    point: Point,
    options: { country_code?: string } = {},
  ): Promise<readonly { service_area: ServiceArea; distance_metres: number }[]> {
    const target = this.point(point);
    const within = options.country_code ? this.countryCode(options.country_code) : undefined;
    const areas = await this.repo.listServiceAreas(within);
    return areas
      .filter((area) => covers(area, target))
      .map((area) => ({
        service_area: area,
        distance_metres: distanceMetres(
          { latitude: area.centre_latitude, longitude: area.centre_longitude },
          target,
        ),
      }))
      .sort((a, b) => a.distance_metres - b.distance_metres);
  }

  private async requireCountry(countryCode: string): Promise<Country> {
    const country = await this.repo.getCountry(countryCode);
    if (!country) throw notFound("country not found");
    return country;
  }

  private countryCode(value: string): string {
    try {
      return assertCountryCode(value);
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : "invalid country_code");
    }
  }

  private point(point: Point): Point {
    try {
      return assertPoint(point);
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : "invalid coordinates");
    }
  }
}
