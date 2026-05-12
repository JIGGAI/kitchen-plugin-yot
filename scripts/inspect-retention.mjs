// Read the captured StaffRetentionDay XLSX and print row-by-row with all cells
// no truncation, no width slicing.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');

const path = process.argv[2];
const zip = new AdmZip(readFileSync(path));
const wb = zip.getEntry('xl/workbook.xml').getData().toString('utf8');
const rels = zip.getEntry('xl/_rels/workbook.xml.rels').getData().toString('utf8');
const ss = zip.getEntry('xl/sharedStrings.xml')?.getData().toString('utf8') || '';

function colIdx(ref) { let r=0; for (const c of ref) { if (c<'A'||c>'Z') break; r=r*26+(c.charCodeAt(0)-64); } return r-1; }
function decodeXml(s) { return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'"); }
function strip(x) { return x.replace(/<(\/?)(?:[A-Za-z0-9_]+:)/g,'<$1'); }
const sharedStrings = [];
for (const si of (strip(ss).match(/<si[\s\S]*?<\/si>/g)||[])) {
  const parts = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m=>decodeXml(m[1]));
  sharedStrings.push(parts.join(''));
}

const relMap = new Map();
for (const m of rels.matchAll(/<Relationship[^>]*Target="([^"]+)"[^>]*Id="([^"]+)"|<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
  const target = m[1]||m[4]; const id = m[2]||m[3]; if (target&&id) relMap.set(id, target);
}
// Telerik's relationship id is the literal "R..." string. Pull all id="..." attributes
// off the sheet element and pick the one that looks like a relationship id.
const sheetTag = wb.match(/<\w*:?sheet\b[^>]*>/)[0];
// Accept r:id or plain id; pick the value that looks like a Telerik relationship id (R...).
const idMatches = [...sheetTag.matchAll(/\s(?:r:)?id="([^"]+)"/g)].map((m) => m[1]);
const rid = idMatches.find((v) => /^R/i.test(v)) || idMatches[idMatches.length - 1];
const tgt = relMap.get(rid);
const sheetPath = tgt.startsWith('/') ? tgt.slice(1) : (tgt.startsWith('xl/') ? tgt : `xl/${tgt}`);
const sheetXml = zip.getEntry(sheetPath).getData().toString('utf8');

const norm = strip(sheetXml);
const rowMatches = norm.match(/<row\b[\s\S]*?<\/row>/g) || [];
const rows = [];
for (const rowXml of rowMatches) {
  const ra = rowXml.match(/<row\b([^>]*)>/);
  const rmatch = ra && ra[1].match(/\br="(\d+)"/);
  const rIdx = rmatch ? parseInt(rmatch[1],10)-1 : rows.length;
  while (rows.length<=rIdx) rows.push([]);
  const row = rows[rIdx];
  for (const cellXml of (rowXml.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)||[])) {
    const rm = cellXml.match(/\br="([A-Z]+)(\d+)"/);
    const c = rm ? colIdx(rm[1]) : row.length;
    while (row.length<=c) row.push('');
    const tm = cellXml.match(/\bt="([^"]+)"/);
    const vm = cellXml.match(/<v>([\s\S]*?)<\/v>/);
    const ism = cellXml.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/);
    let v = '';
    if (ism) v = decodeXml(ism[1]);
    else if (vm) {
      v = decodeXml(vm[1]);
      if (tm?.[1]==='s') { const idx = +v; v = sharedStrings[idx] ?? ''; }
    }
    row[c] = v;
  }
}

const start = +(process.argv[3]||'0');
const end = +(process.argv[4]||'25');
for (let r=start; r<=end && r<rows.length; r++) {
  const row = rows[r];
  const cells = [];
  for (let c=0; c<row.length; c++) if (row[c]!=='') cells.push(`[${c}]=${row[c]}`);
  console.log(`r${String(r).padStart(2,'0')}: ${cells.join(' | ')}`);
}
