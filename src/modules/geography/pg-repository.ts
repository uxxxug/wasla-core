import { runner, type Queryable } from "../../platform/persistence/postgres.js";
import { NO_SCOPE, type TransactionScope } from "../../platform/persistence/transaction.js";
import type { City, Country, GeoStatus, Region, ServiceArea } from "./domain.js";
import type { GeographyRepository } from "./repository.js";

/**
 * `country_code` and `default_currency` are fixed-width `char` columns, so
 * Postgres pads them. Trimming on read is what keeps a value read back equal
 * to the value written.
 */
const trim = (value: string) => value.trim();

interface CountryRow {
  country_code: string;
  name: string;
  default_currency: string;
  status: GeoStatus;
}
interface RegionRow {
  region_id: string;
  country_code: string;
  code: string;
  name: string;
  status: GeoStatus;
}
interface CityRow {
  city_id: string;
  region_id: string;
  country_code: string;
  name: string;
  latitude: number;
  longitude: number;
  status: GeoStatus;
}
interface ServiceAreaRow {
  service_area_id: string;
  city_id: string;
  country_code: string;
  name: string;
  centre_latitude: number;
  centre_longitude: number;
  radius_metres: number;
  status: GeoStatus;
}

const toCountry = (row: CountryRow): Country => ({
  country_code: trim(row.country_code),
  name: row.name,
  default_currency: trim(row.default_currency),
  status: row.status,
});

const toRegion = (row: RegionRow): Region => ({
  region_id: row.region_id,
  country_code: trim(row.country_code),
  code: row.code,
  name: row.name,
  status: row.status,
});

const toCity = (row: CityRow): City => ({
  city_id: row.city_id,
  region_id: row.region_id,
  country_code: trim(row.country_code),
  name: row.name,
  latitude: Number(row.latitude),
  longitude: Number(row.longitude),
  status: row.status,
});

const toServiceArea = (row: ServiceAreaRow): ServiceArea => ({
  service_area_id: row.service_area_id,
  city_id: row.city_id,
  country_code: trim(row.country_code),
  name: row.name,
  centre_latitude: Number(row.centre_latitude),
  centre_longitude: Number(row.centre_longitude),
  radius_metres: Number(row.radius_metres),
  status: row.status,
});

const COUNTRY = `country_code, name, default_currency, status`;
const REGION = `region_id, country_code, code, name, status`;
const CITY = `city_id, region_id, country_code, name, latitude, longitude, status`;
const AREA = `service_area_id, city_id, country_code, name, centre_latitude,
  centre_longitude, radius_metres, status`;

/** Postgres adapter for the geography reference ports. */
export class PgGeographyRepository implements GeographyRepository {
  constructor(private readonly pool: Queryable) {}

  async upsertCountry(country: Country, scope: TransactionScope = NO_SCOPE): Promise<void> {
    await runner(this.pool, scope).query(
      `insert into country (${COUNTRY}) values ($1,$2,$3,$4)
       on conflict (country_code) do update
         set name = excluded.name,
             default_currency = excluded.default_currency,
             status = excluded.status`,
      [country.country_code, country.name, country.default_currency, country.status],
    );
  }

  async getCountry(countryCode: string): Promise<Country | undefined> {
    const result = await this.pool.query<CountryRow>(
      `select ${COUNTRY} from country where country_code = $1`,
      [countryCode],
    );
    const row = result.rows[0];
    return row ? toCountry(row) : undefined;
  }

  async listCountries(): Promise<readonly Country[]> {
    const result = await this.pool.query<CountryRow>(
      `select ${COUNTRY} from country order by country_code collate "C"`,
    );
    return result.rows.map(toCountry);
  }

  async insertRegion(region: Region, scope: TransactionScope = NO_SCOPE): Promise<void> {
    await runner(this.pool, scope).query(
      `insert into region (${REGION}) values ($1,$2,$3,$4,$5)`,
      [region.region_id, region.country_code, region.code, region.name, region.status],
    );
  }

  async getRegion(regionId: string): Promise<Region | undefined> {
    const result = await this.pool.query<RegionRow>(
      `select ${REGION} from region where region_id = $1`,
      [regionId],
    );
    const row = result.rows[0];
    return row ? toRegion(row) : undefined;
  }

  async findRegion(countryCode: string, code: string): Promise<Region | undefined> {
    const result = await this.pool.query<RegionRow>(
      `select ${REGION} from region where country_code = $1 and code = $2`,
      [countryCode, code],
    );
    const row = result.rows[0];
    return row ? toRegion(row) : undefined;
  }

  async listRegions(countryCode: string): Promise<readonly Region[]> {
    const result = await this.pool.query<RegionRow>(
      `select ${REGION} from region where country_code = $1 order by code collate "C"`,
      [countryCode],
    );
    return result.rows.map(toRegion);
  }

  async insertCity(city: City, scope: TransactionScope = NO_SCOPE): Promise<void> {
    await runner(this.pool, scope).query(
      `insert into city (${CITY}) values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        city.city_id,
        city.region_id,
        city.country_code,
        city.name,
        city.latitude,
        city.longitude,
        city.status,
      ],
    );
  }

  async getCity(cityId: string): Promise<City | undefined> {
    const result = await this.pool.query<CityRow>(`select ${CITY} from city where city_id = $1`, [
      cityId,
    ]);
    const row = result.rows[0];
    return row ? toCity(row) : undefined;
  }

  async listCities(regionId: string): Promise<readonly City[]> {
    const result = await this.pool.query<CityRow>(
      `select ${CITY} from city where region_id = $1 order by name collate "C", city_id`,
      [regionId],
    );
    return result.rows.map(toCity);
  }

  async insertServiceArea(area: ServiceArea, scope: TransactionScope = NO_SCOPE): Promise<void> {
    await runner(this.pool, scope).query(
      `insert into service_area (${AREA}) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        area.service_area_id,
        area.city_id,
        area.country_code,
        area.name,
        area.centre_latitude,
        area.centre_longitude,
        area.radius_metres,
        area.status,
      ],
    );
  }

  async getServiceArea(serviceAreaId: string): Promise<ServiceArea | undefined> {
    const result = await this.pool.query<ServiceAreaRow>(
      `select ${AREA} from service_area where service_area_id = $1`,
      [serviceAreaId],
    );
    const row = result.rows[0];
    return row ? toServiceArea(row) : undefined;
  }

  async listServiceAreas(countryCode?: string): Promise<readonly ServiceArea[]> {
    const result =
      countryCode === undefined
        ? await this.pool.query<ServiceAreaRow>(
            `select ${AREA} from service_area order by name collate "C", service_area_id`,
          )
        : await this.pool.query<ServiceAreaRow>(
            `select ${AREA} from service_area where country_code = $1 order by name collate "C", service_area_id`,
            [countryCode],
          );
    return result.rows.map(toServiceArea);
  }
}
