export const t = {
  text: { color: 'var(--ck-text-primary)' },
  muted: { color: 'var(--ck-text-secondary)' },
  faint: { color: 'var(--ck-text-tertiary)' },
  danger: { color: 'rgba(248,113,113,0.95)' },
  success: { color: 'rgba(74,222,128,0.95)' },
  warning: { color: 'rgba(251,191,36,0.95)' },
  card: {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid var(--ck-border-subtle)',
    borderRadius: '10px',
    padding: '1rem',
  },
  input: {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid var(--ck-border-subtle)',
    borderRadius: '10px',
    padding: '0.6rem 0.75rem',
    color: 'var(--ck-text-primary)',
    width: '100%',
  },
  btnPrimary: {
    background: 'var(--ck-accent-red)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: '10px',
    padding: '0.5rem 0.75rem',
    color: 'white',
    fontWeight: 700,
    cursor: 'pointer',
    fontSize: '0.8rem',
  },
  btnGhost: {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid var(--ck-border-subtle)',
    borderRadius: '10px',
    padding: '0.5rem 0.75rem',
    color: 'var(--ck-text-primary)',
    fontWeight: 600,
    cursor: 'pointer',
    fontSize: '0.8rem',
  },
  badge: (color: string) => ({
    display: 'inline-block',
    background: color,
    borderRadius: '999px',
    padding: '0.15rem 0.5rem',
    fontSize: '0.7rem',
    fontWeight: 600,
    color: 'white',
  }),
  tableWrap: {
    overflowX: 'auto' as const,
    border: '1px solid var(--ck-border-subtle)',
    borderRadius: '10px',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: '0.85rem',
  },
  th: {
    textAlign: 'left' as const,
    padding: '0.65rem 0.75rem',
    borderBottom: '1px solid var(--ck-border-subtle)',
    color: 'var(--ck-text-tertiary)',
    fontWeight: 600,
    fontSize: '0.75rem',
    whiteSpace: 'nowrap' as const,
  },
  td: {
    padding: '0.75rem',
    borderBottom: '1px solid rgba(255,255,255,0.04)',
    verticalAlign: 'top' as const,
    color: 'var(--ck-text-primary)',
  },
};

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

export function fmtNumber(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat().format(value);
}

export function boolLabel(value: boolean | null | undefined, trueText = 'Yes', falseText = 'No'): string {
  if (value == null) return '—';
  return value ? trueText : falseText;
}

export function formatRelativeTime(value: string | null | undefined): string {
  if (!value) return 'never';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;

  const diffMs = d.getTime() - Date.now();
  const absMs = Math.abs(diffMs);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  if (absMs < hour) return rtf.format(Math.round(diffMs / minute), 'minute');
  if (absMs < day) return rtf.format(Math.round(diffMs / hour), 'hour');
  if (absMs < week) return rtf.format(Math.round(diffMs / day), 'day');
  if (absMs < month) return rtf.format(Math.round(diffMs / week), 'week');
  if (absMs < year) return rtf.format(Math.round(diffMs / month), 'month');
  return rtf.format(Math.round(diffMs / year), 'year');
}

export type FreshnessTone = 'fresh' | 'aging' | 'stale' | 'error' | 'never';

export type FreshnessSummary = {
  tone: FreshnessTone;
  label: string;
  detail: string;
  color: string;
};

