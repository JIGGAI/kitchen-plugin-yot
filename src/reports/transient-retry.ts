/**
 * Bounded retry for transient YOT report-server failures.
 *
 * Twice now (2026-10-12 for ~1 h, 2026-11-05 for <15 min) YOT's Telerik
 * report server answered `POST /instances` with
 * `500 SqlException: Execution Timeout Expired`, the nightly Branch
 * disbursement export exited 1 within a minute of starting, and payroll
 * went out by hand once someone noticed. The outage was gone by the time
 * anyone looked. This helper lets the export keep asking for a bounded
 * window instead of giving up on the first answer.
 *
 * Deliberately narrow: only failures that a later identical request could
 * plausibly succeed at are retried. Auth, bad parameters, missing documents
 * and data errors (CSV rows that do not reconcile) fail fast exactly as
 * before, so the retry never masks a different problem. The XLSX renderer
 * outage is excluded too — render-fallback.ts already handles that.
 */
import { isXlsxRenderingUnavailable } from './render-fallback';

const REPORT_FAILURE_WITH_STATUS = /^Report (?:request|client creation|document fetch) failed(?: \([^)]*\))?: (\d{3})\b/;
// A connection that never opened, dropped mid-response ("terminated",
// "other side closed") or was cut by a timeout ("The operation was aborted."
// is what node-fetch says, and what ended the corp export on 2026-11-16).
const NETWORK_FAILURE = /\b(?:fetch failed|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|ENETUNREACH|EHOSTUNREACH|socket hang up|UND_ERR_[A-Z_]+|network error|terminated|other side closed|operation was aborted|timed out|premature close)\b/i;
const SQL_TIMEOUT = /Execution Timeout Expired|SqlException/;
// The report server accepted the request but never finished rendering.
const DOCUMENT_NOT_READY = /did not become ready after \d+ polls/;

/**
 * True for a failure of the connection itself rather than of the request:
 * checks the message, the error name and `code`, and one level of `cause`
 * (Node's fetch reports "fetch failed" and keeps the reason on `cause`).
 */
export function isNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  if (typeof code === 'string' && (code === 'AbortError' || code === 'TimeoutError' || NETWORK_FAILURE.test(code))) return true;
  if (NETWORK_FAILURE.test(error.message)) return true;
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error && cause !== error ? isNetworkFailure(cause) : false;
}

function transientStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

export function isTransientReportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (isXlsxRenderingUnavailable(error)) return false;
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number' && Number.isFinite(status)) return transientStatus(status);
  const fromMessage = REPORT_FAILURE_WITH_STATUS.exec(error.message);
  if (fromMessage) return transientStatus(Number(fromMessage[1]));
  if (SQL_TIMEOUT.test(error.message)) return true;
  if (DOCUMENT_NOT_READY.test(error.message)) return true;
  return isNetworkFailure(error);
}

export type RetryEvent = {
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  error: Error;
  /** Epoch ms (per `now`) at which the next attempt will start. */
  nextAttemptAt: number;
  /** Epoch ms (per `now`) after which no new attempt is started. */
  deadline: number;
};

export type RetryOptions = {
  /** How long after the first attempt starts a new attempt may still begin.
   *  0 = a single attempt, no retry. */
  windowMs: number;
  /** Pause between the end of one attempt and the start of the next. */
  intervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (event: RetryEvent) => void;
  isTransient?: (error: unknown) => boolean;
  /** What is being retried, for the final error message. Default "Report fetch". */
  label?: string;
};

export type RetryResult<T> = {
  value: T;
  /** Total attempts made, including the successful one. 1 = no retry. */
  attempts: number;
  /** Messages of the attempts that failed, in order. */
  failures: string[];
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` until it resolves, retrying transient failures every
 * `intervalMs` as long as the next attempt would start no later than
 * `windowMs` after the first one began. Any other error, or the last
 * transient error once the window is spent, is rethrown — the final error
 * keeps the original message and prefixes the attempt count so the cron log
 * says what was tried.
 */
export async function retryTransient<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<RetryResult<T>> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const isTransient = options.isTransient ?? isTransientReportError;
  const intervalMs = Math.max(0, options.intervalMs);
  const start = now();
  const deadline = start + Math.max(0, options.windowMs);
  const failures: string[] = [];
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const value = await fn(attempt);
      return { value, attempts: attempt, failures };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (!isTransient(error)) throw error;
      failures.push(error.message);
      const nextAttemptAt = now() + intervalMs;
      if (nextAttemptAt > deadline) {
        const elapsedMin = Math.round((now() - start) / 60_000);
        const finalError = new Error(`${options.label ?? 'Report fetch'} still failing after ${attempt} attempts over ${elapsedMin} min: ${error.message}`);
        (finalError as { cause?: unknown }).cause = error;
        (finalError as { attempts?: number }).attempts = attempt;
        throw finalError;
      }
      options.onRetry?.({ attempt, error, nextAttemptAt, deadline });
      await sleep(intervalMs);
    }
  }
}
