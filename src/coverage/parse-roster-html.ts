// Parser for the YOT MVC LocationAvailability/list HTML response.
//
// The endpoint returns a fragment containing a single <table class="grid">
// with one <tbody> row per staff member. Each staff row has 7 schedule cells
// (Sun–Sat starting from the requested StartDate). Each cell is an <a> tag
// carrying data-id / data-name / data-day / data-month / data-year attributes
// and one of three inner-text shapes:
//
//   1. "Not Scheduled"                            → status: 'not-scheduled'
//   2. "<span style='color:red'>Holiday</span>"   → status: 'holiday'
//   3. "9:00 AM to<br/>3:00 PM"                   → status: 'scheduled' + start/end
//
// Some <a> tags in the response are not closed (the </td> closes them), so
// the entry-level regex terminates on </a> OR </td> to handle both cases.

//   4. "<span style='color:red'>Sick</span>" / "No Show" / other reasons
//                                                 → status: 'absent' + reason
//
// YOT renders a per-stylist exception (called in sick, no-show, etc.) as a
// red <span> carrying a free-text reason in place of the shift time. Those are
// distinct from store-wide closures ("Holiday", "Memorial Day", …), which we
// keep classifying as 'holiday' via a keyword list so they don't surface as
// individual absences.
export type RosterStatus = 'scheduled' | 'not-scheduled' | 'holiday' | 'absent';

export type RosterEntry = {
  stylistId: string;
  stylistName: string;
  date: string;             // ISO YYYY-MM-DD
  status: RosterStatus;
  startsAt: string | null;  // ISO datetime, null unless scheduled
  endsAt: string | null;
  reason?: string;          // free-text label for 'absent' cells (e.g. "Sick")
};

// Reason labels that mean a store-wide closure / holiday rather than one
// stylist being out. Matched case-insensitively as substrings against the
// cell's visible text. Extend as new closure labels appear in YOT.
const CLOSURE_REASON_RE =
  /holiday|memorial|christmas|thanksgiving|new year|labor day|independence|july\s*4|closed/i;

const ENTRY_RE = /<a\s+class="change_staff_day_schedule"[^>]*?data-id="(\d+)"[^>]*?data-name="([^"]*)"[^>]*?data-day="(\d+)"[^>]*?data-month="(\d+)"[^>]*?data-year="(\d+)"[^>]*>([\s\S]*?)(?:<\/a>|<\/td>)/g;
const TIME_RANGE_RE = /(\d{1,2}):(\d{2})\s*(AM|PM)\s*to\s*<br\s*\/?>\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i;

function pad2(n: number): string { return String(n).padStart(2, '0'); }

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function to24h(hour: number, minute: number, ampm: string): { h: number; m: number } {
  const ap = ampm.toUpperCase();
  let h = hour % 12;
  if (ap === 'PM') h += 12;
  return { h, m: minute };
}

function isoDateTime(date: string, hour: number, minute: number): string {
  return `${date}T${pad2(hour)}:${pad2(minute)}:00`;
}

function decodeInner(raw: string): string {
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function classifyAndExtract(inner: string, date: string): { status: RosterStatus; startsAt: string | null; endsAt: string | null; reason?: string } {
  const decoded = decodeInner(inner);
  // Visible text with tags stripped + whitespace collapsed, e.g.
  // "<span style='color:red'>Sick</span>" → "Sick". Used to detect closure
  // labels and to carry the absence reason.
  const text = decoded.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  // Store-wide closure label (Holiday, Memorial Day, …) wins over a time match
  // (a holiday cell sometimes carries both).
  if (CLOSURE_REASON_RE.test(text)) {
    return { status: 'holiday', startsAt: null, endsAt: null };
  }
  const match = decoded.match(TIME_RANGE_RE);
  if (match) {
    const start = to24h(Number(match[1]), Number(match[2]), match[3]);
    const end = to24h(Number(match[4]), Number(match[5]), match[6]);
    return {
      status: 'scheduled',
      startsAt: isoDateTime(date, start.h, start.m),
      endsAt: isoDateTime(date, end.h, end.m),
    };
  }
  // A non-empty reason that isn't "Not Scheduled" is a per-stylist absence
  // (called in sick, no-show, etc.) — carry the label through as the reason.
  if (text && !/^not\s*scheduled$/i.test(text)) {
    return { status: 'absent', startsAt: null, endsAt: null, reason: text };
  }
  // Default: "Not Scheduled" / empty.
  return { status: 'not-scheduled', startsAt: null, endsAt: null };
}

export function parseRosterHtml(html: string): RosterEntry[] {
  const out: RosterEntry[] = [];
  for (const m of html.matchAll(ENTRY_RE)) {
    const stylistId = m[1];
    const stylistName = decodeInner(m[2]).trim();
    const day = Number(m[3]);
    const month = Number(m[4]);
    const year = Number(m[5]);
    const inner = m[6];
    const date = isoDate(year, month, day);
    const { status, startsAt, endsAt, reason } = classifyAndExtract(inner, date);
    out.push({ stylistId, stylistName, date, status, startsAt, endsAt, ...(reason ? { reason } : {}) });
  }
  return out;
}

/**
 * Filter helper: keep only `scheduled` entries (a stylist actively rostered
 * for a shift that day). Used by the coverage compute layer.
 */
export function scheduledOnly(entries: RosterEntry[]): Array<RosterEntry & { startsAt: string; endsAt: string }> {
  return entries.filter((e): e is RosterEntry & { startsAt: string; endsAt: string } =>
    e.status === 'scheduled' && !!e.startsAt && !!e.endsAt,
  );
}
