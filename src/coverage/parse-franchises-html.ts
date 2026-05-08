// Parser for the YOT MVC /Administration/Franchises/List HTML response.
//
// The endpoint returns an <ul class="list_view"> with one <li> per franchise:
//
//   <li itemId="1">
//     <span class='header'>Hair MX</span>
//     <span class='detail'>13 Locations: Westland, Waterford, ...</span>
//   </li>
//
// "Hair MX" (franchiseId=1) is the corporate franchise; the rest are
// franchisees. The 'detail' span lists the count and comma-separated location
// names, which we use to join back to YOT location IDs.

export type FranchiseEntry = {
  franchiseId: string;
  name: string;
  locationCount: number;
  locationNames: string[];
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
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s: string): string {
  return decodeHtmlEntities(s.replace(/<[^>]*>/g, '')).trim();
}

/**
 * Parse the franchise list HTML into structured entries. Returns an empty
 * array if the markup is unrecognised — the caller decides whether that's a
 * silent "no franchises" or an upstream regression.
 */
export function parseFranchisesHtml(html: string): FranchiseEntry[] {
  const out: FranchiseEntry[] = [];
  for (const match of html.matchAll(LI_RE)) {
    const block = match[0];
    const franchiseId = match[1];
    const headerMatch = block.match(HEADER_RE);
    const detailMatch = block.match(DETAIL_RE);
    if (!headerMatch) continue;
    const name = stripTags(headerMatch[1]);
    if (!name) continue;
    let locationCount = 0;
    let locationNames: string[] = [];
    if (detailMatch) {
      const detailText = stripTags(detailMatch[1]);
      // Format: "<N> Locations: <name1>, <name2>, ..."
      const colonIdx = detailText.indexOf(':');
      const lead = colonIdx === -1 ? '' : detailText.slice(0, colonIdx);
      const tail = colonIdx === -1 ? detailText : detailText.slice(colonIdx + 1);
      const countMatch = lead.match(/(\d+)/);
      locationCount = countMatch ? Number(countMatch[1]) : 0;
      // Locations are comma-separated; trim each, drop empties, normalize whitespace.
      locationNames = tail
        .split(',')
        .map((s) => s.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    }
    out.push({ franchiseId, name, locationCount, locationNames });
  }
  return out;
}
