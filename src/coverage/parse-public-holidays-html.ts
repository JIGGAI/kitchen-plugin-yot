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
