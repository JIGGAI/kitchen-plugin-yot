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
  it('preserves native options and folds their obvious variants', () => {
    expect(normalizeReferralSource('Google')).toBe('Google');
    expect(normalizeReferralSource('google search')).toBe('Google');
    expect(normalizeReferralSource('Google.')).toBe('Google');
    expect(normalizeReferralSource('Facebook')).toBe('Facebook');
    expect(normalizeReferralSource('Face book')).toBe('Facebook');
    expect(normalizeReferralSource('Social Media')).toBe('Social Media');
    expect(normalizeReferralSource('Instagram')).toBe('Social Media');
    expect(normalizeReferralSource('Tik Tok')).toBe('Social Media');
    expect(normalizeReferralSource('TV/Radio')).toBe('TV/Radio');
    expect(normalizeReferralSource('tv / radio')).toBe('TV/Radio');
    expect(normalizeReferralSource('Cable')).toBe('TV/Radio');
    expect(normalizeReferralSource('Friend')).toBe('Friend');
    expect(normalizeReferralSource('friend')).toBe('Friend');
    expect(normalizeReferralSource('Radio ad')).toBe('Radio');
    expect(normalizeReferralSource('101 WRIF')).toBe('Radio');
    expect(normalizeReferralSource('Drive By')).toBe('Drive By');
    expect(normalizeReferralSource('drive-by')).toBe('Drive By');
    expect(normalizeReferralSource('Drove by')).toBe('Drive By');
    expect(normalizeReferralSource('Other')).toBe('Other');
  });
  it('routes typed-in free text to the write-in catch-all (not a native option)', () => {
    expect(normalizeReferralSource('Dave Barclay')).toBe('Other (write-in)');
    expect(normalizeReferralSource('My cousin')).toBe('Other (write-in)');
    expect(normalizeReferralSource('Web site and reviews')).toBe('Other (write-in)');
    expect(normalizeReferralSource('Chat gpt')).toBe('Other (write-in)');
    expect(normalizeReferralSource('Walk-in')).toBe('Other (write-in)');
    expect(normalizeReferralSource('na')).toBe('Other (write-in)');
  });
  it('keeps blanks blank', () => {
    expect(normalizeReferralSource('')).toBe('');
    expect(normalizeReferralSource('   ')).toBe('');
    expect(normalizeReferralSource(null)).toBe('');
  });
});

describe('aggregateReferralSources', () => {
  it('normalizes + counts referrers, buckets blanks, sorts desc', () => {
    const agg = aggregateReferralSources([
      { referrer: 'Google' }, { referrer: 'google search' }, { referrer: 'Friend' },
      { referrer: 'Dave B' }, { referrer: '' }, { referrer: null }, { referrer: '  ' },
    ] as any);
    // Google + "google search" collapse; Friend stays Friend; name → write-in
    expect(agg.sources).toEqual([
      { source: 'Google', count: 2 },
      { source: 'Friend', count: 1 },
      { source: 'Other (write-in)', count: 1 },
    ]);
    expect(agg.specifiedTotal).toBe(4);
    expect(agg.blankCount).toBe(3);
    expect(agg.total).toBe(7);
  });
});
