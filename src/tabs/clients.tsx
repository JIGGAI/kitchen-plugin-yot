import { api, boolLabel, fmtNumber, formatDateTime, t } from './common';

(function () {
  const R = (window as any).React;
  if (!R) return;
  const h = R.createElement;
  const useEffect = R.useEffect as typeof R.useEffect;
  const useState = R.useState as (initial: any) => [any, (value: any) => void];

  type Row = {
    id: string;
    fullName: string | null;
    firstName: string | null;
    otherName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    homePhone: string | null;
    mobilePhone: string | null;
    businessPhone: string | null;
    sourceLocationId: string | null;
    country: string | null;
    active: boolean | null;
    syncedAt: string;
  };

  function Clients(props: any) {
    const teamId = typeof props?.teamId === 'string' && props.teamId.trim() ? props.teamId.trim() : null;
    const [rows, setRows] = useState([] as Row[]);
    const [searchInput, setSearchInput] = useState('');
    const [search, setSearch] = useState('');
    const [offset, setOffset] = useState(0);
    const [total, setTotal] = useState(0);
    const [limit] = useState(25);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null as string | null);

    const displayName = (row: Row) => {
      const fallback = [row.firstName, row.otherName, row.lastName].filter(Boolean).join(' ').trim();
      return row.fullName || fallback || 'Unnamed';
    };

    const phoneLines = (row: Row) => {
      const entries = [
        row.phone,
        row.mobilePhone && row.mobilePhone !== row.phone ? `Mobile: ${row.mobilePhone}` : null,
        row.homePhone && row.homePhone !== row.phone ? `Home: ${row.homePhone}` : null,
        row.businessPhone && row.businessPhone !== row.phone ? `Business: ${row.businessPhone}` : null,
      ].filter(Boolean) as string[];
      return entries.length ? entries : ['—'];
    };

    const load = async (nextOffset = offset, nextSearch = search) => {
      if (!teamId) return;
      setLoading(true);
      setError(null);
      try {
        const data = await api(
          'yot',
          teamId,
          `/clients?limit=${limit}&offset=${nextOffset}${nextSearch ? `&search=${encodeURIComponent(nextSearch)}` : ''}`
        ) as { data: Row[]; total: number; limit: number; offset: number };
        setRows(Array.isArray(data?.data) ? data.data : []);
        setTotal(Number(data?.total || 0));
        setOffset(Number(data?.offset || 0));
      } catch (e: any) {
        setError(e?.message || 'Failed to load clients');
      } finally {
        setLoading(false);
      }
    };

    useEffect(() => { if (teamId) void load(0, search); else setLoading(false); }, [teamId]);

    const page = Math.floor(offset / limit) + 1;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    if (!teamId) {
      return h('div', { style: t.card },
        h('div', { className: 'text-sm font-medium', style: t.text }, 'Clients Cache'),
        h('div', { className: 'mt-2 text-sm', style: t.danger }, 'No team context was provided to the YOT Clients tab.'),
        h('div', { className: 'mt-2 text-xs', style: t.faint }, 'Open this plugin from a specific team so it can query the correct yot-<team>.db cache instead of silently falling back to an empty default database.')
      );
    }

    return h('div', { className: 'space-y-3' },
      h('div', { style: t.card },
        h('div', { className: 'flex items-start justify-between gap-2' },
          h('div', null,
            h('div', { className: 'text-sm font-medium', style: t.text }, 'Clients Cache'),
            h('div', { className: 'mt-1 text-xs', style: t.faint }, 'Search and page through cached YOT clients.')
          ),
          h('button', { type: 'button', onClick: () => void load(offset, search), style: t.btnGhost, disabled: loading }, loading ? 'Loading…' : '↻ Refresh')
        ),
        error && h('div', { className: 'mt-3 text-xs', style: t.danger }, error),
        h('div', { className: 'mt-3 flex gap-2' },
          h('input', {
            value: searchInput,
            onChange: (e: any) => setSearchInput(e.target.value),
            onKeyDown: (e: any) => {
              if (e.key === 'Enter') {
                setSearch(searchInput);
                void load(0, searchInput);
              }
            },
            placeholder: 'Search name, email, or phone',
            style: t.input,
          }),
          h('button', {
            type: 'button',
            onClick: () => { setSearch(searchInput); void load(0, searchInput); },
            style: t.btnPrimary,
          }, 'Search')
        ),
        h('div', { className: 'mt-3 flex items-center justify-between text-xs', style: t.faint },
          h('div', null, `${fmtNumber(total)} total clients`),
          h('div', null, `Page ${fmtNumber(page)} / ${fmtNumber(totalPages)}`)
        )
      ),
      h('div', { style: t.card },
        h('div', { style: t.tableWrap },
          h('table', { style: t.table },
            h('thead', null, h('tr', null,
              h('th', { style: t.th }, 'Client'),
              h('th', { style: t.th }, 'Contact'),
              h('th', { style: t.th }, 'Country'),
              h('th', { style: t.th }, 'Source location'),
              h('th', { style: t.th }, 'Synced'),
              h('th', { style: t.th }, 'Active')
            )),
            h('tbody', null,
              rows.length
                ? rows.map((row: Row) => h('tr', { key: row.id },
                  h('td', { style: t.td },
                    h('div', { className: 'text-sm font-medium', style: t.text }, displayName(row)),
                    h('div', { className: 'text-xs', style: t.faint }, row.id)
                  ),
                  h('td', { style: t.td },
                    h('div', null, row.email || '—'),
                    ...phoneLines(row).map((line, idx) => h('div', { key: `${row.id}-phone-${idx}`, className: 'text-xs', style: t.faint }, line))
                  ),
                  h('td', { style: t.td }, row.country || '—'),
                  h('td', { style: t.td }, row.sourceLocationId || '—'),
                  h('td', { style: t.td }, formatDateTime(row.syncedAt)),
                  h('td', { style: t.td }, boolLabel(row.active, 'Active', 'Inactive'))
                ))
                : h('tr', null, h('td', { style: t.td, colSpan: 6 }, loading ? 'Loading clients…' : 'No cached clients found.'))
            )
          )
        ),
        h('div', { className: 'mt-3 flex items-center justify-between gap-2' },
          h('button', { type: 'button', style: t.btnGhost, disabled: loading || offset <= 0, onClick: () => void load(Math.max(0, offset - limit), search) }, '← Previous'),
          h('div', { className: 'text-xs', style: t.faint }, `${rows.length ? `${offset + 1}-${offset + rows.length}` : 0} of ${fmtNumber(total)}`),
          h('button', { type: 'button', style: t.btnGhost, disabled: loading || offset + limit >= total, onClick: () => void load(offset + limit, search) }, 'Next →')
        )
      )
    );
  }

  (window as any).KitchenPlugin.registerTab('yot', 'clients', Clients);
})();
