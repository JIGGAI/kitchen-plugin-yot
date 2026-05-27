import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRosterHtml, scheduledOnly } from '../parse-roster-html';

const FIXTURE = readFileSync(join(__dirname, 'fixtures/roster-week-sample.html'), 'utf8');

describe('parseRosterHtml', () => {
  it('extracts every (stylist, day) cell as a RosterEntry', () => {
    const entries = parseRosterHtml(FIXTURE);
    // 4 stylists × 7 days = 28 entries
    expect(entries).toHaveLength(28);
  });

  it('returns "not-scheduled" for cells whose text is "Not Scheduled"', () => {
    const entries = parseRosterHtml(FIXTURE);
    const christinaTuesday = entries.find((e) => e.stylistName === 'Christina Ransom' && e.date === '2026-05-05');
    expect(christinaTuesday).toBeDefined();
    expect(christinaTuesday!.status).toBe('not-scheduled');
    expect(christinaTuesday!.startsAt).toBeNull();
    expect(christinaTuesday!.endsAt).toBeNull();
  });

  it('returns "holiday" for cells whose inner text contains <span>Holiday</span>', () => {
    const entries = parseRosterHtml(FIXTURE);
    const lindseyMonday = entries.find((e) => e.stylistName === 'Lindsey C Colley' && e.date === '2026-05-04');
    expect(lindseyMonday).toBeDefined();
    expect(lindseyMonday!.status).toBe('holiday');
    expect(lindseyMonday!.startsAt).toBeNull();
  });

  it('returns "scheduled" with ISO datetimes for cells with a time range', () => {
    const entries = parseRosterHtml(FIXTURE);
    const caliTuesday = entries.find((e) => e.stylistName === 'Cali Miller' && e.date === '2026-05-05');
    expect(caliTuesday).toBeDefined();
    expect(caliTuesday!.status).toBe('scheduled');
    expect(caliTuesday!.startsAt).toBe('2026-05-05T11:00:00');
    expect(caliTuesday!.endsAt).toBe('2026-05-05T15:00:00');
  });

  it('handles AM-only ranges (9 AM to 1 PM) including 30-min granularity', () => {
    const entries = parseRosterHtml(FIXTURE);
    const caliSaturday = entries.find((e) => e.stylistName === 'Cali Miller' && e.date === '2026-05-09');
    expect(caliSaturday!.startsAt).toBe('2026-05-09T09:00:00');
    expect(caliSaturday!.endsAt).toBe('2026-05-09T13:00:00');

    const cassieTuesday = entries.find((e) => e.stylistName === 'Cassie Liney' && e.date === '2026-05-05');
    expect(cassieTuesday!.startsAt).toBe('2026-05-05T10:30:00');
    expect(cassieTuesday!.endsAt).toBe('2026-05-05T15:30:00');
  });

  it('extracts the stylist id from the data-id attribute', () => {
    const entries = parseRosterHtml(FIXTURE);
    const cali = entries.find((e) => e.stylistName === 'Cali Miller');
    expect(cali!.stylistId).toBe('75812');
    const lindsey = entries.find((e) => e.stylistName === 'Lindsey C Colley');
    expect(lindsey!.stylistId).toBe('83349');
  });

  it('handles unclosed <a> tags (first cell of each row in YOT output)', () => {
    // The first day cell in each row often omits </a>; the </td> closes both.
    // The parser must still pick up the entry. Cassie's day-3 cell is one of these.
    const entries = parseRosterHtml(FIXTURE);
    const cassieSunday = entries.find((e) => e.stylistName === 'Cassie Liney' && e.date === '2026-05-03');
    expect(cassieSunday).toBeDefined();
    expect(cassieSunday!.status).toBe('scheduled');
    expect(cassieSunday!.startsAt).toBe('2026-05-03T09:00:00');
  });

  it('returns an empty list for HTML with no schedule cells', () => {
    expect(parseRosterHtml('<html><body><p>nothing here</p></body></html>')).toEqual([]);
  });
});

describe('parseRosterHtml — absence / exception cells', () => {
  // Build a one-cell roster fragment with the given inner HTML, matching the
  // shape ENTRY_RE expects (real YOT markup wraps the reason in a red span).
  const cell = (inner: string) =>
    `<table class="grid"><tbody><tr><td>` +
    `<a class="change_staff_day_schedule" href="Javascript:void(0)" data-id="91001" ` +
    `data-name="Josh Christen (Artist)" data-day="27" data-month="5" data-year="2026">${inner}</a>` +
    `</td></tr></tbody></table>`;

  const only = (inner: string) => {
    const entries = parseRosterHtml(cell(inner));
    expect(entries).toHaveLength(1);
    return entries[0]!;
  };

  it('classifies a "Sick" red-span cell as absent with the reason', () => {
    const e = only(`<span style='color:red'>Sick</span>`);
    expect(e.status).toBe('absent');
    expect(e.reason).toBe('Sick');
    expect(e.startsAt).toBeNull();
    expect(e.endsAt).toBeNull();
  });

  it('classifies a "No Show" red-span cell as absent with the reason', () => {
    const e = only(`<span style='color:red'>No Show</span>`);
    expect(e.status).toBe('absent');
    expect(e.reason).toBe('No Show');
  });

  it('keeps store-wide holiday/closure labels as holiday (not absent)', () => {
    expect(only(`<span style='color:red'>Memorial Day</span>`).status).toBe('holiday');
    expect(only(`<span style='color:red'>Memorial weekend</span>`).status).toBe('holiday');
    expect(only(`<span style='color:red'>Holiday</span>`).status).toBe('holiday');
  });

  it('still treats "Not Scheduled" as not-scheduled with no reason', () => {
    const e = only('Not Scheduled');
    expect(e.status).toBe('not-scheduled');
    expect(e.reason).toBeUndefined();
  });

  it('does not include absent rows in scheduledOnly', () => {
    const entries = parseRosterHtml(cell(`<span style='color:red'>Sick</span>`));
    expect(scheduledOnly(entries)).toHaveLength(0);
  });
});

describe('scheduledOnly', () => {
  it('keeps only entries that have a non-null startsAt/endsAt', () => {
    const entries = parseRosterHtml(FIXTURE);
    const scheduled = scheduledOnly(entries);
    // 4 stylists, days scheduled per fixture: Christina 0, Cali 5, Lindsey 0, Cassie 6 → 11 total
    expect(scheduled).toHaveLength(11);
    for (const s of scheduled) {
      expect(s.status).toBe('scheduled');
      expect(s.startsAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
      expect(s.endsAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    }
  });
});
