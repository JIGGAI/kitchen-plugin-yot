// Parser for the YOT MVC /Staff/PublicHolidays/List HTML response.
//
//   <li itemId="16831">
//     <span class='header'>Memorial Day</span>
//     <span class='detail'>05/25/2026</span>
//   </li>
//
// 'header' is the holiday name, 'detail' is the date as MM/DD/YYYY (sometimes
// non-zero-padded). We normalize the date to YYYY-MM-DD.

export type PublicHolidayEntry = {
  holidayId: string;
  name: string;
  date: string; // YYYY-MM-DD
};

const LI_RE = /<li\s+itemId=["'](\d+)["'][\s\S]*?<\/li>/gi;
const HEADER_RE = /<span\s+class=['"]header['"][^>]*>([\s\S]*?)<\/span>/i;
const DETAIL_RE = /<span\s+class=['"]detail['"][^>]*>([\s\S]*?)<\/span>/i;

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s: string): string {
  return decodeHtmlEntities(s.replace(/<[^>]*>/g, '')).trim();
}

/** MM/DD/YYYY (zero-padded or not) → YYYY-MM-DD. Returns '' if unparseable. */
function toIsoDate(mdy: string): string {
  const m = mdy.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return '';
  const mm = m[1].padStart(2, '0');
  const dd = m[2].padStart(2, '0');
  return `${m[3]}-${mm}-${dd}`;
}

/**
 * Parse the per-holiday EDIT page (/Staff/PublicHolidays/Edit/{id}) and return
 * the location ids the holiday CLOSES — i.e. the `selected` <option>s of the
 * `Locations.Locations` multiselect ("Public holiday locations").
 *
 *   <select id="Locations_Locations" multiple name="Locations.Locations">
 *     <option selected="selected" value="2107">Auburn Hills MI</option>
 *     <option value="8192">Middleburg Fl</option>   <-- open (not selected)
 *   </select>
 *
 * Returns { found, closedLocationIds }. `found=false` means the select was
 * absent (e.g. an auth-expired/zombie page or markup change) — the caller
 * should treat that as "don't know the scope" and NOT persist an empty set
 * (which would be indistinguishable from "closes nothing"). When `found=true`
 * and the array is empty, the holiday genuinely closes no locations.
 */
export function parseHolidayEditLocations(html: string): { found: boolean; closedLocationIds: string[] } {
  const sel = html.match(/<select[^>]*id=["']Locations_Locations["'][\s\S]*?<\/select>/i);
  if (!sel) return { found: false, closedLocationIds: [] };
  const closed: string[] = [];
  const optRe = /<option\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = optRe.exec(sel[0]))) {
    const attrs = m[1];
    if (!/\bselected\b/i.test(attrs)) continue;
    const valMatch = attrs.match(/\bvalue=["']([^"']*)["']/i);
    if (valMatch && valMatch[1]) closed.push(valMatch[1]);
  }
  return { found: true, closedLocationIds: closed };
}

export function parsePublicHolidaysHtml(html: string): PublicHolidayEntry[] {
  const out: PublicHolidayEntry[] = [];
  for (const match of html.matchAll(LI_RE)) {
    const block = match[0];
    const holidayId = match[1];
    const headerMatch = block.match(HEADER_RE);
    const detailMatch = block.match(DETAIL_RE);
    if (!headerMatch || !detailMatch) continue;
    const name = stripTags(headerMatch[1]);
    const date = toIsoDate(stripTags(detailMatch[1]));
    if (!name || !date) continue;
    out.push({ holidayId, name, date });
  }
  return out;
}
