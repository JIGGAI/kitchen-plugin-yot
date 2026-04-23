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
    email: string | null;
    phone: string | null;
    sourceLocationId: string | null;
    active: boolean | null;
    totalVisits: number | null;
    totalSpend: number | null;
    lastVisitAt: string | null;
    syncedAt: string;
  };

  function Clients(props: any) {
    const teamId = String(props?.teamId || 'default');
    const [rows, setRows] = useState([] as Row[]);
    const [searchInput, setSearchInput] = useState('');
    const [search, setSearch] = useState('');
    const [offset, setOffset] = useState(0);
    const [total, setTotal] = useState(0);
    const [limit] = useState(25);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null as string | null);

    const load = async (nextOffset = offset, nextSearch = search) => {
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

    useEffect(() => { void load(0, search); }, [teamId]);

    const page = Math.floor(offset / limit) + 1;
    const totalPages = Math.max(1, Math.ceil(total / limit));

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
              h('th', { style: t.th }, 'Location'),
              h('th', { style: t.th }, 'Visits'),
              h('th', { style: t.th }, 'Spend'),
              h('th', { style: t.th }, 'Last visit'),
              h('th', { style: t.th }, 'Active')
            )),
            h('tbody', null,
              rows.length
                ? rows.map((row: Row) => h('tr', { key: row.id },
                  h('td', { style: t.td },
                    h('div', { className: 'text-sm font-medium', style: t.text }, row.fullName || 'Unnamed'),
                    h('div', { className: 'text-xs', style: t.faint }, row.id)
                  ),
                  h('td', { style: t.td },
                    h('div', null, row.email || '—'),
                    h('div', { className: 'text-xs', style: t.faint }, row.phone || '—')
                  ),
                  h('td', { style: t.td }, row.sourceLocationId || '—'),
                  h('td', { style: t.td }, fmtNumber(row.totalVisits)),
                  h('td', { style: t.td }, row.totalSpend == null ? '—' : `$${Number(row.totalSpend).toFixed(2)}`),
                  h('td', { style: t.td },
                    h('div', null, formatDateTime(row.lastVisitAt)),
                    h('div', { className: 'text-xs', style: t.faint }, `Synced ${formatDateTime(row.syncedAt)}`)
                  ),
                  h('td', { style: t.td }, boolLabel(row.active, 'Active', 'Inactive'))
                ))
                : h('tr', null, h('td', { style: t.td, colSpan: 7 }, loading ? 'Loading clients…' : 'No cached clients found.'))
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