export function describeFreshness(input: {
  lastSyncedAt?: string | null;
  lastSuccessAt?: string | null;
  lastError?: string | null;
}): FreshnessSummary {
  const lastAttempt = input.lastSyncedAt || null;
  const lastSuccess = input.lastSuccessAt || null;
  const lastError = input.lastError || null;
  const attemptTime = lastAttempt ? new Date(lastAttempt).getTime() : Number.NaN;
  const successTime = lastSuccess ? new Date(lastSuccess).getTime() : Number.NaN;
  const hasRecentError = Boolean(
    lastError &&
    lastAttempt &&
    (!lastSuccess || (!Number.isNaN(attemptTime) && !Number.isNaN(successTime) && attemptTime >= successTime))
  );

  if (hasRecentError) {
    return {
      tone: 'error',
      label: 'Error',
      detail: `Last attempt ${formatRelativeTime(lastAttempt)} • ${lastError}`,
      color: 'rgba(248,113,113,0.75)',
    };
  }

  if (!lastSuccess) {
    return {
      tone: 'never',
      label: 'Never synced',
      detail: lastAttempt ? `Attempted ${formatRelativeTime(lastAttempt)} but no success recorded yet` : 'No successful sync recorded yet',
      color: 'rgba(148,163,184,0.7)',
    };
  }

  const ageMs = Date.now() - new Date(lastSuccess).getTime();
  if (Number.isNaN(ageMs)) {
    return {
      tone: 'aging',
      label: 'Unknown age',
      detail: `Last success ${formatDateTime(lastSuccess)}`,
      color: 'rgba(148,163,184,0.7)',
    };
  }

  if (ageMs > 7 * 24 * 60 * 60 * 1000) {
    return {
      tone: 'stale',
      label: 'Stale',
      detail: `Last success ${formatRelativeTime(lastSuccess)} (${formatDateTime(lastSuccess)})`,
      color: 'rgba(248,113,113,0.75)',
    };
  }

  if (ageMs > 48 * 60 * 60 * 1000) {
    return {
      tone: 'aging',
      label: 'Aging',
      detail: `Last success ${formatRelativeTime(lastSuccess)} (${formatDateTime(lastSuccess)})`,
      color: 'rgba(251,191,36,0.75)',
    };
  }

  return {
    tone: 'fresh',
    label: 'Fresh',
    detail: `Last success ${formatRelativeTime(lastSuccess)} (${formatDateTime(lastSuccess)})`,
    color: 'rgba(74,222,128,0.75)',
  };
}

export function fieldValue(value: unknown, emptyText = '—'): string {
  if (value == null) return emptyText;
  const text = String(value).trim();
  return text || emptyText;
}

export type SyncStateSummary = {
  resource: string;
  lastSyncedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  rowCount: number | null;
};

export type SyncRunSummary = {
  id: string;
  resource: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  rowsWritten: number | null;
  rowsSeen: number | null;
  error: string | null;
  notes: string | null;
};

export function findSyncState(rows: SyncStateSummary[] | null | undefined, resource: string): SyncStateSummary | null {
  return (Array.isArray(rows) ? rows : []).find((row) => row.resource === resource) || null;
}

export function findLatestSyncRun(rows: SyncRunSummary[] | null | undefined, resource: string): SyncRunSummary | null {
  return (Array.isArray(rows) ? rows : []).find((row) => row.resource === resource) || null;
}

export async function loadCacheMeta(teamId: string, resource: string): Promise<{ syncState: SyncStateSummary | null; latestRun: SyncRunSummary | null; totalRows: number | null }> {
  const [healthRes, runsRes] = await Promise.all([
    api('yot', teamId, '/health') as Promise<{ syncState: SyncStateSummary[]; counts?: Record<string, number | null | undefined> }>,
    api('yot', teamId, '/sync-runs?limit=50') as Promise<{ data: SyncRunSummary[] }>,
  ]);
  return {
    syncState: findSyncState(healthRes?.syncState, resource),
    latestRun: findLatestSyncRun(runsRes?.data, resource),
    totalRows: typeof healthRes?.counts?.[resource] === 'number' ? healthRes.counts[resource] as number : null,
  };
}

