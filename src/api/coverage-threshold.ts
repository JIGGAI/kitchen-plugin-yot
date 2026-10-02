// Day-level red/green cutoff for the coverage history grid. A day with fewer
// short person-hours than this still shows its count, but stays green.
export const LIGHT_HOURS_RED_THRESHOLD = 6;

export function isUnderCover(lightHours: number): boolean {
  return lightHours >= LIGHT_HOURS_RED_THRESHOLD;
}
