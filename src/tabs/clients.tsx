import { api, boolLabel, fieldValue, fmtNumber, formatDateTime, joinAddress, modal, t, useEscapeToClose } from './common';

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
    lastVisitAt: string | null;
    totalVisits: number | null;
    totalSpend: number | null;
    syncedAt: string;
  };

  type Detail = Row & {
    privateId: string | null;
    birthday: string | null;
    gender: string | null;
    street: string | null;
    suburb: string | null;
    state: string | null;
    postcode: string | null;
    tags: string[];
    address: string | null;
    createdAtRemote: string | null;
    raw: unknown | null;
  };

  type LocationOption = { id: string; name: string | null };
  type SortField = 'fullName' | 'lastVisitAt' | 'totalVisits' | 'totalSpend' | 'syncedAt';
  type SortDirection = 'asc' | 'desc';

  const PAGE_SIZES = [25, 50, 100, 200];
  const RECENCY_OPTIONS: Array<{ value: string; label: string }> = [
    { value: 'all', label: 'Any last visit' },
    { value: '30', label: 'Visited in last 30 days' },
    { value: '90', label: 'Visited in last 90 days' },
    { value: '365', label: 'Visited in last 365 days' },
    { value: 'never', label: 'Never visited' },
  ];

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

  const daysAgoIso = (days: number): string => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString();
  };

  function Clients(props: any) {
    const teamId = typeof props?.teamId === 'string' && props.teamId.trim() ? props.teamId.trim() : null;
    const [rows, setRows] = useState([] as Row[]);
    const [locations, setLocations] = useState([] as LocationOption[]);
    const [searchInput, setSearchInput] = useState('');
    const [search, setSearch] = useState('');
    const [locationId, setLocationId] = useState('');
    const [activeFilter, setActiveFilter] = useState('all');
    const [recency, setRecency] = useState('all');
    const [sortField, setSortField] = useState('syncedAt' as SortField);
    const [sortDirection, setSortDirection] = useState('desc' as SortDirection);
    const [offset, setOffset] = useState(0);
    const [total, setTotal] = useState(0);
    const [limit, setLimit] = useState(25);
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

    const displayName = (row: Row | Detail) => {
      const fallback = [row.firstName, row.otherName, row.lastName].filter(Boolean).join(' ').trim();
      return row.fullName || fallback || 'Unnamed';
    };

    const phoneLines = (row: Row | Detail) => {
      const entries = [
        row.phone,
        row.mobilePhone && row.mobilePhone !== row.phone ? `Mobile: ${row.mobilePhone}` : null,
        row.homePhone && row.homePhone !== row.phone ? `Home: ${row.homePhone}` : null,
        row.businessPhone && row.businessPhone !== row.phone ? `Business: ${row.businessPhone}` : null,
      ].filter(Boolean) as string[];
      return entries.length ? entries : ['—'];
    };

    const locationNameById = (id: string | null): string => {
      if (!id) return 'Unavailable in current client cache';
      const match = locations.find((loc: LocationOption) => String(loc.id) === String(id));
      return match?.name || id;
    };

    const fmtSpend = (value: number | null): string => {
      if (value == null || Number.isNaN(value)) return '—';
      try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value);
      } catch {
        return `$${value.toFixed(2)}`;
      }
    };

    const buildQuery = (params: {
      nextOffset: number;
      nextLimit: number;
      nextSearch: string;
      nextLocation: string;
      nextActive: string;
      nextRecency: string;
      nextSort: SortField;
      nextDirection: SortDirection;
    }): string => {
      const qs: string[] = [];
      qs.push(`limit=${params.nextLimit}`);
      qs.push(`offset=${params.nextOffset}`);
      if (params.nextSearch) qs.push(`search=${encodeURIComponent(params.nextSearch)}`);
      if (params.nextLocation) qs.push(`locationId=${encodeURIComponent(params.nextLocation)}`);
      if (params.nextActive === 'active') qs.push('active=true');
      else if (params.nextActive === 'inactive') qs.push('active=false');
      if (params.nextRecency === 'never') {
        qs.push('lastVisitNever=1');
      } else if (params.nextRecency !== 'all') {
        const days = parseInt(params.nextRecency, 10);
        if (!Number.isNaN(days) && days > 0) qs.push(`lastVisitAfter=${encodeURIComponent(daysAgoIso(days))}`);
      }
      qs.push(`sort=${encodeURIComponent(params.nextSort)}`);
      qs.push(`direction=${params.nextDirection}`);
      return qs.join('&');
    };

    const load = async (overrides?: Partial<{
      nextOffset: number;
      nextLimit: number;
      nextSearch: string;
      nextLocation: string;
      nextActive: string;
      nextRecency: string;
      nextSort: SortField;
      nextDirection: SortDirection;
    }>) => {
      if (!teamId) return;
      const params = {
        nextOffset: overrides?.nextOffset ?? offset,
        nextLimit: overrides?.nextLimit ?? limit,
        nextSearch: overrides?.nextSearch ?? search,
        nextLocation: overrides?.nextLocation ?? locationId,
        nextActive: overrides?.nextActive ?? activeFilter,
        nextRecency: overrides?.nextRecency ?? recency,
        nextSort: overrides?.nextSort ?? sortField,
        nextDirection: overrides?.nextDirection ?? sortDirection,
      };
      setLoading(true);
      setError(null);
      try {
        const data = await api('yot', teamId, `/clients?${buildQuery(params)}`) as { data: Row[]; total: number; limit: number; offset: number };
        setRows(Array.isArray(data?.data) ? data.data : []);
        setTotal(Number(data?.total || 0));
        setOffset(Number(data?.offset || 0));
      } catch (e: any) {
        setError(e?.message || 'Failed to load clients');
      } finally {
        setLoading(false);
      }
    };

    const loadLocations = async () => {
      if (!teamId) return;
      try {
        const data = await api('yot', teamId, '/locations?limit=500') as { data: LocationOption[] };
        const list = Array.isArray(data?.data) ? data.data : [];
        list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
        setLocations(list);
      } catch {
        setLocations([]);
      }
    };

    const openDetail = async (id: string) => {
      if (!teamId) return;
      setSelectedId(id);
      setDetail(null);
      setDetailError(null);
      setDetailLoading(true);
      try {
        const data = await api('yot', teamId, `/clients/${encodeURIComponent(id)}`) as Detail;
        setDetail(data);
      } catch (e: any) {
        setDetailError(e?.message || 'Failed to load client details');
      } finally {
        setDetailLoading(false);
      }
    };

    useEffect(() => {
      if (teamId) {
        void loadLocations();
        void load({ nextOffset: 0 });
      } else {
        setLoading(false);
      }
    }, [teamId]);

    const applyFilters = (patch: Partial<{
      nextSearch: string;
      nextLocation: string;
      nextActive: string;
      nextRecency: string;
      nextSort: SortField;
      nextDirection: SortDirection;
      nextLimit: number;
    }>) => {
      void load({ ...patch, nextOffset: 0 });
    };

    const onHeaderClick = (field: SortField) => {
      if (field === sortField) {
        const nextDirection: SortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
        setSortDirection(nextDirection);
        applyFilters({ nextSort: field, nextDirection });
      } else {
        const nextDirection: SortDirection = field === 'fullName' ? 'asc' : 'desc';
        setSortField(field);
        setSortDirection(nextDirection);
        applyFilters({ nextSort: field, nextDirection });
      }
    };

    const sortArrow = (field: SortField): string => {
      if (field !== sortField) return '';
      return sortDirection === 'asc' ? ' ▲' : ' ▼';
    };

    const sortableTh = (field: SortField, label: string) =>
      h('th', {
        style: { ...t.th, cursor: 'pointer', userSelect: 'none' as const },
        onClick: () => onHeaderClick(field),
        title: 'Click to sort',
      }, `${label}${sortArrow(field)}`);

    const detailField = (label: string, value: any, valueStyle?: any) =>
      h('div', { key: label, style: noteCard },
        h('div', { style: detailLabel }, label),
        h('div', { style: { ...detailValue, ...(valueStyle || {}) } }, value)
      );

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
            h('div', { className: 'mt-1 text-xs', style: t.faint }, 'Search, filter, sort, and open richer client detail from the local cache.')
          ),
          h('button', { type: 'button', onClick: () => void load(), style: t.btnGhost, disabled: loading }, loading ? 'Loading…' : '↻ Refresh')
        ),
        error && h('div', { className: 'mt-3 text-xs', style: t.danger }, error),
        h('div', { className: 'mt-3 flex gap-2' },
          h('input', {
            value: searchInput,
            onChange: (e: any) => setSearchInput(e.target.value),
            onKeyDown: (e: any) => {
              if (e.key === 'Enter') {
                setSearch(searchInput);
                applyFilters({ nextSearch: searchInput });
              }
            },
            placeholder: 'Search name, email, or phone (press Enter)',
            style: t.input,
          }),
          h('button', {
            type: 'button',
            onClick: () => { setSearch(searchInput); applyFilters({ nextSearch: searchInput }); },
            style: t.btnPrimary,
          }, 'Search'),
          searchInput || search
            ? h('button', {
                type: 'button',
                onClick: () => { setSearchInput(''); setSearch(''); applyFilters({ nextSearch: '' }); },
                style: t.btnGhost,
              }, 'Clear')
            : null
        ),
        h('div', { className: 'mt-3', style: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' } },
          h('select', {
            value: locationId,
            onChange: (e: any) => { const v = e.target.value; setLocationId(v); applyFilters({ nextLocation: v }); },
            style: select,
            title: 'Filter by source location',
          },
            h('option', { value: '' }, 'All locations'),
            ...locations.map((loc: LocationOption) => h('option', { key: loc.id, value: String(loc.id) }, loc.name || `Location ${loc.id}`))
          ),
          h('select', {
            value: activeFilter,
            onChange: (e: any) => { const v = e.target.value; setActiveFilter(v); applyFilters({ nextActive: v }); },
            style: select,
            title: 'Filter by active status',
          },
            h('option', { value: 'all' }, 'Active & inactive'),
            h('option', { value: 'active' }, 'Active only'),
            h('option', { value: 'inactive' }, 'Inactive only')
          ),
          h('select', {
            value: recency,
            onChange: (e: any) => { const v = e.target.value; setRecency(v); applyFilters({ nextRecency: v }); },
            style: select,
            title: 'Filter by last-visit recency',
          },
            ...RECENCY_OPTIONS.map((opt) => h('option', { key: opt.value, value: opt.value }, opt.label))
          ),
          h('select', {
            value: String(limit),
            onChange: (e: any) => { const v = parseInt(e.target.value, 10) || 25; setLimit(v); applyFilters({ nextLimit: v }); },
            style: { ...select, minWidth: '8rem' },
            title: 'Rows per page',
          },
            ...PAGE_SIZES.map((size) => h('option', { key: size, value: String(size) }, `${size} / page`))
          )
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
              sortableTh('fullName', 'Client'),
              h('th', { style: t.th }, 'Contact'),
              h('th', { style: t.th }, 'Location'),
              sortableTh('lastVisitAt', 'Last visit'),
              sortableTh('totalVisits', 'Visits'),
              sortableTh('totalSpend', 'Spend'),
              sortableTh('syncedAt', 'Synced'),
              h('th', { style: t.th }, 'Active'),
              h('th', { style: t.th }, 'Details')
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
                  h('td', { style: t.td }, row.sourceLocationId ? locationNameById(row.sourceLocationId) : 'Unavailable in current client cache'),
                  h('td', { style: t.td }, row.lastVisitAt ? formatDateTime(row.lastVisitAt) : 'Unavailable in current client cache'),
                  h('td', { style: t.td }, fmtNumber(row.totalVisits)),
                  h('td', { style: t.td }, fmtSpend(row.totalSpend)),
                  h('td', { style: t.td }, formatDateTime(row.syncedAt)),
                  h('td', { style: t.td }, boolLabel(row.active, 'Active', 'Inactive')),
                  h('td', { style: t.td },
                    h('button', { type: 'button', style: t.btnGhost, onClick: () => void openDetail(row.id) }, 'View')
                  )
                ))
                : h('tr', null, h('td', { style: t.td, colSpan: 9 }, loading ? 'Loading clients…' : 'No cached clients found.'))
            )
          )
        ),
        h('div', { className: 'mt-3 flex items-center justify-between gap-2' },
          h('button', {
            type: 'button',
            style: t.btnGhost,
            disabled: loading || offset <= 0,
            onClick: () => void load({ nextOffset: Math.max(0, offset - limit) }),
          }, '← Previous'),
          h('div', { className: 'text-xs', style: t.faint }, `${rows.length ? `${offset + 1}-${offset + rows.length}` : 0} of ${fmtNumber(total)}`),
          h('button', {
            type: 'button',
            style: t.btnGhost,
            disabled: loading || offset + limit >= total,
            onClick: () => void load({ nextOffset: offset + limit }),
          }, 'Next →')
        )
      ),
      selectedId && modal(h, {
        title: detail ? displayName(detail) : 'Client details',
        subtitle: selectedId,
        onClose: () => {
          setSelectedId(null);
          setDetail(null);
          setDetailError(null);
        },
        width: '64rem',
        children: detailLoading
          ? h('div', { style: t.faint }, 'Loading client details…')
          : detailError
            ? h('div', { style: t.danger }, detailError)
            : detail
              ? h('div', { className: 'space-y-4' },
                  h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' } },
                    detailField('Full name', displayName(detail)),
                    detailField('Private ID', fieldValue(detail.privateId)),
                    detailField('Status', boolLabel(detail.active, 'Active', 'Inactive')),
                    detailField('Birthday', fieldValue(detail.birthday)),
                    detailField('Gender', fieldValue(detail.gender)),
                    detailField('Created remotely', fieldValue(detail.createdAtRemote ? formatDateTime(detail.createdAtRemote) : null)),
                    detailField('Synced', formatDateTime(detail.syncedAt)),
                    detailField('Last visit', detail.lastVisitAt ? formatDateTime(detail.lastVisitAt) : 'Unavailable in current client cache'),
                    detailField('Source location', detail.sourceLocationId ? locationNameById(detail.sourceLocationId) : 'Unavailable in current client cache'),
                    detailField('Visits', fmtNumber(detail.totalVisits)),
                    detailField('Spend', fmtSpend(detail.totalSpend)),
                    detailField('Tags', detail.tags?.length ? detail.tags.join(', ') : '—')
                  ),
                  h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem' } },
                    detailField('Primary email', fieldValue(detail.email)),
                    detailField('Primary phone', fieldValue(detail.phone)),
                    detailField('Mobile phone', fieldValue(detail.mobilePhone)),
                    detailField('Home phone', fieldValue(detail.homePhone)),
                    detailField('Business phone', fieldValue(detail.businessPhone)),
                    detailField('Address', fieldValue(detail.address || joinAddress([detail.street, detail.suburb, detail.state, detail.postcode, detail.country])))
                  ),
                  h('div', { style: { ...noteCard, borderColor: 'rgba(251,191,36,0.35)' } },
                    h('div', { className: 'text-xs font-medium', style: t.warning }, 'Cache note'),
                    h('div', { className: 'mt-2 text-sm', style: t.text }, 'Location and last-visit fields are shown when present, but the current YOT client cache is often missing them. Blank values here usually mean the source payload did not include that data yet.')
                  ),
                  h('div', { style: noteCard },
                    h('div', { style: detailLabel }, 'Raw record'),
                    h('pre', { style: { ...detailValue, margin: 0, whiteSpace: 'pre-wrap' as const, fontSize: '0.78rem' } }, JSON.stringify(detail.raw, null, 2) || 'null')
                  )
                )
              : h('div', { style: t.faint }, 'No client details loaded.')
      })
    );
  }

  (window as any).KitchenPlugin.registerTab('yot', 'clients', Clients);
})();
