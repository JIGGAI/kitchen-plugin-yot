import { api, boolLabel, fieldValue, formatDateTime, loadCacheMeta, modal, renderCacheSummaryCards, t, useEscapeToClose } from './common';

(function () {
  const R = (window as any).React;
  if (!R) return;
  const h = R.createElement;
  const useEffect = R.useEffect as typeof R.useEffect;
  const useState = R.useState as (initial: any) => [any, (value: any) => void];

  type Row = {
    id: string;
    serviceId: string | null;
    locationId: string | null;
    name: string | null;
    durationMinutes: number | null;
    price: number | null;
    active: boolean | null;
    syncedAt: string;
  };

  type Detail = Row & {
    localId: string | null;
    raw: unknown | null;
  };

  type LocationOption = { id: string; name: string | null };

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

  const noteCard = {
    background: 'rgba(255,255,255,0.02)',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: '10px',
    padding: '0.75rem',
  };

  const detailLabel = {
    fontSize: '0.72rem',
    color: 'var(--ck-text-tertiary)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  };

  const detailValue = {
    marginTop: '0.2rem',
    color: 'var(--ck-text-primary)',
    fontSize: '0.9rem',
    lineHeight: 1.4,
    wordBreak: 'break-word' as const,
  };

  function Services(props: any) {
    const teamId = typeof props?.teamId === 'string' && props.teamId.trim() ? props.teamId.trim() : null;
    const [rows, setRows] = useState([] as Row[]);
    const [locations, setLocations] = useState([] as LocationOption[]);
    const [searchInput, setSearchInput] = useState('');
    const [search, setSearch] = useState('');
    const [locationId, setLocationId] = useState('');
    const [activeFilter, setActiveFilter] = useState('all');
    const [syncState, setSyncState] = useState(null as any);
    const [latestRun, setLatestRun] = useState(null as any);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null as string | null);
    const [selectedId, setSelectedId] = useState(null as string | null);
    const [detail, setDetail] = useState(null as Detail | null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [detailError, setDetailError] = useState(null as string | null);

    useEscapeToClose(R, !!selectedId, () => {
      setSelectedId(null);
      setDetail(null);
      setDetailError(null);
    });

    const fmtDuration = (value: number | null | undefined) => value == null ? '—' : `${value} min`;
    const fmtPrice = (value: number | null | undefined) => {
      if (value == null || Number.isNaN(value)) return '—';
      try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value);
      } catch {
        return `$${value.toFixed(2)}`;
      }
    };

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

        const [servicesRes, locationsRes, meta] = await Promise.all([
          api('yot', teamId, `/services?${query.join('&')}`) as Promise<{ data: Row[] }>,
          api('yot', teamId, '/locations?limit=500') as Promise<{ data: LocationOption[] }>,
          loadCacheMeta(teamId, 'services'),
        ]);

        setRows(Array.isArray(servicesRes?.data) ? servicesRes.data : []);
        setLocations(Array.isArray(locationsRes?.data) ? locationsRes.data : []);
        setSyncState(meta.syncState);
        setLatestRun(meta.latestRun);
      } catch (e: any) {
        setError(e?.message || 'Failed to load services');
      } finally {
        setLoading(false);
      }
    };

    const openDetail = async (id: string) => {
      if (!teamId) return;
      setSelectedId(id);
      setDetail(null);
      setDetailError(null);
      setDetailLoading(true);
      try {
        const data = await api('yot', teamId, `/services/${encodeURIComponent(id)}`) as Detail;
        setDetail(data);
      } catch (e: any) {
        setDetailError(e?.message || 'Failed to load service details');
      } finally {
        setDetailLoading(false);
      }
    };

    const detailField = (label: string, value: any) =>
      h('div', { key: label, style: noteCard },
        h('div', { style: detailLabel }, label),
        h('div', { style: detailValue }, value)
      );

    useEffect(() => { if (teamId) void load(); else setLoading(false); }, [teamId, search, locationId, activeFilter]);

    if (!teamId) {
      return h('div', { style: t.card },
        h('div', { className: 'text-sm font-medium', style: t.text }, 'Services Cache'),
        h('div', { className: 'mt-2 text-sm', style: t.danger }, 'No team context was provided to the YOT Services tab.'),
        h('div', { className: 'mt-2 text-xs', style: t.faint }, 'Open this plugin from a specific team so it can query the correct yot-<team>.db cache instead of silently falling back to an empty default database.')
      );
    }

    return h('div', { className: 'space-y-3' },
      h('div', { style: t.card },
        h('div', { className: 'flex items-start justify-between gap-2' },
          h('div', null,
            h('div', { className: 'text-sm font-medium', style: t.text }, 'Services Cache'),
            h('div', { className: 'mt-1 text-xs', style: t.faint }, 'Browse cached YOT services and open richer service detail from the local cache.')
          ),
          h('button', { type: 'button', onClick: () => void load(), style: t.btnGhost, disabled: loading }, loading ? 'Loading…' : '↻ Refresh')
        ),
        error && h('div', { className: 'mt-3 text-xs', style: t.danger }, error),
        renderCacheSummaryCards(h, { syncState, latestRun, emptyLatestRunText: 'No service sync runs recorded yet.' }),
        h('div', { className: 'mt-3 flex gap-2' },
          h('input', {
            value: searchInput,
            onChange: (e: any) => setSearchInput(e.target.value),
            onKeyDown: (e: any) => { if (e.key === 'Enter') setSearch(searchInput); },
            placeholder: 'Search service name or ID',
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
        h('div', { className: 'text-xs mb-3', style: t.faint }, `${rows.length} cached service${rows.length === 1 ? '' : 's'}`),
        h('div', { style: t.tableWrap },
          h('table', { style: t.table },
            h('thead', null, h('tr', null,
              h('th', { style: t.th }, 'Service'),
              h('th', { style: t.th }, 'Location'),
              h('th', { style: t.th }, 'Duration'),
              h('th', { style: t.th }, 'Price'),
              h('th', { style: t.th }, 'Active'),
              h('th', { style: t.th }, 'Synced'),
              h('th', { style: t.th }, 'Details')
            )),
            h('tbody', null,
              rows.length
                ? rows.map((row: Row) => h('tr', { key: row.id },
                    h('td', { style: t.td },
                      h('div', { className: 'text-sm font-medium', style: t.text }, row.name || 'Unnamed service'),
                      h('div', { className: 'text-xs', style: t.faint }, row.serviceId || row.id)
                    ),
                    h('td', { style: t.td }, locationName(row.locationId)),
                    h('td', { style: t.td }, fmtDuration(row.durationMinutes)),
                    h('td', { style: t.td }, fmtPrice(row.price)),
                    h('td', { style: t.td }, boolLabel(row.active, 'Active', 'Inactive')),
                    h('td', { style: t.td }, formatDateTime(row.syncedAt)),
                    h('td', { style: t.td },
                      h('button', { type: 'button', style: t.btnGhost, onClick: () => void openDetail(row.id) }, 'View')
                    )
                  ))
                : h('tr', null, h('td', { style: t.td, colSpan: 7 }, loading ? 'Loading services…' : 'No cached services found.'))
            )
          )
        )
      ),
      selectedId && modal(h, {
        title: detail?.name || 'Service details',
        subtitle: selectedId,
        onClose: () => {
          setSelectedId(null);
          setDetail(null);
          setDetailError(null);
        },
        width: '58rem',
        children: detailLoading
          ? h('div', { style: t.faint }, 'Loading service details…')
          : detailError
            ? h('div', { style: t.danger }, detailError)
            : detail
              ? h('div', { className: 'space-y-4' },
                  h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' } },
                    detailField('Service name', fieldValue(detail.name)),
                    detailField('Service ID', fieldValue(detail.serviceId)),
                    detailField('Local ID', fieldValue(detail.localId)),
                    detailField('Location', locationName(detail.locationId)),
                    detailField('Duration', fmtDuration(detail.durationMinutes)),
                    detailField('Price', fmtPrice(detail.price)),
                    detailField('Status', boolLabel(detail.active, 'Active', 'Inactive')),
                    detailField('Synced', formatDateTime(detail.syncedAt))
                  ),
                  h('div', { style: noteCard },
                    h('div', { style: detailLabel }, 'Raw record'),
                    h('pre', { style: { ...detailValue, margin: 0, whiteSpace: 'pre-wrap' as const, fontSize: '0.78rem' } }, JSON.stringify(detail.raw, null, 2) || 'null')
                  )
                )
              : h('div', { style: t.faint }, 'No service details loaded.')
      })
    );
  }

  (window as any).KitchenPlugin.registerTab('yot', 'services', Services);
})();
