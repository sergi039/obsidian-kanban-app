/** SQLite `datetime('now')` writes UTC as `YYYY-MM-DD HH:MM:SS`, with no zone. */
const ZONELESS_UTC = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

/**
 * Read a timestamp from the API as the moment it names. A zone-less value is UTC from
 * SQLite; `new Date` would read it as local time and shift it by the viewer's offset
 * (backlog B-5). A value with `Z` or an offset is read as it is.
 */
export function parseServerTime(value: string): Date {
  const match = ZONELESS_UTC.exec(value);
  return new Date(match ? `${match[1]}T${match[2]}Z` : value);
}
