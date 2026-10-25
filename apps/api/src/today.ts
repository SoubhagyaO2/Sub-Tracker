import { dateInZone, type DateOnly } from '@subcycle/shared';
import type { Clock } from './clock.js';

/** The user's current calendar date in their IANA time zone (DST-aware via the zone database). */
export const todayInZone = (clock: Clock, timeZone: string): DateOnly => dateInZone(clock.now(), timeZone);
