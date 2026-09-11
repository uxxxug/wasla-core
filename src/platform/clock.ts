export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Test clock — lets time-dependent behaviour (sessions, retries) be asserted. */
export class FixedClock implements Clock {
  private current: Date;
  constructor(start: Date = new Date("2026-01-01T00:00:00.000Z")) {
    this.current = start;
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
