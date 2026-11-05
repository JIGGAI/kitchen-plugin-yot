import { describe, expect, it } from 'vitest';
import { buildCoverageDayFact } from '../sync';
import type { AverageByDow, ClosedByDow } from '../types';

const averageByDow: AverageByDow = {
  sun: 12, mon: 15.5, tue: 18, wed: 20, thu: 19, fri: 24, sat: 22,
};
const closedByDow: ClosedByDow = {
  sun: false, mon: false, tue: false, wed: false, thu: false, fri: false, sat: false,
};

function base() {
  return {
    date: '2026-11-02',
    businessHours: {
      startsAt: '2026-11-02T10:00:00',
      endsAt: '2026-11-02T20:00:00',
    },
    dayIsClosedByHistory: false,
    dayAvg: 15.5,
    customersPerStylistForDay: 10,
    requiredStylists: 2,
    averageByDow,
    closedByDow,
    averageHourlyForDay: { 10: 1.5, 11: 2 },
    slotMinutes: 60,
    appointments: [],
  };
}

describe('buildCoverageDayFact', () => {
  it('marks a normally-open DOW closed when the date has no shifts or appointments', () => {
    const fact = buildCoverageDayFact({
      ...base(),
      rosterEntries: [
        {
          stylistId: '65450', stylistName: 'Dawn Rowe', date: '2026-11-02',
          status: 'not-scheduled', startsAt: null, endsAt: null,
        },
      ],
    });

    expect(fact.payload.closed).toBe(true);
    expect(fact.payload.requiredStylists).toBe(0);
    expect(fact.slots).toEqual([]);
    expect(fact.rosterRows).toEqual([]);
  });

  it('keeps a real YOT sick record visible when another shift proves the shop operated', () => {
    const fact = buildCoverageDayFact({
      ...base(),
      businessHours: {
        startsAt: '2026-11-02T10:00:00',
        endsAt: '2026-11-02T12:00:00',
      },
      rosterEntries: [
        {
          stylistId: '1', stylistName: 'Working Stylist', date: '2026-11-02',
          status: 'scheduled', startsAt: '2026-11-02T10:00:00', endsAt: '2026-11-02T12:00:00',
        },
        {
          stylistId: '2', stylistName: 'Sick Stylist', date: '2026-11-02',
          status: 'absent', startsAt: null, endsAt: null, reason: 'Sick',
        },
      ],
    });

    expect(fact.payload.closed).toBe(false);
    expect(fact.payload.requiredStylists).toBe(2);
    expect(fact.slots).toHaveLength(2);
    expect(fact.rosterRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ stylistId: '2', status: 'absent', reason: 'Sick' }),
    ]));
  });
});
