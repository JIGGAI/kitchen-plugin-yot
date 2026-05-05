// Pure-function coverage math.
//
// computeCoverageSlots takes the day's appointments + scheduled shifts, and
// produces per-slot counts (customers, required, scheduled) + a `light` flag.
//
// aggregateLightWindows groups consecutive light slots into actionable windows
// ranked by deficit. A "non-light" slot between two light periods breaks them
// into separate windows — the gap is real and shouldn't be papered over.

import type {
  AppointmentInterval,
  CoverageInputs,
  CoverageSlot,
  Interval,
  LightWindow,
  StylistInterval,
} from './types';

function pad2(n: number): string { return String(n).padStart(2, '0'); }

function addMinutesToIso(iso: string, minutes: number): string {
  const date = new Date(iso);
  date.setMinutes(date.getMinutes() + minutes);
  // Preserve "no Z" local-naive ISO produced upstream.
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function overlaps(a: Interval, b: Interval): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}

function distinctStylistsOverlapping(list: StylistInterval[], slot: Interval): number {
  const set = new Set<string>();
  for (const seg of list) if (overlaps(seg, slot)) set.add(seg.stylistId);
  return set.size;
}

function countAppointmentsOverlapping(list: AppointmentInterval[], slot: Interval): number {
  let n = 0;
  for (const a of list) if (overlaps(a, slot)) n++;
  return n;
}

export function computeCoverageSlots(input: CoverageInputs): CoverageSlot[] {
  const slots: CoverageSlot[] = [];
  let cursor = input.businessHours.startsAt;
  // Same required for every slot — driven by the location's daily average,
  // not by who happens to be booked in this 30-min window.
  const requiredStylists = input.requiredStylists;
  while (cursor < input.businessHours.endsAt) {
    const next = addMinutesToIso(cursor, input.slotMinutes);
    const slot: Interval = { startsAt: cursor, endsAt: next };
    const customerCount = countAppointmentsOverlapping(input.appointments, slot);
    const scheduledStylists = distinctStylistsOverlapping(input.scheduled, slot);
    const light = requiredStylists > 0 && scheduledStylists < requiredStylists;
    slots.push({
      startsAt: cursor,
      endsAt: next,
      customerCount,
      requiredStylists,
      scheduledStylists,
      light,
    });
    cursor = next;
  }
  return slots;
}

export function aggregateLightWindows(slots: CoverageSlot[]): LightWindow[] {
  const out: LightWindow[] = [];
  let i = 0;
  while (i < slots.length) {
    if (!slots[i].light) { i++; continue; }
    let j = i;
    while (j < slots.length && slots[j].light) j++;
    const group = slots.slice(i, j);
    const peakRequired = group.reduce((m, s) => Math.max(m, s.requiredStylists), 0);
    const minScheduled = group.reduce((m, s) => Math.min(m, s.scheduledStylists), Infinity);
    const peakCustomers = group.reduce((m, s) => Math.max(m, s.customerCount), 0);
    const startsAt = group[0].startsAt;
    const endsAt = group[group.length - 1].endsAt;
    const durationMinutes = (new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 60000;
    out.push({
      startsAt,
      endsAt,
      durationMinutes,
      customerCount: peakCustomers,
      requiredStylists: peakRequired,
      scheduledStylists: Number.isFinite(minScheduled) ? minScheduled : 0,
      deficit: peakRequired - (Number.isFinite(minScheduled) ? minScheduled : 0),
    });
    i = j;
  }
  return out.sort((a, b) => (b.deficit - a.deficit) || a.startsAt.localeCompare(b.startsAt));
}
