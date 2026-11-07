/** PGN dates are YYYY.MM.DD with ?? for unknown parts. Returns a readable date, or null when the year is unknown. */
export function prettyDate(d?: string): string | null {
  if (!d) return null;
  const [y, m, day] = d.split('.');
  if (!y || y.includes('?')) return null;
  if (!m || m.includes('?')) return y;
  const known = day && !day.includes('?');
  const date = new Date(Number(y), Number(m) - 1, known ? Number(day) : 1);
  return known
    ? date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
}
