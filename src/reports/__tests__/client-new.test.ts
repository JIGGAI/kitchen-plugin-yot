import { describe, it, expect } from 'vitest';
import {
  parseCsvLine,
  parseClientNewCsv,
  aggregateReferralSources,
  normalizeReferralSource,
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

describe('normalizeReferralSource', () => {
  it('buckets variants into stable sources', () => {
    expect(normalizeReferralSource('google search')).toBe('Google');
    expect(normalizeReferralSource('Google.')).toBe('Google');
    expect(normalizeReferralSource('Face book')).toBe('Facebook');
    expect(normalizeReferralSource('Web site and reviews')).toBe('Online search');
    expect(normalizeReferralSource('Chat gpt')).toBe('Online search');
    expect(normalizeReferralSource('Radio ad')).toBe('Advertising');
    expect(normalizeReferralSource('Mail coupon')).toBe('Advertising');
    expect(normalizeReferralSource('Drove by and saw your store')).toBe('Walk-in');
    expect(normalizeReferralSource('Repeat client')).toBe('Returning client');
    expect(normalizeReferralSource('Other')).toBe('Other');
    expect(normalizeReferralSource('na')).toBe('Other');
    // person names / friend / family fall through to word of mouth
    expect(normalizeReferralSource('Dave Barclay')).toBe('Word of mouth');
    expect(normalizeReferralSource('Friend')).toBe('Word of mouth');
    expect(normalizeReferralSource('My cousin')).toBe('Word of mouth');
    // blank stays blank
    expect(normalizeReferralSource('')).toBe('');
    expect(normalizeReferralSource('   ')).toBe('');
  });
});

describe('aggregateReferralSources', () => {
  it('normalizes + counts referrers, buckets blanks, sorts desc', () => {
    const agg = aggregateReferralSources([
      { referrer: 'Google' }, { referrer: 'google search' }, { referrer: 'Friend' },
      { referrer: '' }, { referrer: null }, { referrer: '  ' },
    ] as any);
    // Google + "google search" collapse; Friend → Word of mouth
    expect(agg.sources).toEqual([{ source: 'Google', count: 2 }, { source: 'Word of mouth', count: 1 }]);
    expect(agg.specifiedTotal).toBe(3);
    expect(agg.blankCount).toBe(3);
    expect(agg.total).toBe(6);
  });
});
