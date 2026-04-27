import AdmZip from 'adm-zip';

export type WorkbookSheet = {
  name: string;
  rows: string[][];
};

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripNamespaces(xml: string): string {
  return xml.replace(/<(\/?)(?:[A-Za-z0-9_]+:)/g, '<$1');
}

function colToIndex(ref: string): number {
  let result = 0;
  for (const ch of ref) {
    if (ch < 'A' || ch > 'Z') break;
    result = result * 26 + (ch.charCodeAt(0) - 64);
  }
  return result - 1;
}

function decodeSharedStrings(xml: string): string[] {
  const normalizedXml = stripNamespaces(xml);
  const values: string[] = [];
  const siMatches = normalizedXml.match(/<si[\s\S]*?<\/si>/g) || [];
  for (const si of siMatches) {
    const parts = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXmlEntities(m[1]));
    values.push(parts.join(''));
  }
  return values;
}

function decodeWorksheet(xml: string, sharedStrings: string[]): string[][] {
  const normalizedXml = stripNamespaces(xml);
  const rows: string[][] = [];
  const rowMatches = normalizedXml.match(/<row\b[\s\S]*?<\/row>/g) || [];
  for (const rowXml of rowMatches) {
    const row: string[] = [];
    const cellMatches = rowXml.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || [];
    for (const cellXml of cellMatches) {
      const refMatch = cellXml.match(/\br="([A-Z]+)\d+"/);
      const index = refMatch ? colToIndex(refMatch[1]) : row.length;
      while (row.length < index) row.push('');

      const typeMatch = cellXml.match(/\bt="([^"]+)"/);
      const vMatch = cellXml.match(/<v>([\s\S]*?)<\/v>/);
      const isMatch = cellXml.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/);
      let value = '';
      if (isMatch) {
        value = decodeXmlEntities(isMatch[1]);
      } else if (vMatch) {
        value = decodeXmlEntities(vMatch[1]);
        if (typeMatch?.[1] === 's') {
          const idx = Number(value);
          value = Number.isFinite(idx) ? (sharedStrings[idx] ?? '') : '';
        }
      }
      row[index] = value;
    }
    rows.push(row);
  }
  return rows;
}

export function readWorkbook(buffer: Buffer): WorkbookSheet[] {
  const zip = new AdmZip(buffer);
  const workbookEntry = zip.getEntry('xl/workbook.xml');
  const relsEntry = zip.getEntry('xl/_rels/workbook.xml.rels');
  if (!workbookEntry || !relsEntry) return [];

  const workbookXml = stripNamespaces(workbookEntry.getData().toString('utf8'));
  const relsXml = stripNamespaces(relsEntry.getData().toString('utf8'));
  const sharedEntry = zip.getEntry('xl/sharedStrings.xml');
  const sharedStrings = sharedEntry ? decodeSharedStrings(sharedEntry.getData().toString('utf8')) : [];

  const relMap = new Map<string, string>();
  for (const match of relsXml.matchAll(/<Relationship[^>]*Target="([^"]+)"[^>]*Id="([^"]+)"|<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    const target = match[1] || match[4];
    const id = match[2] || match[3];
    if (id && target) relMap.set(id, target);
  }

  const sheets: WorkbookSheet[] = [];
  for (const match of workbookXml.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*(?:r:id|id)="([^"]+)"/g)) {
    const name = decodeXmlEntities(match[1]);
    const rid = match[2];
    const target = relMap.get(rid);
    if (!target) continue;
    const normalizedTarget = target.startsWith('/xl/')
      ? target.slice(1)
      : target.startsWith('xl/')
        ? target
        : `xl/${target.replace(/^\//, '')}`;
    const entry = zip.getEntry(normalizedTarget);
    if (!entry) continue;
    const rows = decodeWorksheet(entry.getData().toString('utf8'), sharedStrings);
    sheets.push({ name, rows });
  }
  return sheets;
}
