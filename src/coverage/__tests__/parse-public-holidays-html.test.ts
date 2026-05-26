import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePublicHolidaysHtml } from '../parse-public-holidays-html';

const FIXTURE = readFileSync(join(__dirname, 'fixtures/public-holidays-sample.html'), 'utf8');

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
