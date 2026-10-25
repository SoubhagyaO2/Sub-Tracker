/** All time-dependent code takes a Clock so tests can control time deterministically. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  private current: Date;
  constructor(start: Date | string) {
    this.current = new Date(start);
  }
  now(): Date {
    return new Date(this.current);
  }
  set(to: Date | string): void {
    this.current = new Date(to);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
