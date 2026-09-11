/**
 * Geography reference data (CORE-owned, ADR 0002).
 *
 * CORE owns the shared *reference* geography only: countries, regions, cities
 * and named service areas that both products resolve against. CORE does not
 * own live positions, routes, tracking, ETAs, dispatch zones or any moving
 * object — those belong to MOVE. Nothing here knows a driver or a job exists.
 */
export type GeoStatus = "active" | "inactive";

export interface Country {
  country_code: string; // ISO 3166-1 alpha-2
  name: string;
  default_currency: string; // ISO 4217
  status: GeoStatus;
}

export interface Region {
  region_id: string;
  country_code: string;
  code: string; // stable, unique within the country
  name: string;
  status: GeoStatus;
}

export interface City {
  city_id: string;
  region_id: string;
  country_code: string;
  name: string;
  latitude: number;
  longitude: number;
  status: GeoStatus;
}

/**
 * A named operating area, modelled as a centre and a radius. Deliberately the
 * simplest shape that answers "is this point serviceable?" — polygons are only
 * introduced when a real requirement needs them.
 */
export interface ServiceArea {
  service_area_id: string;
  city_id: string;
  country_code: string;
  name: string;
  centre_latitude: number;
  centre_longitude: number;
  radius_metres: number;
  status: GeoStatus;
}

export interface Point {
  latitude: number;
  longitude: number;
}

export function assertCountryCode(value: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw new Error("country_code must be ISO 3166-1 alpha-2");
  return code;
}

export function assertPoint(point: Point): Point {
  if (!Number.isFinite(point.latitude) || point.latitude < -90 || point.latitude > 90) {
    throw new Error("latitude must be between -90 and 90");
  }
  if (!Number.isFinite(point.longitude) || point.longitude < -180 || point.longitude > 180) {
    throw new Error("longitude must be between -180 and 180");
  }
  return point;
}

const EARTH_RADIUS_METRES = 6_371_000;

/** Great-circle distance in metres. Pure, deterministic, dependency-free. */
export function distanceMetres(from: Point, to: Point): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLatitude = toRadians(to.latitude - from.latitude);
  const deltaLongitude = toRadians(to.longitude - from.longitude);
  const a =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) * Math.cos(toRadians(to.latitude)) * Math.sin(deltaLongitude / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(a))));
}

export function covers(area: ServiceArea, point: Point): boolean {
  if (area.status !== "active") return false;
  return (
    distanceMetres({ latitude: area.centre_latitude, longitude: area.centre_longitude }, point) <= area.radius_metres
  );
}
