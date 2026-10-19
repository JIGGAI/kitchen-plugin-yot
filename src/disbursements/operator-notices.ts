// Operator notices that ride along with a disbursements email: stylists who
// earned money at a Branch-served shop but are not on the roster (pay by
// hand today), roster spellings that only matched YOT by fuzzy match, and
// loans that finished today. One formatter for the nightly export email, the
// watchdog, and the Sunday weekend combine, so the three never disagree.
//
// On 2026-10-17/18 the nightly emails correctly listed Robin Foster (Troy)
// and Antonio Heath (Howell) as "missing from the roster", but Miranda works
// the weekend from the Sunday-night combined Sat+Sun email, which carried no
// notices at all — so neither was paid. See combine-weekend-deposits.ts.

export type UnmatchedReportRow = {
  staffName: string | null;
  locationName: string | null;
  bankToBankAmount: number;
  /** true when the YOT row's shop is on the roster (so this is likely a new
   *  hire or a visiting stylist at a Branch-served shop). */
  inScope: boolean;
};

export type FuzzyMatchedRow = {
  csvMasterRowNumber: number;
  csvMasterName: string;
  reportName: string;
  locationName: string | null;
  matchKind: 'prefix' | 'typo';
};

export type LoanPaidOff = {
  staffId: string;
  firstName: string;
  lastName: string;
  totalAmount: number;
  paidOffOn: string;
  loanRow: number;
};

/** The subset of a day's diagnostics JSON these notices are built from. */
export type DayNoticeSource = {
  reportRowsWithPositiveAmountButNoBranchMatch?: UnmatchedReportRow[];
  fuzzyMatchedRows?: FuzzyMatchedRow[];
  loansPaidOffToday?: LoanPaidOff[];
};

export function formatMissingFromRosterSection(rosterTab: string, rows: UnmatchedReportRow[], dayLabel = 'today'): string | null {
  const inScope = rows.filter((r) => r.inScope);
  if (!inScope.length) return null;
  const lines = inScope.map((r) => `- ${r.staffName || '?'} @ ${r.locationName || '?'} earned $${r.bankToBankAmount} ${dayLabel} (YOT bank-to-bank). They aren't on ${rosterTab}, so they were not in the deposit CSV. Action: pay them manually for that day's amount, then add them to ${rosterTab} (with their Branch STAFF ID) so the next export covers them.`);
  return `Missing from ${rosterTab} (manual payout for ${dayLabel}):\n${lines.join('\n')}`;
}

export function formatSpellingDriftSection(rosterTab: string, rows: FuzzyMatchedRow[]): string | null {
  const typos = rows.filter((r) => r.matchKind === 'typo');
  if (!typos.length) return null;
  const lines = typos.map((r) => `- ${rosterTab} row ${r.csvMasterRowNumber} has "${r.csvMasterName}"; YOT has "${r.reportName}" (${r.locationName || '?'}). The export paid them via fuzzy match. Please fix the spelling on ${rosterTab}.`);
  return `${rosterTab} spelling drift vs YOT:\n${lines.join('\n')}`;
}

export function formatLoansPaidOffSection(rows: LoanPaidOff[]): string | null {
  if (!rows.length) return null;
  const lines = rows.map((l) => `- ${l.firstName} ${l.lastName} (staff id ${l.staffId}) finished a $${l.totalAmount.toFixed(2)} loan on ${l.paidOffOn} (LOANS row ${l.loanRow}). Archive the row to a "PAID …" tab when convenient.`);
  return `Loans paid off:\n${lines.join('\n')}`;
}

/** All three sections for one day, in the order the nightly email has
 *  always used. `dayLabel` names the day when several days share an email
 *  ("Saturday 2026-10-17"); the nightly email uses the default "today". */
export function buildDayNotices(rosterTab: string, day: DayNoticeSource, dayLabel = 'today'): string[] {
  const sections: string[] = [];
  const spelling = formatSpellingDriftSection(rosterTab, day.fuzzyMatchedRows || []);
  if (spelling) sections.push(spelling);
  const missing = formatMissingFromRosterSection(rosterTab, day.reportRowsWithPositiveAmountButNoBranchMatch || [], dayLabel);
  if (missing) sections.push(missing);
  const loans = formatLoansPaidOffSection(day.loansPaidOffToday || []);
  if (loans) sections.push(loans);
  return sections;
}

/** Trailing email block, or '' when there is nothing to say. */
export function formatNoticesBlock(sections: string[]): string {
  if (!sections.length) return '';
  return `\n\nWatchdog messages:\n${sections.join('\n\n')}`;
}
