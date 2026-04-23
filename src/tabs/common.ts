export const t = {
  text: { color: 'var(--ck-text-primary)' },
  muted: { color: 'var(--ck-text-secondary)' },
  faint: { color: 'var(--ck-text-tertiary)' },
  danger: { color: 'rgba(248,113,113,0.95)' },
  success: { color: 'rgba(74,222,128,0.95)' },
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
  return json?.data ?? json;
}
