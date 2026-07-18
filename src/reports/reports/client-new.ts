import type { ReportDocumentFormat } from '../client';

// YOT "New Client Report" (ClientNew_2121). One run returns every new client
// for the org over a date range, each with a Referrer (referral source) column:
// Google / Friend / Facebook / Other / Radio / … plus a large blank share.
// Output columns (data block, trailing 7 fields of each Telerik CSV row):
//   First Name, Phone, Last Name, Location, Last Visit, Last Staff, Referrer
export const CLIENT_NEW_REPORT = {
  key: 'clientNew',
  reportName: 'ClientNewReport',
  reportType: 'YoureOnTime.Web.TelerikReports.ClientNew_2121, YoureOnTime.Reports',
  reportClass: 'ClientNew_2121',
  preferredFormat: 'CSV' as ReportDocumentFormat,
};

export type ClientNewParams = {
  startDateIso: string;
  endDateIso: string;
  organisationId: number;
  locationId?: number | null;
};

export type ClientNewRow = {
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  location: string | null;
  lastVisit: string | null;
  lastStaff: string | null;
  referrer: string | null;
};

export function buildClientNewParameterDiscovery(params: ClientNewParams, apiKey: string): Record<string, string> {
  return {
    DateRange: 'Custom',
    StartDate: params.startDateIso.replace('.000Z', ''),
    EndDate: params.endDateIso.replace('.000Z', ''),
    FranchiseId: '',
    LocationId: params.locationId == null ? '' : String(params.locationId),
    DoNothing: '',
    Title: 'New Client Report',
    ReportName: CLIENT_NEW_REPORT.reportName,
    FrameView: 'True',
    OrganisationId: String(params.organisationId),
    ReportClass: CLIENT_NEW_REPORT.reportClass,
    Key: apiKey,
  };
}

export function buildClientNewInstanceParams(params: ClientNewParams): Record<string, string | number | null> {
  return {
    StartDate: params.startDateIso,
    EndDate: params.endDateIso,
    OrganisationId: params.organisationId,
    LocationId: params.locationId ?? null,
  };
}

// RFC-4180-ish single-line CSV split (handles quoted fields + escaped quotes).
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// Telerik CSV: line 0 is textbox ids; every subsequent row repeats a label/
// summary block, then carries the 7 data columns above. We read the trailing 7
// fields so we don't depend on the (constant but noisy) label-block width.
export function parseClientNewCsv(buffer: Buffer): ClientNewRow[] {
  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const rows: ClientNewRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 7) continue;
    const d = cols.slice(-7).map((c) => c.trim());
    rows.push({
      firstName: d[0] || null,
      phone: d[1] || null,
      lastName: d[2] || null,
      location: d[3] || null,
      lastVisit: d[4] || null,
      lastStaff: d[5] || null,
      referrer: d[6] || null,
    });
  }
  return rows;
}

// The Referrer field is a free-text box on top of YOT's native "How did you
// hear about us" options. We preserve the native options exactly (they're the
// values people pick from the dropdown, hence the big counts) and only fold
// obvious spelling/format variants into them. Everything else someone typed by
// hand — names, jokes, one-off phrases — goes to a single write-in catch-all,
// kept distinct from the native "Other" pick. Order matters (first match wins).
export const NATIVE_REFERRAL_OPTIONS = [
  'Google', 'Friend', 'Facebook', 'Instagram', 'TikTok', 'YouTube', 'X',
  'Snapchat', 'LinkedIn', 'Pinterest', 'Reddit', 'Social Media',
  'TV/Radio', 'Radio', 'Drive By', 'Other',
];
export const WRITE_IN_REFERRAL_SOURCE = 'Other (write-in)';

export function normalizeReferralSource(raw: string | null | undefined): string {
  const s = (raw || '').trim();
  if (!s) return '';
  const l = s.toLowerCase();
  // Native options + their obvious variants/misspellings.
  if (/g[o0]{2,}gle|google/.test(l)) return 'Google';
  if (/facebook|face ?book|\bfb\b/.test(l)) return 'Facebook';
  if (/instagram|\big\b/.test(l)) return 'Instagram';
  if (/tiktok|tik tok/.test(l)) return 'TikTok';
  if (/youtube|you tube/.test(l)) return 'YouTube';
  if (l === 'x' || /\btwitter\b|x\.com/.test(l)) return 'X';
  if (/snapchat|\bsnap\b/.test(l)) return 'Snapchat';
  if (/linkedin|linked in/.test(l)) return 'LinkedIn';
  if (/pinterest/.test(l)) return 'Pinterest';
  if (/reddit/.test(l)) return 'Reddit';
  if (/social media|social/.test(l)) return 'Social Media';
  if (/tv\s*\/\s*radio|television|cable/.test(l)) return 'TV/Radio';
  if (/\bradio\b|wrif/.test(l)) return 'Radio';
  if (/drive[- ]?by|drove by|walk[- ]?by/.test(l)) return 'Drive By';
  if (l === 'friend' || l === 'friends' || l === 'a friend') return 'Friend';
  if (l === 'other') return 'Other';
  // Anyone who typed their own answer (names, web, walk-in, etc.).
  return WRITE_IN_REFERRAL_SOURCE;
}

export type ReferralSourceCount = { source: string; count: number };
export type ClientNewReferralAggregate = {
  sources: ReferralSourceCount[];   // specified sources, desc by count
  total: number;                    // all new clients in range
  specifiedTotal: number;           // new clients with a non-blank referrer
  blankCount: number;               // new clients with no referrer
};

// Roll the parsed rows up into referral-source counts. Blank/whitespace
// referrers are bucketed into blankCount (surfaced as "Not specified").
export function aggregateReferralSources(rows: ClientNewRow[]): ClientNewReferralAggregate {
  const counts = new Map<string, number>();
  let blankCount = 0;
  for (const row of rows) {
    const source = normalizeReferralSource(row.referrer);
    if (!source) { blankCount += 1; continue; }
    counts.set(source, (counts.get(source) || 0) + 1);
  }
  const sources = [...counts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
  const specifiedTotal = sources.reduce((s, r) => s + r.count, 0);
  return { sources, total: specifiedTotal + blankCount, specifiedTotal, blankCount };
}
