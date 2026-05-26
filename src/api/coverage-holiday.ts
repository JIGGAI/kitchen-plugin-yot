// Shared overlay: given coverage history cells and a date→holidayName map,
// mark holiday dates closed (with the name) and zero out gap warnings.

export type HistoryCell = {
  date: string;
  stylists: number;
  appts: number;
  required: number;
  lightHours: number;
  underCover: boolean;
  closed: boolean;
  hasRoster: boolean;
  holiday?: { name: string } | null;
};

export function attachHolidayToCells<T extends HistoryCell>(
  cells: T[],
  holidays: Map<string, string>,
): Array<T & { holiday: { name: string } | null }> {
  return cells.map((c) => {
    const name = holidays.get(c.date);
    if (!name) return { ...c, holiday: null };
    return { ...c, holiday: { name }, closed: true, underCover: false, lightHours: 0 };
  });
}
