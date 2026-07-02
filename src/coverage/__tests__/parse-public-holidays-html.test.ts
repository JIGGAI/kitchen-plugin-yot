import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePublicHolidaysHtml, parseHolidayEditLocations } from '../parse-public-holidays-html';

const FIXTURE = readFileSync(join(__dirname, 'fixtures/public-holidays-sample.html'), 'utf8');
const EDIT_FIXTURE = readFileSync(join(__dirname, 'fixtures/public-holiday-edit-sample.html'), 'utf8');

describe('parsePublicHolidaysHtml', () => {
  it('extracts id, name, and ISO date for each holiday', () => {
    const out = parsePublicHolidaysHtml(FIXTURE);
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual({ holidayId: '16831', name: 'Memorial Day', date: '2026-05-25' });
    expect(out[1]).toEqual({ holidayId: '16832', name: 'Independence Day', date: '2026-07-04' });
  });

  it('decodes HTML entities in names', () => {
    const out = parsePublicHolidaysHtml(FIXTURE);
    expect(out[2].name).toBe("New Year's Day");
  });

  it('normalizes non-zero-padded MM/DD/YYYY to YYYY-MM-DD', () => {
    const out = parsePublicHolidaysHtml(FIXTURE);
    expect(out[3].date).toBe('2026-07-05');
  });

  it('returns [] for unrecognized markup', () => {
    expect(parsePublicHolidaysHtml('<div>no items</div>')).toEqual([]);
  });
});

describe('parseHolidayEditLocations', () => {
  it('returns only the selected (closed) location ids', () => {
    const { found, closedLocationIds } = parseHolidayEditLocations(EDIT_FIXTURE);
    expect(found).toBe(true);
    expect(closedLocationIds).toEqual(['2107', '8276', '7810', '2651', '1349']);
  });

  it('excludes the unselected (open) FL shops', () => {
    const { closedLocationIds } = parseHolidayEditLocations(EDIT_FIXTURE);
    // Middleburg, Treaty Oaks, World of Golf, Yulee are open → not in the set
    for (const open of ['8192', '7429', '6787', '7728']) {
      expect(closedLocationIds).not.toContain(open);
    }
  });

  it('reports found=false when the multiselect is absent (zombie/expired page)', () => {
    const res = parseHolidayEditLocations('<html><body>Please log in</body></html>');
    expect(res.found).toBe(false);
    expect(res.closedLocationIds).toEqual([]);
  });

  it('distinguishes an empty scope (closes nothing) from an absent select', () => {
    const html = '<select id="Locations_Locations" name="Locations.Locations"></select>';
    const res = parseHolidayEditLocations(html);
    expect(res.found).toBe(true);
    expect(res.closedLocationIds).toEqual([]);
  });
});
