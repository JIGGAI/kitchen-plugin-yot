// Per-group configuration for the nightly Branch disbursement pipeline.
// Everything that differs between distribution groups lives here; the export,
// watchdog, and weekend-combine scripts stay single-sourced and take a
// --group flag. Adding a third group means adding one entry below.

export type DisbursementGroupId = 'corp' | 'hmx-group';

export type DisbursementGroupConfig = {
  id: DisbursementGroupId;
  /** Human label for logs. */
  label: string;
  /** Label shown to dashboard users. Separate from `label` because the log
   *  names ("CORP") are internal shorthand — staff know the two payout runs as
   *  "HMX" and "HMX Group". */
  displayLabel: string;
  /** Spreadsheet holding the roster tab. Separate from dailyTotalsSheetId
   *  because corp's roster lives on the Branch Daily Totals sheet while its
   *  daily tabs do too — hmx-group keeps both on its own sheet. */
  rosterSheetId: string;
  /** Human name of rosterSheetId, for the disbursements email prose. */
  rosterSheetLabel: string;
  /** Roster tab: staff id, first, last, location. Defines this group's
   *  in-scope locations. */
  rosterTab: string;
  /** Spreadsheet receiving the per-day BRANCH MASTER tabs, and holding the
   *  BRANCH MASTER template. */
  dailyTotalsSheetId: string;
  /** Template tab for the per-day BRANCH MASTER tabs: supplies the row-2
   *  header labels and the location labels in rows
   *  branchMasterFirstLocationRow..branchMasterLastLocationRow, and anchors
   *  where each new daily tab is positioned. Read for content, so a rename
   *  or an incomplete copy produces blank daily tabs rather than an error. */
  branchMasterTemplateTab: string;
  /** Spreadsheet receiving the per-day CSV mirror tabs. */
  dispursementsSheetId: string;
  /** Template tab supplying the CSV mirror header. */
  dispursementsTemplateTab: string;
  /** Prefix on the per-day CSV-mirror tab name. Empty for corp, whose mirror
   *  lives on its own spreadsheet and so cannot collide with the BRANCH MASTER
   *  daily tab. hmx-group shares one spreadsheet for both, so its mirror is
   *  prefixed to keep the two per-day tabs distinct. */
  dispursementsTabPrefix: string;
  /** BRANCH MASTER template geometry, 1-based rows. */
  branchMasterFirstLocationRow: number;
  branchMasterLastLocationRow: number;
  branchMasterTotalRow: number;
  /** Prepended to every output filename. Empty for corp so its historical
   *  names — which the watchdog, weekend combine, and Miranda all rely on —
   *  are unchanged. */
  filePrefix: string;
  /** Email subject prefix: `<prefix> Disbursements <date> — …`. */
  emailSubjectPrefix: string;
  emailTo: string;
  /** Copied on the disbursements email. Add addresses here as the group grows. */
  emailCc: readonly string[];
  /** When false the export never reads or writes the garnishments
   *  spreadsheet and applies no withholding. */
  garnishmentsEnabled: boolean;
  loansEnabled: boolean;
};

const BRANCH_DAILY_TOTALS_SHEET_ID = '1jIFWOMmvMVbGULUbDpEqV2e6CsXy_DzhBrCorV9H-EA';
const CORP_DISPURSEMENTS_SHEET_ID = '1Z9Ey0oaKAH1J4gy0JlL-m3HjLvy4PKbBYFno3dYjbH8';
const HMX_GROUP_SHEET_ID = '1LsYEOuwjxmiCrbuTmAgD5-PTXxNL2gjCmKWaHhqxToc';

export const GROUP_CONFIGS: Record<DisbursementGroupId, DisbursementGroupConfig> = {
  corp: {
    id: 'corp',
    label: 'CORP',
    displayLabel: 'HMX',
    rosterSheetId: BRANCH_DAILY_TOTALS_SHEET_ID,
    rosterSheetLabel: 'Branch Daily Totals',
    rosterTab: 'CORP CSV MASTER',
    dailyTotalsSheetId: BRANCH_DAILY_TOTALS_SHEET_ID,
    branchMasterTemplateTab: 'BRANCH MASTER',
    dispursementsSheetId: CORP_DISPURSEMENTS_SHEET_ID,
    // Trailing space is intentional — that is the tab's real name.
    dispursementsTemplateTab: 'CSV BLANK MASTER ',
    dispursementsTabPrefix: '',
    branchMasterFirstLocationRow: 4,
    branchMasterLastLocationRow: 18,
    branchMasterTotalRow: 21,
    filePrefix: '',
    emailSubjectPrefix: 'HMX',
    emailTo: 'Miranda.hmx.corp@hairmx.net',
    emailCc: ['info@hairmx.com'],
    garnishmentsEnabled: true,
    loansEnabled: true,
  },
  'hmx-group': {
    id: 'hmx-group',
    label: 'HMX GROUP',
    displayLabel: 'HMX Group',
    // Moved 2026-10-15 from 'HAIR MX GROUP CSV MASTER' on the Branch Daily
    // Totals sheet: the customer maintains their roster on their own sheet.
    rosterSheetId: HMX_GROUP_SHEET_ID,
    rosterSheetLabel: 'HMX Group Branch Daily Totals',
    rosterTab: 'HAIR MX GROUP STAFF CSV MASTER',
    dailyTotalsSheetId: HMX_GROUP_SHEET_ID,
    // Leading space is intentional — that is the tab's real name. Renamed by
    // the customer from 'BRANCH MASTER' on 2026-10-15.
    branchMasterTemplateTab: ' HAIR MX GROUP BRANCH DAILY TOTALS MASTER',
    dispursementsSheetId: HMX_GROUP_SHEET_ID,
    // Leading space is intentional — that is the tab's real name. The customer
    // renamed the template from 'CSV BLANK MASTER' on 2026-10-15; the export
    // only uses it to position each day's CSV tab, so a mismatch is silent.
    dispursementsTemplateTab: ' HAIR MX GROUP DISBURSEMENT CSV MASTER',
    dispursementsTabPrefix: 'CSV ',
    branchMasterFirstLocationRow: 4,
    branchMasterLastLocationRow: 7,
    branchMasterTotalRow: 10,
    filePrefix: 'hmxgroup-',
    emailSubjectPrefix: 'HMX GROUP',
    emailTo: 'Miranda.hmx.corp@hairmx.net',
    emailCc: ['deanna@hairmxgroup.com', 'linsey@hairmxgroup.com'],
    garnishmentsEnabled: false,
    loansEnabled: false,
  },
};

export function resolveGroupConfig(id?: string | null): DisbursementGroupConfig {
  const key = (id || 'corp') as DisbursementGroupId;
  if (!Object.prototype.hasOwnProperty.call(GROUP_CONFIGS, key)) {
    throw new Error(`Unknown --group value: ${id} (expected one of ${Object.keys(GROUP_CONFIGS).join(', ')})`);
  }
  return GROUP_CONFIGS[key];
}

export function otherGroupConfigs(id: DisbursementGroupId): DisbursementGroupConfig[] {
  return (Object.keys(GROUP_CONFIGS) as DisbursementGroupId[])
    .filter((k) => k !== id)
    .map((k) => GROUP_CONFIGS[k]);
}
