export function parseOrderDate(raw: any): Date {
  if (!raw || typeof raw !== 'string') {
    throw new Error(`Missing or invalid created_date: ${raw}`);
  }

  // Try DD/MM/YYYY HH:mm
  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
  if (m) {
    const [, dd, mm, yyyy, hh, min] = m.map(Number);
    return new Date(yyyy, mm - 1, dd, hh, min);
  }

  // Fallback: native Date parse (e.g. ISO)
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d;

  throw new Error(`Unrecognised date format: ${raw}`);
}

/**
 * Format a Date (or date-like) into MySQL DATETIME: "YYYY-MM-DD HH:mm:ss"
 */
export function formatToMySqlDateTime(input: Date | string): string {
  const d = input instanceof Date ? input : new Date(input);

  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));

  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}
export function addMinutes(input: Date | string, minutes: number): Date {
  const d = input instanceof Date ? new Date(input) : new Date(input);
  d.setMinutes(d.getMinutes() + minutes);
  return d;
}
