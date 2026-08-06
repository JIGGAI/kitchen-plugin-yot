import { describe, it, expect } from 'vitest';
import AdmZip from 'adm-zip';
import { parseStaffWorkSummaryWorkbook } from '../reports/staff-work-summary';

// Build a minimal XLSX the plugin's readWorkbook can parse. Cells are written
// as inline strings so no sharedStrings table is needed.
function buildWorkbook(sheetName: string, rows: Array<Array<string | null>>): Buffer {
  const colLetter = (i: number) => {
    let s = ''; let n = i;
    do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return s;
  };
  const sheetRows = rows.map((cells, r) => {
    const tds = cells.map((v, c) => (v == null || v === ''
      ? ''
      : `<c r="${colLetter(c)}${r + 1}" t="inlineStr"><is><t>${String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></is></c>`)).join('');
    return `<row r="${r + 1}">${tds}</row>`;
  }).join('');

  const zip = new AdmZip();
  zip.addFile('xl/workbook.xml', Buffer.from(
    `<?xml version="1.0"?><workbook xmlns:r="x"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`));
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(
    `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`));
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(
    `<?xml version="1.0"?><worksheet><sheetData>${sheetRows}</sheetData></worksheet>`));
  return zip.toBuffer();
}

// Mirrors the real 2026-08-04 workbook: label in column [1], data in [6], [9],
// [10], [25], [29], with chrome in column [0].
function row(cells: Record<number, string>): Array<string | null> {
  const out: Array<string | null> = new Array(30).fill(null);
  for (const [k, v] of Object.entries(cells)) out[Number(k)] = v;
  return out;
}

const SHEET = 'StaffWorkSummary_2121';

function parse(rows: Array<Array<string | null>>) {
  return parseStaffWorkSummaryWorkbook(buildWorkbook(SHEET, rows));
}

describe('parseStaffWorkSummaryWorkbook', () => {
  it('reads sales per hour and avg length for each stylist under their location', () => {
    const result = parse([
      row({ 0: 'Staff Work Summary Report' }),
      row({ 0: 'Start Date:', 2: '46238' }),
      row({ 5: 'Scheduled Work Time', 25: 'Sales per hour', 29: 'Avg \r\nLength' }),
      row({ 1: 'Name', 14: 'Time Filled' }),
      row({ 1: 'Auburn Hills MI' }),
      row({ 1: 'Carolyn Hojnowski', 6: '5h, 0m', 9: '5h, 0m', 10: '1', 25: '0.5825242718446603', 29: '35m' }),
      row({ 1: 'Dana Humble', 6: '5h, 0m', 9: '5h, 0m', 10: '1', 25: '0.9630818928758232', 29: '28m' }),
    ]);

    expect(result.sheetName).toBe(SHEET);
    expect(result.locations).toEqual(['Auburn Hills MI']);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      locationName: 'Auburn Hills MI',
      staffName: 'Carolyn Hojnowski',
      salesPerHour: 0.5825242718446603,
      avgLengthMinutes: 35,
      workLessBreaksMinutes: 300,
      daysWorked: 1,
    });
    expect(result.rows[1].avgLengthMinutes).toBe(28);
  });

  it('assigns each stylist to the location header above them', () => {
    const result = parse([
      row({ 1: 'Name' }),
      row({ 1: 'Auburn Hills MI' }),
      row({ 1: 'Carolyn Hojnowski', 9: '5h, 0m', 25: '0.58', 29: '35m' }),
      row({ 1: 'Westland' }),
      row({ 1: 'Chelsea  Desselles', 9: '9h, 40m', 25: '1.09', 29: '22m' }),
    ]);
    expect(result.locations).toEqual(['Auburn Hills MI', 'Westland']);
    expect(result.rows.map((r) => [r.locationName, r.staffName])).toEqual([
      ['Auburn Hills MI', 'Carolyn Hojnowski'],
      ['Westland', 'Chelsea  Desselles'],
    ]);
  });

  it('keeps a stylist who has sales but no recorded shift', () => {
    // Real case (Alecea Talbot, 2026-08-04): a sales-per-hour figure with no
    // scheduled time at all. Dropping her would remove her from her own average.
    const result = parse([
      row({ 1: 'Auburn Hills MI' }),
      row({ 1: 'Alecea Talbot', 25: '1.4042553789044843', 29: '28m' }),
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      staffName: 'Alecea Talbot',
      salesPerHour: 1.4042553789044843,
      avgLengthMinutes: 28,
      workLessBreaksMinutes: null,
      daysWorked: null,
    });
  });

  it('parses an hour-or-longer average length', () => {
    const result = parse([
      row({ 1: 'Waterford' }),
      row({ 1: 'Long Service', 9: '8h, 0m', 25: '0.4', 29: '1h, 5m' }),
    ]);
    expect(result.rows[0].avgLengthMinutes).toBe(65);
  });

  it('ignores report chrome, header labels, and total rows', () => {
    const result = parse([
      row({ 0: 'Staff Work Summary Report' }),
      row({ 0: 'End Date:', 2: '46238.99' }),
      row({ 1: 'Name', 14: 'Time Filled' }),
      row({ 1: 'Auburn Hills MI' }),
      row({ 1: 'Carolyn Hojnowski', 9: '5h, 0m', 25: '0.58', 29: '35m' }),
      row({ 1: 'Totals', 9: '5h, 0m', 25: '0.58' }),
      row({ 1: 'Grand Total', 9: '5h, 0m', 25: '0.58' }),
    ]);
    expect(result.rows.map((r) => r.staffName)).toEqual(['Carolyn Hojnowski']);
    expect(result.locations).toEqual(['Auburn Hills MI']);
  });

  it('treats YOT divide-by-zero markers as missing, not NaN', () => {
    const result = parse([
      row({ 1: 'Auburn Hills MI' }),
      row({ 1: 'No Sales', 9: '5h, 0m', 25: '#DIV/0!', 29: '30m' }),
    ]);
    expect(result.rows[0].salesPerHour).toBeNull();
    expect(result.rows[0].avgLengthMinutes).toBe(30);
  });

  it('returns nothing for an empty workbook rather than throwing', () => {
    const result = parse([row({ 0: 'Staff Work Summary Report' })]);
    expect(result.rows).toEqual([]);
    expect(result.locations).toEqual([]);
  });
});