export function renderCacheSummaryCards(
  h: (...args: any[]) => any,
  options: {
    syncState: SyncStateSummary | null;
    latestRun: SyncRunSummary | null;
    totalRows?: number | null;
    emptyLatestRunText: string;
  }
) {
  const freshness = describeFreshness(options.syncState || {});
  return h('div', { className: 'mt-3', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem' } },
    h('div', { style: { ...t.card, padding: '0.75rem' } },
      h('div', { className: 'text-xs', style: t.faint }, 'Freshness'),
      h('div', { className: 'mt-2' }, h('span', { style: t.badge(freshness.color) }, freshness.label)),
      h('div', { className: 'mt-2 text-xs', style: t.faint }, freshness.detail)
    ),
    h('div', { style: { ...t.card, padding: '0.75rem' } },
      h('div', { className: 'text-xs', style: t.faint }, 'Last sync rows'),
      h('div', { className: 'mt-1 text-sm font-medium', style: t.text }, fieldValue(options.syncState?.rowCount))
    ),
    h('div', { style: { ...t.card, padding: '0.75rem' } },
      h('div', { className: 'text-xs', style: t.faint }, 'Total records'),
      h('div', { className: 'mt-1 text-sm font-medium', style: t.text }, fieldValue(options.totalRows))
    ),
    h('div', { style: { ...t.card, padding: '0.75rem' } },
      h('div', { className: 'text-xs', style: t.faint }, 'Latest run'),
      options.latestRun
        ? h('div', null,
            h('div', { className: 'mt-1 text-sm font-medium', style: t.text }, `${options.latestRun.status} • ${formatRelativeTime(options.latestRun.startedAt)}`),
            h('div', { className: 'mt-1 text-xs', style: options.latestRun.error ? t.danger : t.faint }, options.latestRun.error || options.latestRun.notes || `${fieldValue(options.latestRun.rowsWritten)} written / ${fieldValue(options.latestRun.rowsSeen)} seen`)
          )
        : h('div', { className: 'mt-1 text-sm', style: t.faint }, options.emptyLatestRunText)
    )
  );
}

export type RevenueDatePreset = 'today' | 'yesterday' | 'this-week' | 'last-week' | 'this-month' | 'last-month' | 'this-year' | 'custom';

export const REVENUE_DATE_PRESET_OPTIONS: Array<{ value: RevenueDatePreset; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'this-week', label: 'This week' },
  { value: 'last-week', label: 'Last week' },
  { value: 'this-month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'this-year', label: 'This year' },
  { value: 'custom', label: 'Custom' },
];

function toLocalDateOnly(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseLocalDateOnly(value: string): Date {
  const [year, month, day] = value.split('-').map((part) => parseInt(part, 10));
  return new Date(year || 0, (month || 1) - 1, day || 1);
}

function addLocalDays(value: string, days: number): string {
  const date = parseLocalDateOnly(value);
  date.setDate(date.getDate() + days);
  return toLocalDateOnly(date);
}

function startOfLocalWeek(value: string): string {
  const date = parseLocalDateOnly(value);
  const dayOfWeek = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - dayOfWeek);
  return toLocalDateOnly(date);
}

function endOfLocalWeek(value: string): string {
  return addLocalDays(startOfLocalWeek(value), 6);
}

function startOfLocalMonth(value: string): string {
  const date = parseLocalDateOnly(value);
  date.setDate(1);
  return toLocalDateOnly(date);
}

function endOfLocalMonth(value: string): string {
  const date = parseLocalDateOnly(value);
  date.setMonth(date.getMonth() + 1, 0);
  return toLocalDateOnly(date);
}

function startOfLocalYear(value: string): string {
  const date = parseLocalDateOnly(value);
  date.setMonth(0, 1);
  return toLocalDateOnly(date);
}

export function resolveRevenueDatePreset(preset: RevenueDatePreset, today = toLocalDateOnly(new Date())): { startDate: string; endDate: string } | null {
  if (preset === 'custom') return null;
  if (preset === 'today') return { startDate: today, endDate: today };
  if (preset === 'yesterday') {
    const yesterday = addLocalDays(today, -1);
    return { startDate: yesterday, endDate: yesterday };
  }
  if (preset === 'this-week') return { startDate: startOfLocalWeek(today), endDate: endOfLocalWeek(today) };
  if (preset === 'last-week') {
    const anchor = addLocalDays(startOfLocalWeek(today), -1);
    return { startDate: startOfLocalWeek(anchor), endDate: endOfLocalWeek(anchor) };
  }
  if (preset === 'this-month') return { startDate: startOfLocalMonth(today), endDate: endOfLocalMonth(today) };
  if (preset === 'last-month') {
    const anchor = addLocalDays(startOfLocalMonth(today), -1);
    return { startDate: startOfLocalMonth(anchor), endDate: endOfLocalMonth(anchor) };
  }
  return { startDate: startOfLocalYear(today), endDate: today };
}

export function detectRevenueDatePreset(startDate: string, endDate: string, today = toLocalDateOnly(new Date())): RevenueDatePreset {
  for (const option of REVENUE_DATE_PRESET_OPTIONS) {
    if (option.value === 'custom') continue;
    const range = resolveRevenueDatePreset(option.value, today);
    if (range && range.startDate === startDate && range.endDate === endDate) return option.value;
  }
  return 'custom';
}

export function joinAddress(parts: Array<string | null | undefined>): string {
  return parts.map((part) => fieldValue(part, '')).filter(Boolean).join(', ') || '—';
}

export function parseRawJson(value: unknown): unknown | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function modal(
  h: (...args: any[]) => any,
  options: {
    title: string;
    subtitle?: string | null;
    onClose: () => void;
    children: any;
    footer?: any;
    width?: string;
  }
) {
  return h('div', {
    style: {
      position: 'fixed',
      inset: '0',
      background: 'rgba(15,23,42,0.72)',
      backdropFilter: 'blur(3px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '1.5rem',
      zIndex: 1000,
    },
    onClick: () => options.onClose(),
  },
    h('div', {
      style: {
        width: '100%',
        maxWidth: options.width || '56rem',
        maxHeight: '85vh',
        overflow: 'auto',
        background: 'rgb(18,24,33)',
        border: '1px solid var(--ck-border-subtle)',
        borderRadius: '14px',
        boxShadow: '0 24px 80px rgba(15,23,42,0.45)',
      },
      onClick: (event: any) => event.stopPropagation(),
    },
      h('div', {
        style: {
          display: 'flex',
          justifyContent: 'space-between',
          gap: '1rem',
          alignItems: 'flex-start',
          padding: '1rem 1rem 0.75rem',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        },
      },
        h('div', null,
          h('div', { className: 'text-sm font-medium', style: t.text }, options.title),
          options.subtitle ? h('div', { className: 'mt-1 text-xs', style: t.faint }, options.subtitle) : null
        ),
        h('button', {
          type: 'button',
          onClick: () => options.onClose(),
          style: { ...t.btnGhost, padding: '0.4rem 0.65rem' },
          'aria-label': 'Close dialog',
        }, 'Close')
      ),
      h('div', { style: { padding: '1rem' } }, options.children),
      options.footer
        ? h('div', {
            style: {
              padding: '0 1rem 1rem',
              borderTop: '1px solid rgba(255,255,255,0.06)',
              marginTop: '0.25rem',
              paddingTop: '0.75rem',
            },
          }, options.footer)
        : null
    )
  );
}

export function useEscapeToClose(R: any, open: boolean, onClose: () => void) {
  const useEffect = R.useEffect as typeof R.useEffect;
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function extractSearchParams(input: string): URLSearchParams {
  const text = String(input || '');
  const queryIndex = text.indexOf('?');
  if (queryIndex >= 0) return new URLSearchParams(text.slice(queryIndex + 1));
  return new URLSearchParams(text);
}

export function readLinkedViewParams(props: any) {
  const urlParams = typeof window !== 'undefined'
    ? [
        new URLSearchParams(window.location.search || ''),
        extractSearchParams(window.location.hash || ''),
      ]
    : [];
  const buckets = [
    props,
    props?.variables,
    props?.params,
    props?.query,
    props?.filters,
    props?.context,
    props?.context?.variables,
    props?.context?.params,
    props?.context?.query,
  ].filter(Boolean);
  const pick = (...keys: string[]) => firstNonEmptyString(
    ...buckets.flatMap((bucket: any) => keys.map((key) => bucket?.[key])),
    ...urlParams.flatMap((params) => keys.map((key) => params.get(key)))
  );

  return {
    teamId: pick('teamId', 'team'),
    locationId: pick('locationId', 'location'),
    stylistId: pick('stylistId', 'stylist', 'staffId'),
    clientId: pick('clientId', 'client'),
    appointmentId: pick('appointmentId', 'appointment'),
    search: pick('search', 'q'),
    status: pick('status', 'statusCode'),
    startDate: pick('startDate', 'dateFrom'),
    endDate: pick('endDate', 'dateTo'),
  };
}

export async function api<T = any>(pluginId: string, teamId: string, path: string, init?: RequestInit): Promise<T> {
  const join = path.startsWith('/') ? path : `/${path}`;
  const url = `/api/plugins/${pluginId}${join}${join.includes('?') ? '&' : '?'}team=${encodeURIComponent(teamId)}`;
  const res = await fetch(url, init);
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(text || `HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(json?.message || json?.error || `HTTP ${res.status}`);
  // Return the raw response envelope so tabs can access metadata (data, total, offset,
  // manifest, state, etc.). Previously we unwrapped `.data` here, which caused a
  // double-unwrap bug in list tabs (locations/clients/sync-runs) where `data?.data`
  // was always undefined and tables rendered empty.
  return json;
}
