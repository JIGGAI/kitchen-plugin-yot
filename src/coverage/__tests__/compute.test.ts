import { describe, it, expect } from 'vitest';
import { computeCoverageSlots, aggregateLightWindows } from '../compute';
import type { CoverageInputs, CoverageSlot } from '../types';

const baseInputs = (overrides: Partial<CoverageInputs> = {}): CoverageInputs => ({
  date: '2026-05-05',
  businessHours: { startsAt: '2026-05-05T09:00:00', endsAt: '2026-05-05T11:00:00' },
  slotMinutes: 30,
  requiredStylists: 0,
  averageDailyAppointments: 0,
  customersPerStylistForDay: 10,
  appointments: [],
  scheduled: [],
  ...overrides,
});

describe('computeCoverageSlots', () => {
  it('produces slot-aligned 30-min buckets across the business window', () => {
    const slots = computeCoverageSlots(baseInputs());
    expect(slots).toHaveLength(4); // 09:00, 09:30, 10:00, 10:30
    expect(slots[0].startsAt).toBe('2026-05-05T09:00:00');
    expect(slots[0].endsAt).toBe('2026-05-05T09:30:00');
    expect(slots[3].startsAt).toBe('2026-05-05T10:30:00');
    expect(slots[3].endsAt).toBe('2026-05-05T11:00:00');
  });

  it('counts overlapping appointments per slot', () => {
    const slots = computeCoverageSlots(baseInputs({
      appointments: [
        { startsAt: '2026-05-05T09:00:00', endsAt: '2026-05-05T09:30:00', stylistId: 's1' },
        { startsAt: '2026-05-05T09:00:00', endsAt: '2026-05-05T10:00:00', stylistId: 's2' },
        { startsAt: '2026-05-05T10:30:00', endsAt: '2026-05-05T11:00:00', stylistId: 's3' },
      ],
    }));
    expect(slots[0].customerCount).toBe(2); // 09:00 has 2 appts overlapping
    expect(slots[1].customerCount).toBe(1); // 09:30 has the 09:00–10:00 long appt
    expect(slots[2].customerCount).toBe(0); // 10:00 empty
    expect(slots[3].customerCount).toBe(1); // 10:30
  });

  it('applies the precomputed requiredStylists uniformly to every slot', () => {
    // 68 daily bookings ÷ 10 (weekday ratio) = 7 — applied to every slot.
    const slots = computeCoverageSlots(baseInputs({
      requiredStylists: 7,
      averageDailyAppointments: 68,
      appointments: [
        // a single 09:00 booking shouldn't change the required value at any slot
        { startsAt: '2026-05-05T09:00:00', endsAt: '2026-05-05T09:30:00', stylistId: 'c1' },
      ],
    }));
    for (const slot of slots) expect(slot.requiredStylists).toBe(7);
    expect(slots[0].customerCount).toBe(1); // slot-level customer count is still surfaced
  });

  it('counts distinct scheduled stylists overlapping each slot', () => {
    const slots = computeCoverageSlots(baseInputs({
      scheduled: [
        { stylistId: 's1', startsAt: '2026-05-05T09:00:00', endsAt: '2026-05-05T13:00:00' },
        { stylistId: 's2', startsAt: '2026-05-05T10:00:00', endsAt: '2026-05-05T14:00:00' },
        // Same stylist appearing twice (split shift) shouldn't double-count
        { stylistId: 's1', startsAt: '2026-05-05T09:30:00', endsAt: '2026-05-05T10:00:00' },
      ],
    }));
    expect(slots[0].scheduledStylists).toBe(1); // only s1 at 09:00
    expect(slots[2].scheduledStylists).toBe(2); // s1 + s2 at 10:00
    expect(slots[3].scheduledStylists).toBe(2); // s1 + s2 at 10:30
  });

  it('flags light=true when scheduledStylists < requiredStylists', () => {
    const slots = computeCoverageSlots(baseInputs({
      requiredStylists: 3,
      scheduled: [
        { stylistId: 's1', startsAt: '2026-05-05T09:00:00', endsAt: '2026-05-05T11:00:00' },
        { stylistId: 's2', startsAt: '2026-05-05T10:00:00', endsAt: '2026-05-05T11:00:00' },
      ],
    }));
    // 09:00 slot has 1 stylist scheduled, needs 3 → light
    expect(slots[0].scheduledStylists).toBe(1);
    expect(slots[0].light).toBe(true);
    // 10:00 slot has 2 → still light (still under 3)
    expect(slots[2].scheduledStylists).toBe(2);
    expect(slots[2].light).toBe(true);
  });

  it('does not flag light when requiredStylists is 0 (closed / no demand)', () => {
    const slots = computeCoverageSlots(baseInputs({ requiredStylists: 0 }));
    for (const s of slots) expect(s.light).toBe(false);
  });

  it('handles a slot of size other than 30 min', () => {
    const slots = computeCoverageSlots(baseInputs({
      businessHours: { startsAt: '2026-05-05T09:00:00', endsAt: '2026-05-05T10:00:00' },
      slotMinutes: 15,
    }));
    expect(slots).toHaveLength(4); // 09:00, 09:15, 09:30, 09:45
    expect(slots[1].startsAt).toBe('2026-05-05T09:15:00');
  });
});

