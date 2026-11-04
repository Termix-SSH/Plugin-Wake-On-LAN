const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["day", 86_400],
  ["hour", 3600],
  ["minute", 60],
];

/** "2 hours ago" in the user's language. */
export function timeAgo(
  iso: string | null,
  language: string,
  now = Date.now(),
): string | null {
  if (!iso) return null;
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return null;
  const format = new Intl.RelativeTimeFormat(language.replace("_", "-"), {
    numeric: "auto",
  });
  for (const [unit, size] of UNITS) {
    if (seconds >= size) {
      return format.format(-Math.floor(seconds / size), unit);
    }
  }
  return format.format(0, "minute");
}
