import { api, boolLabel, describeFreshness, fieldValue, formatDateTime, formatRelativeTime, t } from './common';

(function () {
  const R = (window as any).React;
  if (!R) return;
  const h = R.createElement;
  const useEffect = R.useEffect as typeof R.useEffect;
  const useState = R.useState as (initial: any) => [any, (value: any) => void];

  type Row = {
    id: string;
    locationId: string | null;
    privateId: string | null;
    givenName: string | null;
    surname: string | null;
    fullName: string | null;
    emailAddress: string | null;
    mobilePhone: string | null;
    active: boolean | null;
    sourceLocationId: string | null;
    syncedAt: string;
  };

  type LocationOption = { id: string; name: string | null };
  type SyncState = { resource: string; lastSyncedAt: string | null; lastSuccessAt: string | null; lastError: string | null; rowCount: number | null };
  type SyncRun = { id: string; resource: string; status: string; startedAt: string; completedAt: string | null; rowsWritten: number | null; rowsSeen: number | null; error: string | null; notes: string | null };

  const select = {
    ...({} as any),
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid var(--ck-border-subtle)',
    borderRadius: '10px',
    padding: '0.5rem 0.6rem',
    color: 'var(--ck-text-primary)',
    fontSize: '0.8rem',
    minWidth: '10rem',
  };

  function Stylists(props: any) {
    const teamId = typeof props?.teamId === 'string' && props.teamId.trim() ? props.teamId.trim() : null;
    const [rows, setRows] = useState([] as Row[]);
    const [locations, setLocations] = useState([] as LocationOption[]);
    const [searchInput, setSearchInput] = useState('');
    const [search, setSearch] = useState('');
    const [locationId, setLocationId] = useState('');
    const [activeFilter, setActiveFilter] = useState('all');
    const [syncState, setSyncState] = useState(null as SyncState | null);
    const [latestRun, setLatestRun] = useState(null as SyncRun | null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null as string | null);

    const displayName = (row: Row) => row.fullName || [row.givenName, row.surname].filter(Boolean).join(' ').trim() || 'Unnamed stylist';

    const locationName = (id: string | null) => {
      if (!id) return '—';
      const match = locations.find((loc: LocationOption) => String(loc.id) === String(id));
      return match?.name || id;
    };

    const load = async () => {
      if (!teamId) return;
      setLoading(true);
      setError(null);
      try {
        const query: string[] = ['limit=200'];
        if (search) query.push(`search=${encodeURIComponent(search)}`);
        if (locationId) query.push(`locationId=${encodeURIComponent(locationId)}`);
        if (activeFilter === 'active') query.push('active=true');
        else if (activeFilter === 'inactive') query.push('active=false');

        const [stylistsRes, locationsRes, healthRes, runsRes] = await Promise.all([
          api('yot', teamId, `/stylists?${query.join('&')}`) as Promise<{ data: Row[] }>,
          api('yot', teamId, '/locations?limit=500') as Promise<{ data: LocationOption[] }>,
          api('yot', teamId, '/health') as Promise<{ syncState: SyncState[] }>,
          api('yot', teamId, '/sync-runs?limit=50') as Promise<{ data: SyncRun[] }>,
        ]);

        setRows(Array.isArray(stylistsRes?.data) ? stylistsRes.data : []);
        setLocations(Array.isArray(locationsRes?.data) ? locationsRes.data : []);
        const stateRows = Array.isArray(healthRes?.syncState) ? healthRes.syncState : [];
        setSyncState(stateRows.find((row: SyncState) => row.resource === 'stylists') || null);
        const runs = Array.isArray(runsRes?.data) ? runsRes.data : [];
        setLatestRun(runs.find((row: SyncRun) => row.resource === 'stylists') || null);
      } catch (e: any) {
        setError(e?.message || 'Failed to load stylists');
      } finally {
        setLoading(false);
      }
    };

    useEffect(() => { if (teamId) void load(); else setLoading(false); }, [teamId, search, locationId, activeFilter]);

    if (!teamId) {
      return h('div', { style: t.card },
        h('div', { className: 'text-sm font-medium', style: t.text }, 'Stylists Cache'),
        h('div', { className: 'mt-2 text-sm', style: t.danger }, 'No team context was provided to the YOT Stylists tab.'),
        h('div', { className: 'mt-2 text-xs', style: t.faint }, 'Open this plugin from a specific team so it can query the correct yot-<team>.db cache instead of silently falling back to an empty default database.')
      );
    }

    const freshness = describeFreshness(syncState || {});

    return h('div', { className: 'space-y-3' },
      h('div', { style: t.card },
        h('div', { className: 'flex items-start justify-between gap-2' },
          h('div', null,
            h('div', { className: 'text-sm font-medium', style: t.text }, 'Stylists Cache'),
            h('div', { className: 'mt-1 text-xs', style: t.faint }, 'Cached stylists/staff records, with sync status when the table is still empty.')
          ),
          h('button', { type: 'button', onClick: () => void load(), style: t.btnGhost, disabled: loading }, loading ? 'Loading…' : '↻ Refresh')
        ),
        error && h('div', { className: 'mt-3 text-xs', style: t.danger }, error),
        h('div', { className: 'mt-3', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem' } },
          h('div', { style: { ...t.card, padding: '0.75rem' } },
            h('div', { className: 'text-xs', style: t.faint }, 'Freshness'),
            h('div', { className: 'mt-2' }, h('span', { style: t.badge(freshness.color) }, freshness.label)),
            h('div', { className: 'mt-2 text-xs', style: t.faint }, freshness.detail)
          ),
          h('div', { style: { ...t.card, padding: '0.75rem' } },
            h('div', { className: 'text-xs', style: t.faint }, 'Cached rows'),
            h('div', { className: 'mt-1 text-sm font-medium', style: t.text }, fieldValue(syncState?.rowCount))
          ),
          h('div', { style: { ...t.card, padding: '0.75rem' } },
            h('div', { className: 'text-xs', style: t.faint }, 'Latest run'),
            latestRun
              ? h('div', null,
                  h('div', { className: 'mt-1 text-sm font-medium', style: t.text }, `${latestRun.status} • ${formatRelativeTime(latestRun.startedAt)}`),
                  h('div', { className: 'mt-1 text-xs', style: latestRun.error ? t.danger : t.faint }, latestRun.error || latestRun.notes || `${fieldValue(latestRun.rowsWritten)} written / ${fieldValue(latestRun.rowsSeen)} seen`)
                )
              : h('div', { className: 'mt-1 text-sm', style: t.faint }, 'No stylist sync runs recorded yet.')
          )
        ),
        h('div', { className: 'mt-3 flex gap-2' },
          h('input', {
            value: searchInput,
            onChange: (e: any) => setSearchInput(e.target.value),
            onKeyDown: (e: any) => { if (e.key === 'Enter') setSearch(searchInput); },
            placeholder: 'Search stylist name, email, phone, or private ID',
            style: t.input,
          }),
          h('button', { type: 'button', onClick: () => setSearch(searchInput), style: t.btnPrimary }, 'Search'),
          searchInput || search
            ? h('button', { type: 'button', onClick: () => { setSearchInput(''); setSearch(''); }, style: t.btnGhost }, 'Clear')
            : null
        ),
        h('div', { className: 'mt-3', style: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' } },
          h('select', {
            value: locationId,
            onChange: (e: any) => setLocationId(e.target.value),
            style: select,
          },
            h('option', { value: '' }, 'All locations'),
            ...locations.map((loc: LocationOption) => h('option', { key: loc.id, value: String(loc.id) }, loc.name || `Location ${loc.id}`))
          ),
          h('select', {
            value: activeFilter,
            onChange: (e: any) => setActiveFilter(e.target.value),
            style: select,
          },
            h('option', { value: 'all' }, 'Active & inactive'),
            h('option', { value: 'active' }, 'Active only'),
            h('option', { value: 'inactive' }, 'Inactive only')
          )
        )
      ),
      h('div', { style: t.card },
        rows.length
          ? h('div', { style: t.tableWrap },
              h('table', { style: t.table },
                h('thead', null, h('tr', null,
                  h('th', { style: t.th }, 'Stylist'),
                  h('th', { style: t.th }, 'Location'),
                  h('th', { style: t.th }, 'Contact'),
                  h('th', { style: t.th }, 'Active'),
                  h('th', { style: t.th }, 'Synced')
                )),
                h('tbody', null,
                  ...rows.map((row: Row) => h('tr', { key: row.id },
                    h('td', { style: t.td },
                      h('div', { className: 'text-sm font-medium', style: t.text }, displayName(row)),
                      h('div', { className: 'text-xs', style: t.faint }, row.privateId || row.id)
                    ),
                    h('td', { style: t.td }, locationName(row.locationId || row.sourceLocationId)),
                    h('td', { style: t.td },
                      h('div', null, row.emailAddress || '—'),
                      h('div', { className: 'text-xs', style: t.faint }, row.mobilePhone || '—')
                    ),
                    h('td', { style: t.td }, boolLabel(row.active, 'Active', 'Inactive')),
                    h('td', { style: t.td }, formatDateTime(row.syncedAt))
                  ))
                )
              )
            )
          : h('div', null,
              h('div', { className: 'text-sm font-medium', style: t.text }, loading ? 'Loading stylists…' : 'No cached stylists found.'),
              h('div', { className: 'mt-2 text-sm', style: t.faint }, 'That may simply mean stylist syncing is not wired yet or no stylist rows have been written into this cache.'),
              syncState
                ? h('div', { className: 'mt-3 text-xs', style: freshness.tone === 'error' ? t.danger : t.faint }, `Status: ${freshness.label}. ${freshness.detail}`)
                : null,
              latestRun
                ? h('div', { className: 'mt-2 text-xs', style: latestRun.error ? t.danger : t.faint }, `Latest run ${formatRelativeTime(latestRun.startedAt)} (${formatDateTime(latestRun.startedAt)}): ${latestRun.error || latestRun.notes || latestRun.status}`)
                : null
            )
      )
    );
  }

  (window as any).KitchenPlugin.registerTab('yot', 'stylists', Stylists);
})();
