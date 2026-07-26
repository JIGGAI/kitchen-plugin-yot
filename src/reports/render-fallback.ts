/**
 * YOT's Telerik report server (youreontime-reports.azurewebsites.net) lost its
 * XLSX rendering extension on 2026-07-26 — `GET .../documents/<id>/info` began
 * returning 500 DocumentRenderException "XLSX rendering format is not
 * available." while PDF/CSV/RTF/IMAGE kept working.
 *
 * Deliberately narrow: only this specific renderer outage may trigger a format
 * fallback. Any other failure (auth, timeout, upstream 500) must keep bubbling
 * up, so a format switch never masks a different problem.
 */
export function isXlsxRenderingUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /rendering format is not available/i.test(message) && /xlsx/i.test(message);
}
