import { describe, expect, it } from 'vitest';
import { isXlsxRenderingUnavailable } from '../render-fallback';

// The exact error YOT's Telerik server started returning on 2026-07-26 once
// the XLSX rendering extension disappeared from the Azure deployment.
const REAL_ERROR =
  'Report request failed (GET /instances/49304b7b09f/documents/c01530c87a8b71d9e28cc8/info): 500 ' +
  '{"message":"","exceptionMessage":"XLSX rendering format is not available.","exceptionType":"DocumentRenderException","stackTrace":null}';

describe('isXlsxRenderingUnavailable', () => {
  it('recognises the XLSX rendering outage', () => {
    expect(isXlsxRenderingUnavailable(new Error(REAL_ERROR))).toBe(true);
  });

  it('does not treat unrelated report failures as an XLSX outage', () => {
    // Falling back on these would mask a real problem behind a format switch.
    expect(isXlsxRenderingUnavailable(new Error('YOT /appointmentsrange failed: 500'))).toBe(false);
    expect(isXlsxRenderingUnavailable(new Error('connect ETIMEDOUT'))).toBe(false);
    expect(isXlsxRenderingUnavailable(new Error('Report client creation failed: 401'))).toBe(false);
  });
});
