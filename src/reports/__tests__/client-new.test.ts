import { describe, it, expect } from 'vitest';
import {
  parseCsvLine,
  parseClientNewCsv,
  aggregateReferralSources,
} from '../reports/client-new';

describe('parseCsvLine', () => {
  it('splits plain fields', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });
  it('honors quoted fields with commas and escaped quotes', () => {
    expect(parseCsvLine('a,"b,c","d""e"')).toEqual(['a', 'b,c', 'd"e']);
  });
  it('keeps a trailing empty field', () => {
    expect(parseCsvLine('a,b,')).toEqual(['a', 'b', '']);
  });
});

describe('parseClientNewCsv', () => {
  // Telerik shape: line 0 = textbox ids; each data row = label/summary block
  // then the trailing 7 data columns [First, Phone, Last, Location, LastVisit,
  // LastStaff, Referrer].
  const csv = [
    'titleTextBox,textBox12,textBox4,textBox3,textBox2,textBox1,textBox18,textBox21,textBox16,textBox15,surnameDataTextBox,textBox14,textBox9,textBox10,textBox13,textBox19,textBox22',
    'New Clients,First Name,Last Name,Phone,Location,Last Visit,Last Staff,Referrer,2,Total,Adam,585-953-2727,Kolcon,Troy MI,6/1/2026,Kimberly Barksdale,Google',
    'New Clients,First Name,Last Name,Phone,Location,Last Visit,Last Staff,Referrer,2,Total,Al,404-202-9269,Suman,Jacksonville FL,6/29/2026,Jade Oconnor,',
  ].join('\n');

  it('reads the trailing data columns and skips the id header row', () => {
    const rows = parseClientNewCsv(Buffer.from(csv, 'utf8'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ firstName: 'Adam', lastName: 'Kolcon', location: 'Troy MI', referrer: 'Google' });
    expect(rows[1]).toMatchObject({ firstName: 'Al', location: 'Jacksonville FL', referrer: null });
  });
});

describe('aggregateReferralSources', () => {
  it('counts non-blank referrers, buckets blanks, sorts desc', () => {
    const agg = aggregateReferralSources([
      { referrer: 'Google' }, { referrer: 'Google' }, { referrer: 'Friend' },
      { referrer: '' }, { referrer: null }, { referrer: '  ' },
    ] as any);
    expect(agg.sources).toEqual([{ source: 'Google', count: 2 }, { source: 'Friend', count: 1 }]);
    expect(agg.specifiedTotal).toBe(3);
    expect(agg.blankCount).toBe(3);
    expect(agg.total).toBe(6);
  });
});
