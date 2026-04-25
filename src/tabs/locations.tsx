import { api, boolLabel, fieldValue, formatDateTime, joinAddress, modal, t, useEscapeToClose } from './common';

(function () {
  const R = (window as any).React;
  if (!R) return;
  const h = R.createElement;
  const useEffect = R.useEffect as typeof R.useEffect;
  const useState = R.useState as (initial: any) => [any, (value: any) => void];

  type Row = {
    id: string;
    name: string | null;
    suburb: string | null;
    state: string | null;
    postcode: string | null;
    businessPhone: string | null;
    mobilePhone: string | null;
    emailAddress: string | null;
    active: boolean | null;
    syncedAt: string;
  };

  type Detail = Row & {
    street: string | null;
    country: string | null;
    canBookOnline: boolean | null;
    raw: unknown | null;
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

  function Locations(props: any) {
    const teamId = typeof props?.teamId === 'string' && props.teamId.trim() ? props.teamId.trim() : null;
    const [rows, setRows] = useState([] as Row[]);
    const [searchInput, setSearchInput] = useState('');
    const [search, setSearch] = useState('');
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

    const load = async () => {
      if (!teamId) return;
      setLoading(true);
      setError(null);
      try {
        const data = await api('yot', teamId, `/locations?limit=200${search ? `&search=${encodeURIComponent(search)}` : ''}`) as { data: Row[] };
        setRows(Array.isArray(data?.data) ? data.data : []);
      } catch (e: any) {
        setError(e?.message || 'Failed to load locations');
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
        const data = await api('yot', teamId, `/locations/${encodeURIComponent(id)}`) as Detail;
        setDetail(data);
      } catch (e: any) {
        setDetailError(e?.message || 'Failed to load location details');
      } finally {
        setDetailLoading(false);
      }
    };

    const detailField = (label: string, value: any) =>
      h('div', { key: label, style: noteCard },
        h('div', { style: detailLabel }, label),
        h('div', { style: detailValue }, value)
      );

    useEffect(() => { if (teamId) void load(); else setLoading(false); }, [teamId, search]);

    if (!teamId) {
      return h('div', { style: t.card },
        h('div', { className: 'text-sm font-medium', style: t.text }, 'Locations Cache'),
        h('div', { className: 'mt-2 text-sm', style: t.danger }, 'No team context was provided to the YOT Locations tab.'),
        h('div', { className: 'mt-2 text-xs', style: t.faint }, 'Open this plugin from a specific team so it can query the correct yot-<team>.db cache instead of silently falling back to an empty default database.')
      );
    }

    return h('div', { className: 'space-y-3' },
      h('div', { style: t.card },
        h('div', { className: 'flex items-start justify-between gap-2' },
          h('div', null,
            h('div', { className: 'text-sm font-medium', style: t.text }, 'Locations Cache'),
            h('div', { className: 'mt-1 text-xs', style: t.faint }, 'Search cached YOT locations and open location detail from the local cache.')
          ),
          h('button', { type: 'button', onClick: () => void load(), style: t.btnGhost, disabled: loading }, loading ? 'Loading…' : '↻ Refresh')
        ),
        error && h('div', { className: 'mt-3 text-xs', style: t.danger }, error),
        h('div', { className: 'mt-3 flex gap-2' },
          h('input', {
            value: searchInput,
            onChange: (e: any) => setSearchInput(e.target.value),
            onKeyDown: (e: any) => {
              if (e.key === 'Enter') setSearch(searchInput);
            },
            placeholder: 'Search by name, suburb, phone, or email',
            style: t.input,
          }),
          h('button', { type: 'button', onClick: () => setSearch(searchInput), style: t.btnPrimary }, 'Search'),
          searchInput || search
            ? h('button', { type: 'button', onClick: () => { setSearchInput(''); setSearch(''); }, style: t.btnGhost }, 'Clear')
            : null
        )
      ),
      h('div', { style: t.card },
        h('div', { className: 'text-xs mb-3', style: t.faint }, `${rows.length} cached location${rows.length === 1 ? '' : 's'}`),
        h('div', { style: t.tableWrap },
          h('table', { style: t.table },
            h('thead', null, h('tr', null,
              h('th', { style: t.th }, 'Name'),
              h('th', { style: t.th }, 'Location'),
              h('th', { style: t.th }, 'Contact'),
              h('th', { style: t.th }, 'Active'),
              h('th', { style: t.th }, 'Synced'),
              h('th', { style: t.th }, 'Details')
            )),
            h('tbody', null,
              rows.length
                ? rows.map((row: Row) => h('tr', { key: row.id },
                  h('td', { style: t.td },
                    h('div', { className: 'text-sm font-medium', style: t.text }, row.name || 'Unnamed'),
                    h('div', { className: 'text-xs', style: t.faint }, row.id)
                  ),
                  h('td', { style: t.td }, [row.suburb, row.state, row.postcode].filter(Boolean).join(', ') || '—'),
                  h('td', { style: t.td },
                    h('div', null, row.businessPhone || row.mobilePhone || '—'),
                    h('div', { className: 'text-xs', style: t.faint }, row.emailAddress || '—')
                  ),
                  h('td', { style: t.td }, boolLabel(row.active, 'Active', 'Inactive')),
                  h('td', { style: t.td }, formatDateTime(row.syncedAt)),
                  h('td', { style: t.td },
                    h('button', { type: 'button', style: t.btnGhost, onClick: () => void openDetail(row.id) }, 'View')
                  )
                ))
                : h('tr', null, h('td', { style: t.td, colSpan: 6 }, loading ? 'Loading locations…' : 'No cached locations found.'))
            )
          )
        )
      ),
      selectedId && modal(h, {
        title: detail?.name || 'Location details',
        subtitle: selectedId,
        onClose: () => {
          setSelectedId(null);
          setDetail(null);
          setDetailError(null);
        },
        width: '58rem',
        children: detailLoading
          ? h('div', { style: t.faint }, 'Loading location details…')
          : detailError
            ? h('div', { style: t.danger }, detailError)
            : detail
              ? h('div', { className: 'space-y-4' },
                  h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' } },
                    detailField('Name', fieldValue(detail.name)),
                    detailField('Status', boolLabel(detail.active, 'Active', 'Inactive')),
                    detailField('Can book online', boolLabel(detail.canBookOnline, 'Yes', 'No')),
                    detailField('Business phone', fieldValue(detail.businessPhone)),
                    detailField('Mobile phone', fieldValue(detail.mobilePhone)),
                    detailField('Email', fieldValue(detail.emailAddress)),
                    detailField('Address', joinAddress([detail.street, detail.suburb, detail.state, detail.postcode, detail.country])),
                    detailField('Synced', formatDateTime(detail.syncedAt))
                  ),
                  h('div', { style: noteCard },
                    h('div', { style: detailLabel }, 'Raw record'),
                    h('pre', { style: { ...detailValue, margin: 0, whiteSpace: 'pre-wrap' as const, fontSize: '0.78rem' } }, JSON.stringify(detail.raw, null, 2) || 'null')
                  )
                )
              : h('div', { style: t.faint }, 'No location details loaded.')
      })
    );
  }

  (window as any).KitchenPlugin.registerTab('yot', 'locations', Locations);
})();
