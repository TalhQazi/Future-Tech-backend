// UTC storage with location time zones for business operations.
// Uses Intl only (IANA zone names such as "America/Chicago").

export const isValidTimeZone = (tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const partsFor = (date, timeZone) => {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return {
    year: Number(out.year), month: Number(out.month), day: Number(out.day),
    hour: Number(out.hour), minute: Number(out.minute), second: Number(out.second)
  };
};

// Offset in minutes of the zone at the given instant (e.g. -300 for CDT).
export const tzOffsetMinutes = (date, timeZone) => {
  const p = partsFor(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
};

// Location-local calendar date (YYYY-MM-DD) for a UTC instant.
export const localDate = (date, timeZone) => {
  const p = partsFor(date instanceof Date ? date : new Date(date), timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};

export const localTime = (date, timeZone) => {
  const p = partsFor(date instanceof Date ? date : new Date(date), timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

// Converts a wall-clock date + time in a zone into the UTC instant.
export const zonedToUtc = (dateStr, timeStr, timeZone) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = (timeStr || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let offset = tzOffsetMinutes(new Date(guess), timeZone);
  let utc = guess - offset * 60000;
  const offset2 = tzOffsetMinutes(new Date(utc), timeZone);
  if (offset2 !== offset) utc = guess - offset2 * 60000;
  return new Date(utc);
};

// UTC bounds of a location-local business day.
export const localDayBounds = (dateStr, timeZone) => {
  const start = zonedToUtc(dateStr, '00:00', timeZone);
  const [y, m, d] = dateStr.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const nextStr = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
  const end = zonedToUtc(nextStr, '00:00', timeZone);
  return { start, end };
};

export const weekdayKey = (dateStr) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
};

export const isDateString = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
export const isTimeString = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');
