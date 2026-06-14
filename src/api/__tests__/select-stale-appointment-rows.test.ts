import { describe, it, expect } from 'vitest';
import { selectStaleAppointmentRows } from '../handler';

const WIN_START = '2026-06-01';
const WIN_END = '2026-06-20';

describe('selectStaleAppointmentRows', () => {
  it('prunes an in-window cached row the current feed no longer returns', () => {
    const stale = selectStaleAppointmentRows(
      [
        { id: '6857:1', appointmentId: '1', startAt: '2026-06-12T09:00:00' }, // gone from feed
        { id: '6857:2', appointmentId: '2', startAt: '2026-06-12T10:00:00' }, // still in feed
      ],
      new Set(['2']),
      WIN_START,
      WIN_END,
    );
    expect(stale).toEqual(['6857:1']);
  });

  it('never touches rows outside the fetched window, even if absent from the feed', () => {
    const stale = selectStaleAppointmentRows(
      [
        { id: '6857:old', appointmentId: 'old', startAt: '2026-01-15T09:00:00' }, // before window
        { id: '6857:future', appointmentId: 'future', startAt: '2026-12-25T09:00:00' }, // after window
      ],
      new Set(), // feed returned nothing for these dates (not fetched)
      WIN_START,
      WIN_END,
    );
    expect(stale).toEqual([]);
  });

  it('keeps every in-window row the feed still returns', () => {
    const stale = selectStaleAppointmentRows(
      [
        { id: '6857:1', appointmentId: '1', startAt: '2026-06-05T09:00:00' },
        { id: '6857:2', appointmentId: '2', startAt: '2026-06-06T09:00:00' },
      ],
      new Set(['1', '2']),
      WIN_START,
      WIN_END,
    );
    expect(stale).toEqual([]);
  });

  it('respects window boundaries inclusively', () => {
    const stale = selectStaleAppointmentRows(
      [
        { id: 'a', appointmentId: 'a', startAt: '2026-06-01T00:00:00' }, // == start, in
        { id: 'b', appointmentId: 'b', startAt: '2026-06-20T23:59:00' }, // == end, in
        { id: 'c', appointmentId: 'c', startAt: '2026-05-31T23:00:00' }, // before, out
      ],
      new Set(),
      WIN_START,
      WIN_END,
    );
    expect(stale.sort()).toEqual(['a', 'b']); // c is out of window, untouched
  });

  it('skips rows with a null appointmentId or null startAt', () => {
    const stale = selectStaleAppointmentRows(
      [
        { id: 'x', appointmentId: null, startAt: '2026-06-10T09:00:00' },
        { id: 'y', appointmentId: 'y', startAt: null },
      ],
      new Set(),
      WIN_START,
      WIN_END,
    );
    expect(stale).toEqual([]);
  });
});
