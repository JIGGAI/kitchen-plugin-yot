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

// The Referrer field is a free-text box, so the raw values are a long tail of
// variants and misspellings of a few real sources (plus individual referrer
// names). Normalize into a small, stable bucket set. Order matters — the first
// matching rule wins; unmatched non-blank text falls through to "Word of mouth"
// (the vast majority of the tail is person names, i.e. someone referred them).
export function normalizeReferralSource(raw: string | null | undefined): string {
  const s = (raw || '').trim();
  if (!s) return '';
  const l = s.toLowerCase();
  // Non-answers / junk → Other
  if (/^(n\/?a|na|none|no ?one|nobody|noone|nothing|self|me|myself|you|universe|idk|\.+|-+|\?+)$/.test(l)) return 'Other';
  if (l === 'other') return 'Other';
  if (/g[o0]{2,}gle|google/.test(l)) return 'Google';
  if (/facebook|face ?book|\bfb\b/.test(l)) return 'Facebook';
  if (/instagram|\binsta\b|\big\b/.test(l)) return 'Instagram';
  if (/reddit|yelp|tiktok|\bsocial\b|nextdoor/.test(l)) return 'Social media';
  if (/chat ?g[bp]t|perplexity|\bai\b/.test(l)) return 'Online search';
  if (/web ?site|wed site|\bweb\b|inter ?nets?|inter ?webs?|online|\bsearch|reviews?|\bnet\b|billboard|\byelp\b/.test(l)) return 'Online search';
  if (/radio|wrif|\bad\b|advert|\bmail|coupon|flyer|postal|gift ?car|billboard/.test(l)) return 'Advertising';
  if (/walk[ -]?in|walked in|drove|driving|drive|passing|passed|saw (the|your|driving|shop|a )|new to (the )?area|just moved|noticed|check(ed)? out/.test(l)) return 'Walk-in';
  if (/repeat|return|previous|prior|been (here|there)|establish|past client|customer (in|from)|came (here|in) (before|years)/.test(l)) return 'Returning client';
  // friend / family / coworker / referral / a person's name → word of mouth
  return 'Word of mouth';
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