describe('aggregateLightWindows', () => {
  const slot = (startsAt: string, endsAt: string, opts: { customers: number; required: number; scheduled: number }): CoverageSlot => ({
    startsAt,
    endsAt,
    customerCount: opts.customers,
    requiredStylists: opts.required,
    scheduledStylists: opts.scheduled,
    light: opts.scheduled < opts.required,
  });

  it('groups consecutive light slots into windows ranked by deficit desc', () => {
    const slots = [
      slot('2026-05-05T09:00:00', '2026-05-05T09:30:00', { customers: 25, required: 3, scheduled: 1 }),
      slot('2026-05-05T09:30:00', '2026-05-05T10:00:00', { customers: 20, required: 2, scheduled: 1 }),
      slot('2026-05-05T10:00:00', '2026-05-05T10:30:00', { customers: 5, required: 1, scheduled: 2 }),
      slot('2026-05-05T10:30:00', '2026-05-05T11:00:00', { customers: 12, required: 2, scheduled: 1 }),
    ];
    const windows = aggregateLightWindows(slots);
    expect(windows).toHaveLength(2);
    // First window: 09:00–10:00 (deficit 2 at peak)
    expect(windows[0].startsAt).toBe('2026-05-05T09:00:00');
    expect(windows[0].endsAt).toBe('2026-05-05T10:00:00');
    expect(windows[0].durationMinutes).toBe(60);
    expect(windows[0].deficit).toBe(2);
    expect(windows[0].requiredStylists).toBe(3);
    expect(windows[0].scheduledStylists).toBe(1);
    // Second: 10:30–11:00 (deficit 1)
    expect(windows[1].startsAt).toBe('2026-05-05T10:30:00');
    expect(windows[1].deficit).toBe(1);
  });

  it('returns empty when no slot is light', () => {
    expect(aggregateLightWindows([
      slot('2026-05-05T09:00:00', '2026-05-05T09:30:00', { customers: 5, required: 1, scheduled: 2 }),
    ])).toEqual([]);
  });

  it('does not bridge non-light slots between two light periods', () => {
    const slots = [
      slot('2026-05-05T09:00:00', '2026-05-05T09:30:00', { customers: 25, required: 3, scheduled: 1 }),
      slot('2026-05-05T09:30:00', '2026-05-05T10:00:00', { customers: 5, required: 1, scheduled: 2 }), // not light
      slot('2026-05-05T10:00:00', '2026-05-05T10:30:00', { customers: 25, required: 3, scheduled: 1 }),
    ];
    const windows = aggregateLightWindows(slots);
    expect(windows).toHaveLength(2);
    expect(windows[0].startsAt).toBe('2026-05-05T09:00:00');
    expect(windows[0].endsAt).toBe('2026-05-05T09:30:00');
    expect(windows[1].startsAt).toBe('2026-05-05T10:00:00');
    expect(windows[1].endsAt).toBe('2026-05-05T10:30:00');
  });
});
