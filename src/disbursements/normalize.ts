// Shared text/location normalization for the disbursement pipeline.
// Extracted from export-branch-deposits.ts so the cross-roster collision
// guard compares locations exactly the way the export matches them — two
// copies that drift would let a colliding stylist through.

export function normalizeText(value: string | null | undefined): string {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[’']/g, '')
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Drops state suffixes and township/stylist noise so "World of Golf FL." and
// "World of Golf Fl." are one shop. Note this also makes same-named shops in
// different states identical — see findRosterCollisions.
export function normalizeLocation(value: string | null | undefined): string {
  return normalizeText(value)
    .replace(/\bmi\b|\boh\b|\bpa\b|\bwv\b|\bfl\b/g, '')
    .replace(/\btownship\b|\btwp\b/g, '')
    .replace(/\bstylist\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
