import { api, boolLabel, formatDateTime, t } from './common';

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
    emailAddress: string | null;
    active: boolean | null;
    syncedAt: string;
  };

  function Locations(props: any) {
    const teamId = typeof props?.teamId === 'string' && props.teamId.trim() ? props.teamId.trim() : null;
    const [rows, setRows] = useState([] as Row[]);
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null as string | null);

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
            h('div', { className: 'mt-1 text-xs', style: t.faint }, 'Search the locally cached YOT locations table.')
          ),
          h('button', { type: 'button', onClick: () => void load(), style: t.btnGhost, disabled: loading }, loading ? 'Loading…' : '↻ Refresh')
        ),
        error && h('div', { className: 'mt-3 text-xs', style: t.danger }, error),
        h('div', { className: 'mt-3 flex gap-2' },
          h('input', {
            value: search,
            onChange: (e: any) => setSearch(e.target.value),
            onKeyDown: (e: any) => {
              if (e.key === 'Enter') void load();
            },
            placeholder: 'Search by name, suburb, phone, or email',
            style: t.input,
          }),
          h('button', { type: 'button', onClick: () => void load(), style: t.btnPrimary }, 'Search')
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
              h('th', { style: t.th }, 'Synced')
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
                    h('div', null, row.businessPhone || '—'),
                    h('div', { className: 'text-xs', style: t.faint }, row.emailAddress || '—')
                  ),
                  h('td', { style: t.td }, boolLabel(row.active, 'Active', 'Inactive')),
                  h('td', { style: t.td }, formatDateTime(row.syncedAt))
                ))
                : h('tr', null, h('td', { style: t.td, colSpan: 5 }, loading ? 'Loading locations…' : 'No cached locations found.'))
            )
          )
        )
      )
    );
  }

  (window as any).KitchenPlugin.registerTab('yot', 'locations', Locations);
})();
