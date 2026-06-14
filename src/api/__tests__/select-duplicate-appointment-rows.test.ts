import { describe, it, expect } from 'vitest';
import { selectDuplicateAppointmentRows } from '../handler';

describe('selectDuplicateAppointmentRows', () => {
  it('keeps the copy with a real status over a blank one', () => {
    // The live Howell/Rochester case: blank Howell copy is the stale one.
    const del = selectDuplicateAppointmentRows([
      { id: '6857:17678764', appointmentId: '17678764', statusDescription: null, syncedAt: '2026-06-11T21:07:25Z' },
      { id: '7712:17678764', appointmentId: '17678764', statusDescription: 'Complete', syncedAt: '2026-06-12T14:03:15Z' },
    ]);
    expect(del).toEqual(['6857:17678764']);
  });

  it('falls back to freshest syncedAt when both have a status', () => {
    const del = selectDuplicateAppointmentRows([
      { id: 'A:1', appointmentId: '1', statusDescription: 'Confirmed', syncedAt: '2026-06-10T00:00:00Z' },
      { id: 'B:1', appointmentId: '1', statusDescription: 'Confirmed', syncedAt: '2026-06-12T00:00:00Z' },
    ]);
    expect(del).toEqual(['A:1']); // older one removed
  });

  it('leaves non-duplicated appointments untouched', () => {
    const del = selectDuplicateAppointmentRows([
      { id: '6857:100', appointmentId: '100', statusDescription: 'Complete', syncedAt: '2026-06-12T00:00:00Z' },
      { id: '7712:200', appointmentId: '200', statusDescription: 'Complete', syncedAt: '2026-06-12T00:00:00Z' },
    ]);
    expect(del).toEqual([]);
  });

  it('collapses three copies down to one, deleting two', () => {
    const del = selectDuplicateAppointmentRows([
      { id: 'A:9', appointmentId: '9', statusDescription: null, syncedAt: '2026-06-10T00:00:00Z' },
      { id: 'B:9', appointmentId: '9', statusDescription: 'Arrived', syncedAt: '2026-06-11T00:00:00Z' },
      { id: 'C:9', appointmentId: '9', statusDescription: null, syncedAt: '2026-06-12T00:00:00Z' },
    ]).sort();
    expect(del).toEqual(['A:9', 'C:9']); // keeps B:9 (the only one with a status)
  });

  it('is deterministic on a full tie (status + syncedAt equal) via id', () => {
    const del = selectDuplicateAppointmentRows([
      { id: '6857:5', appointmentId: '5', statusDescription: 'X', syncedAt: '2026-06-12T00:00:00Z' },
      { id: '7712:5', appointmentId: '5', statusDescription: 'X', syncedAt: '2026-06-12T00:00:00Z' },
    ]);
    expect(del).toHaveLength(1);
    expect(['6857:5', '7712:5']).toContain(del[0]);
  });

  it('skips rows with a null appointmentId', () => {
    const del = selectDuplicateAppointmentRows([
      { id: 'A:n', appointmentId: null, statusDescription: null, syncedAt: '2026-06-12T00:00:00Z' },
      { id: 'B:n', appointmentId: null, statusDescription: null, syncedAt: '2026-06-12T00:00:00Z' },
    ]);
    expect(del).toEqual([]);
  });
});
