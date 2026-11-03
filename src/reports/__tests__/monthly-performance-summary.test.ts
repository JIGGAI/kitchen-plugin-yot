import { describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { parseMonthlyPerformanceSummaryWorkbook } from '../reports/monthly-performance-summary';

function buildWorkbook(rows: Array<Array<string | null>>): Buffer {
  const colLetter = (index: number) => {
    let result = '';
    let cursor = index;
    do {
      result = String.fromCharCode(65 + (cursor % 26)) + result;
      cursor = Math.floor(cursor / 26) - 1;
    } while (cursor >= 0);
    return result;
  };
  const sheetRows = rows.map((cells, rowIndex) => {
    const xmlCells = cells.map((value, columnIndex) => (value == null || value === ''
      ? ''
      : `<c r="${colLetter(columnIndex)}${rowIndex + 1}" t="inlineStr"><is><t>${String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')}</t></is></c>`)).join('');
    return `<row r="${rowIndex + 1}">${xmlCells}</row>`;
  }).join('');

  const zip = new AdmZip();
  zip.addFile('xl/workbook.xml', Buffer.from(
    '<?xml version="1.0"?><workbook xmlns:r="x"><sheets><sheet name="MonthlyPerformanceSummary" sheetId="1" r:id="rId1"/></sheets></workbook>'));
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(
    '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'));
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(
    `<?xml version="1.0"?><worksheet><sheetData>${sheetRows}</sheetData></worksheet>`));
  return zip.toBuffer();
}

function row(cells: Record<number, string>, width = 35): Array<string | null> {
  const out: Array<string | null> = new Array(width).fill(null);
  for (const [index, value] of Object.entries(cells)) out[Number(index)] = value;
  return out;
}

function parse(rows: Array<Array<string | null>>) {
  return parseMonthlyPerformanceSummaryWorkbook(buildWorkbook(rows));
}

describe('parseMonthlyPerformanceSummaryWorkbook', () => {
  it('maps the current 35-column Telerik layout from its headers', () => {
    const result = parse([
      row({ 9: 'Online Bookings', 11: 'New Clients', 12: 'Total Clients', 15: '# of Sales', 17: 'Sales per Day', 20: '# of Vouchers', 22: 'Product Sales Value', 26: 'Service Sales Value', 28: 'Total Sales', 30: 'Last Year Comparison' }),
      row({ 2: 'Month Starting', 7: 'Cancelled', 8: 'No Shows' }),
      row({ 4: 'Appointments' }),
      row({ 1: 'Auburn Hills MI' }),
      row({ 1: 'October 2026', 6: '919', 7: '86', 8: '23', 9: '743', 11: '112', 12: '21428', 15: '1017', 16: '32', 20: '0', 22: '396.45', 24: '36845.5', 27: '37241.95', 29: '48835.23', 33: '(-24%)' }),
    ]);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      locationName: 'Auburn Hills MI',
      monthLabel: 'October 2026',
      appointments: 919,
      cancelled: 86,
      noShows: 23,
      onlineBookings: 743,
      newClients: 112,
      totalClients: 21428,
      salesCount: 1017,
      salesPerDay: 32,
      voucherCount: 0,
      productSales: 396.45,
      serviceSales: 36845.5,
      totalSales: 37241.95,
      yoyAmount: 48835.23,
      yoyPct: -24,
    });
  });

  it('continues to map the legacy 33-column layout', () => {
    const result = parse([
      row({ 10: 'Online Bookings', 11: 'New Clients', 13: 'Total Clients', 14: '# of Sales', 16: 'Sales per Day', 19: '# of Vouchers', 21: 'Product Sales Value', 25: 'Service Sales Value', 27: 'Total Sales', 29: 'Last Year Comparison' }, 33),
      row({ 2: 'Month Starting', 8: 'Cancelled', 9: 'No Shows' }, 33),
      row({ 5: 'Appointments' }, 33),
      row({ 1: 'Auburn Hills MI' }, 33),
      row({ 1: 'September 2026', 7: '803', 8: '91', 9: '27', 10: '651', 11: '105', 13: '21301', 14: '903', 15: '30', 19: '0', 21: '687.41', 23: '34086.5', 26: '34773.91', 28: '58574.52', 32: '(-41%)' }, 33),
    ]);

    expect(result.rows[0]).toMatchObject({
      appointments: 803,
      cancelled: 91,
      noShows: 27,
      onlineBookings: 651,
      totalClients: 21301,
      salesCount: 903,
      salesPerDay: 30,
      serviceSales: 34086.5,
      totalSales: 34773.91,
      yoyAmount: 58574.52,
      yoyPct: -41,
    });
  });
});
