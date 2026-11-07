// Public compatibility facade. Product code imports the narrow time module it uses.
export { resolveTimeZone, setConfigTimeZoneSource } from './time-zone.js';
export type { ResolvedTimeZone, ResolveTimeZoneDeps } from './time-zone.js';
export type { TimeFormatOpts } from './format-core.js';
export { formatClock } from './clock.js';
export { dateKey, formatDateTime, calendarFields, formatShortDateTime } from './calendar.js';
export type { CalendarFields } from './calendar.js';
