import { dateInZone, type DateOnly } from '@subcycle/shared';
import type { Clock } from './clock.js';

/** The user's current calendar date in their IANA time zone (DST-aware via the zone database). Throws RangeError for an unknown zone. */
export const todayInZone = (clock: Clock, timeZone: string): DateOnly => dateInZone(clock.now(), timeZone);

/**
 * Request-path variant: an unusable stored zone must not turn every request into a 500, so it falls back to UTC.
 * (Registration validates zones and preferences can't change the zone yet, so this is a safety net, not a normal path.)
 */
export function todayForUser(clock: Clock, timeZone: string): DateOnly {
  try {
    return todayInZone(clock, timeZone);
  } catch {
    return todayInZone(clock, 'UTC');
  }
}
