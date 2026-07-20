import { describe, it, expect } from 'vitest';
import { GROUP_CONFIGS, otherGroupConfigs, resolveGroupConfig } from '../group-config';

describe('resolveGroupConfig', () => {
  it('defaults to corp when no id is given', () => {
    expect(resolveGroupConfig().id).toBe('corp');
    expect(resolveGroupConfig('').id).toBe('corp');
  });

  it('resolves hmx-group', () => {
    expect(resolveGroupConfig('hmx-group').id).toBe('hmx-group');
  });

  it('rejects an unknown group id', () => {
    expect(() => resolveGroupConfig('nope')).toThrow(/Unknown --group/);
  });
});

describe('corp config preserves existing production behavior', () => {
  const corp = GROUP_CONFIGS.corp;

  it('keeps historical filenames (no prefix)', () => {
    expect(corp.filePrefix).toBe('');
  });

  it('reads the renamed roster tab', () => {
    expect(corp.rosterTab).toBe('CORP CSV MASTER');
  });

  it('keeps its recipients and subject prefix', () => {
    expect(corp.emailTo).toBe('Miranda.hmx.corp@hairmx.net');
    expect(corp.emailCc).toEqual(['info@hairmx.com']);
    expect(corp.emailSubjectPrefix).toBe('HMX');
  });

  it('keeps garnishments and loans enabled', () => {
    expect(corp.garnishmentsEnabled).toBe(true);
    expect(corp.loansEnabled).toBe(true);
  });

  it('keeps its BRANCH MASTER geometry', () => {
    expect([corp.branchMasterFirstLocationRow, corp.branchMasterLastLocationRow, corp.branchMasterTotalRow]).toEqual([4, 18, 21]);
  });

  it('keeps the trailing space in its template tab name', () => {
    expect(corp.dispursementsTemplateTab).toBe('CSV BLANK MASTER ');
  });

  it('does not prefix its CSV-mirror tab (separate spreadsheet, no collision)', () => {
    expect(corp.dispursementsTabPrefix).toBe('');
  });
});

describe('hmx-group config', () => {
  const grp = GROUP_CONFIGS['hmx-group'];

  it('prefixes its output files', () => {
    expect(grp.filePrefix).toBe('hmxgroup-');
  });

  it('uses its own roster tab and its own spreadsheet for per-day tabs', () => {
    expect(grp.rosterTab).toBe('HAIR MX GROUP CSV MASTER');
    expect(grp.rosterSheetId).toBe(GROUP_CONFIGS.corp.rosterSheetId);
    expect(grp.dailyTotalsSheetId).toBe('1LsYEOuwjxmiCrbuTmAgD5-PTXxNL2gjCmKWaHhqxToc');
    expect(grp.dispursementsSheetId).toBe(grp.dailyTotalsSheetId);
  });

  it('disables garnishments and loans', () => {
    expect(grp.garnishmentsEnabled).toBe(false);
    expect(grp.loansEnabled).toBe(false);
  });

  it('emails Miranda with RJ copied', () => {
    expect(grp.emailTo).toBe('Miranda.hmx.corp@hairmx.net');
    expect(grp.emailCc).toEqual(['rjdjohnston@gmail.com', 'deanna@hairmxgroup.com', 'linsey@hairmxgroup.com']);
    expect(grp.emailSubjectPrefix).toBe('HMX GROUP');
  });

  it('uses 4-location BRANCH MASTER geometry', () => {
    expect([grp.branchMasterFirstLocationRow, grp.branchMasterLastLocationRow, grp.branchMasterTotalRow]).toEqual([4, 7, 10]);
  });

  it('uses a template tab name with no trailing space', () => {
    expect(grp.dispursementsTemplateTab).toBe('CSV BLANK MASTER');
  });

  it('prefixes its CSV-mirror tab so it cannot overwrite the daily tab', () => {
    expect(grp.dispursementsTabPrefix).toBe('CSV ');
  });
});

describe('otherGroupConfigs', () => {
  it('returns every group except the named one', () => {
    expect(otherGroupConfigs('corp').map((g) => g.id)).toEqual(['hmx-group']);
    expect(otherGroupConfigs('hmx-group').map((g) => g.id)).toEqual(['corp']);
  });
});
