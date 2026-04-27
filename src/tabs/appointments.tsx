import { api, boolLabel, fieldValue, fmtNumber, formatDateTime, loadCacheMeta, modal, readLinkedViewParams, renderCacheSummaryCards, t, useEscapeToClose } from './common';

(function () {
  const R = (window as any).React;
  if (!R) return;
  const h = R.createElement;
  const useEffect = R.useEffect as typeof R.useEffect;
  const useMemo = R.useMemo as typeof R.useMemo;
  const useState = R.useState as (initial: any) => [any, (value: any) => void];

  type Row = {
    id: string;
    appointmentId: string | null;
    internalId: string | null;
    locationId: string | null;
    locationName: string | null;
    clientId: string | null;
    clientName: string | null;
    clientPhone: string | null;
    staffId: string | null;
    stylistId: string | null;
    stylistName: string | null;
    serviceId: string | null;
    serviceName: string | null;
    serviceNameRaw: string | null;
    serviceCategoryName: string | null;
    startsAt: string | null;
    endsAt: string | null;
    durationMinutes: number | null;
    status: string | null;
    statusCode: string | null;
    statusDescription: string | null;
    categoryId: string | null;
    categoryName: string | null;
    descriptionText: string | null;
    clientNotes: string | null;
    total: number | null;
    createdAtRemote: string | null;
    updatedAtRemote: string | null;
    syncedAt: string;
  };

  type Detail = Row & {
    serviceNameNorm: string | null;
    descriptionHtml: string | null;
    referrer: string | null;
    promotionCode: string | null;
    arrivalNote: string | null;
    reminderSent: boolean | null;
    cancelledFlag: boolean | null;
    onlineBooking: boolean | null;
    newClient: boolean | null;
    isClass: boolean | null;
    processingLength: number | null;
    grossAmount: number | null;
    discountAmount: number | null;
    netAmount: number | null;
    createdBy: string | null;
    updatedBy: string | null;
    raw: unknown | null;
  };

  type LocationOption = { id: string; name: string | null };

  const PAGE_SIZES = [25, 50, 100];

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

  const toDateStart = (value: string) => value ? `${value}T00:00:00` : '';
  const toDateEnd = (value: string) => value ? `${value}T23:59:59` : '';

  function Appointments(props: any) {
    const incoming = readLinkedViewParams(props);
    const teamId = typeof props?.teamId === 'string' && props.teamId.trim() ? props.teamId.trim() : (incoming.teamId || null);
    const [rows, setRows] = useState([] as Row[]);
    const [locations, setLocations] = useState([] as LocationOption[]);
    const [searchInput, setSearchInput] = useState(incoming.search || incoming.appointmentId || incoming.clientId || incoming.stylistId || '');
    const [search, setSearch] = useState(incoming.search || '');
    const [locationId, setLocationId] = useState(incoming.locationId || '');
    const [stylistId, setStylistId] = useState(incoming.stylistId || '');
    const [clientId, setClientId] = useState(incoming.clientId || '');
    const [appointmentId, setAppointmentId] = useState(incoming.appointmentId || '');
    const [statusFilter, setStatusFilter] = useState(incoming.status || '');
    const [startDate, setStartDate] = useState(incoming.startDate || '');
    const [endDate, setEndDate] = useState(incoming.endDate || '');
    const [offset, setOffset] = useState(0);
    const [total, setTotal] = useState(0);
    const [limit, setLimit] = useState(25);
    const [syncState, setSyncState] = useState(null as any);
    const [latestRun, setLatestRun] = useState(null as any);
    const [totalRows, setTotalRows] = useState(null as number | null);
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
    const fmtCurrency = (value: number | null | undefined) => {
      if (value == null || Number.isNaN(value)) return '—';
      try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value);
      } catch {
        return `$${value.toFixed(2)}`;
      }
    };

    const statusBadge = (row: Pick<Row, 'statusCode' | 'status' | 'statusDescription'>) => {
      const normalized = String(row.statusCode || row.status || '').toLowerCase();
      const color = normalized.includes('cancel') || normalized.includes('no show')
        ? 'rgba(248,113,113,0.72)'
        : normalized.includes('book')
          ? 'rgba(59,130,246,0.72)'
          : 'rgba(74,222,128,0.72)';
      return h('span', { style: t.badge(color) }, row.statusDescription || row.status || row.statusCode || 'Unknown');
    };

    const detailField = (label: string, value: any, valueStyle?: any) =>
      h('div', { key: label, style: noteCard },
        h('div', { style: detailLabel }, label),
        h('div', { style: { ...detailValue, ...(valueStyle || {}) } }, value)
      );

    const buildQuery = (params: {
      nextOffset: number;
      nextLimit: number;
      nextSearch: string;
      nextLocationId: string;
      nextStylistId: string;
      nextClientId: string;
      nextAppointmentId: string;
      nextStatus: string;
      nextStartDate: string;
      nextEndDate: string;
    }) => {
      const qs: string[] = [
        `limit=${params.nextLimit}`,
        `offset=${params.nextOffset}`,
      ];
      if (params.nextSearch) qs.push(`search=${encodeURIComponent(params.nextSearch)}`);
      if (params.nextLocationId) qs.push(`locationId=${encodeURIComponent(params.nextLocationId)}`);
      if (params.nextStylistId) qs.push(`stylistId=${encodeURIComponent(params.nextStylistId)}`);
      if (params.nextClientId) qs.push(`clientId=${encodeURIComponent(params.nextClientId)}`);
      if (params.nextAppointmentId) qs.push(`appointmentId=${encodeURIComponent(params.nextAppointmentId)}`);
      if (params.nextStatus) qs.push(`status=${encodeURIComponent(params.nextStatus)}`);
      if (params.nextStartDate) qs.push(`startsAfter=${encodeURIComponent(toDateStart(params.nextStartDate))}`);
      if (params.nextEndDate) qs.push(`startsBefore=${encodeURIComponent(toDateEnd(params.nextEndDate))}`);
      return qs.join('&');
    };

    const load = async (overrides?: Partial<{
      nextOffset: number;
      nextLimit: number;
      nextSearch: string;
      nextLocationId: string;
      nextStylistId: string;
      nextClientId: string;
      nextAppointmentId: string;
      nextStatus: string;
      nextStartDate: string;
      nextEndDate: string;
    }>) => {
      if (!teamId) return;
      const params = {
        nextOffset: overrides?.nextOffset ?? offset,
        nextLimit: overrides?.nextLimit ?? limit,
        nextSearch: overrides?.nextSearch ?? search,
        nextLocationId: overrides?.nextLocationId ?? locationId,
        nextStylistId: overrides?.nextStylistId ?? stylistId,
        nextClientId: overrides?.nextClientId ?? clientId,
        nextAppointmentId: overrides?.nextAppointmentId ?? appointmentId,
        nextStatus: overrides?.nextStatus ?? statusFilter,
        nextStartDate: overrides?.nextStartDate ?? startDate,
        nextEndDate: overrides?.nextEndDate ?? endDate,
      };
      setLoading(true);
      setError(null);
      try {
        const [appointmentsRes, locationsRes, meta] = await Promise.all([
          api('yot', teamId, `/appointments?${buildQuery(params)}`) as Promise<{ data: Row[]; total: number; limit: number; offset: number }>,
          api('yot', teamId, '/locations?limit=500') as Promise<{ data: LocationOption[] }>,
          loadCacheMeta(teamId, 'appointments'),
        ]);
        setRows(Array.isArray(appointmentsRes?.data) ? appointmentsRes.data : []);
        setTotal(Number(appointmentsRes?.total || 0));
        setOffset(Number(appointmentsRes?.offset || 0));
        setLocations(Array.isArray(locationsRes?.data) ? locationsRes.data : []);
        setSyncState(meta.syncState);
        setLatestRun(meta.latestRun);
        setTotalRows(meta.totalRows);
      } catch (e: any) {
        setError(e?.message || 'Failed to load appointments');
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
        const data = await api('yot', teamId, `/appointments/${encodeURIComponent(id)}`) as Detail;
        setDetail(data);
      } catch (e: any) {
        setDetailError(e?.message || 'Failed to load appointment details');
      } finally {
        setDetailLoading(false);
      }
    };

    useEffect(() => {
      if (teamId) void load({ nextOffset: 0 });
      else setLoading(false);
    }, [teamId]);

    const applyFilters = (patch: Partial<{
      nextSearch: string;
      nextLocationId: string;
      nextStylistId: string;
      nextClientId: string;
      nextAppointmentId: string;
      nextStatus: string;
      nextStartDate: string;
      nextEndDate: string;
      nextLimit: number;
    }>) => {
      void load({ ...patch, nextOffset: 0 });
    };

    const statusOptions = useMemo(() => {
      const seen = new Map<string, string>();
      for (const row of rows) {
        const key = row.statusCode || row.status || '';
        const label = row.statusDescription || row.status || row.statusCode || '';
        if (key && label && !seen.has(key)) seen.set(key, label);
      }
      return Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1]));
    }, [rows]);

    const page = Math.floor(offset / limit) + 1;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    if (!teamId) {
      return h('div', { style: t.card },
        h('div', { className: 'text-sm font-medium', style: t.text }, 'Appointments Cache'),
        h('div', { className: 'mt-2 text-sm', style: t.danger }, 'No team context was provided to the YOT Appointments tab.'),
        h('div', { className: 'mt-2 text-xs', style: t.faint }, 'Open this plugin from a specific team so it can query the correct yot-<team>.db cache instead of silently falling back to an empty default database.')
      );
    }

    return h('div', { className: 'space-y-3' },
      h('div', { style: t.card },
        h('div', { className: 'flex items-start justify-between gap-2' },
          h('div', null,
            h('div', { className: 'text-sm font-medium', style: t.text }, 'Appointments Cache'),
            h('div', { className: 'mt-1 text-xs', style: t.faint }, 'Browse cached appointment records with local detail fallback while the live YOT appointment detail endpoint remains broken on this tenant.')
          ),
          h('button', { type: 'button', onClick: () => void load(), style: t.btnGhost, disabled: loading }, loading ? 'Loading…' : '↻ Refresh')
        ),
        error && h('div', { className: 'mt-3 text-xs', style: t.danger }, error),
        renderCacheSummaryCards(h, { syncState, latestRun, totalRows, emptyLatestRunText: 'No appointment sync runs recorded yet.' }),
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
            placeholder: 'Search appointment ID, client, stylist, service, notes',
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
            onChange: (e: any) => { const v = e.target.value; setLocationId(v); applyFilters({ nextLocationId: v }); },
            style: select,
            title: 'Filter by location',
          },
            h('option', { value: '' }, 'All locations'),
            ...locations.map((loc: LocationOption) => h('option', { key: loc.id, value: String(loc.id) }, loc.name || `Location ${loc.id}`))
          ),
          h('select', {
            value: statusFilter,
            onChange: (e: any) => { const v = e.target.value; setStatusFilter(v); applyFilters({ nextStatus: v }); },
            style: select,
            title: 'Filter by status',
          },
            h('option', { value: '' }, 'All statuses'),
            ...statusOptions.map((entry: [string, string]) => {
              const [value, label] = entry;
              return h('option', { key: value, value }, label);
            })
          ),
          h('input', {
            type: 'date',
            value: startDate,
            onChange: (e: any) => { const v = e.target.value; setStartDate(v); applyFilters({ nextStartDate: v }); },
            style: { ...select, minWidth: '9rem' },
            title: 'Start date',
          }),
          h('input', {
            type: 'date',
            value: endDate,
            onChange: (e: any) => { const v = e.target.value; setEndDate(v); applyFilters({ nextEndDate: v }); },
            style: { ...select, minWidth: '9rem' },
            title: 'End date',
          }),
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
          h('div', null, `${fmtNumber(total)} total appointments`),
          h('div', null, `Page ${fmtNumber(page)} / ${fmtNumber(totalPages)}`)
        )
      ),
      h('div', { style: t.card },
        h('div', { style: t.tableWrap },
          h('table', { style: t.table },
            h('thead', null, h('tr', null,
              h('th', { style: t.th }, 'Starts'),
              h('th', { style: t.th }, 'Client'),
              h('th', { style: t.th }, 'Service'),
              h('th', { style: t.th }, 'Stylist'),
              h('th', { style: t.th }, 'Location'),
              h('th', { style: t.th }, 'Status'),
              h('th', { style: t.th }, 'Duration'),
              h('th', { style: t.th }, 'Details')
            )),
            h('tbody', null,
              rows.length
                ? rows.map((row: Row) => h('tr', { key: row.id },
                    h('td', { style: t.td },
                      h('div', { className: 'text-sm font-medium', style: t.text }, formatDateTime(row.startsAt)),
                      h('div', { className: 'text-xs', style: t.faint }, row.endsAt ? `Ends ${formatDateTime(row.endsAt)}` : 'No end time')
                    ),
                    h('td', { style: t.td },
                      h('div', { className: 'text-sm font-medium', style: t.text }, row.clientName || 'Unnamed client'),
                      h('div', { className: 'text-xs', style: t.faint }, row.clientPhone || row.clientId || 'No linked client')
                    ),
                    h('td', { style: t.td },
                      h('div', { className: 'text-sm font-medium', style: t.text }, row.serviceName || row.serviceNameRaw || 'Unknown service'),
                      h('div', { className: 'text-xs', style: t.faint }, row.categoryName || row.serviceCategoryName || row.serviceId || '—')
                    ),
                    h('td', { style: t.td },
                      h('div', null, row.stylistName || 'Unknown stylist'),
                      h('div', { className: 'text-xs', style: t.faint }, row.stylistId || row.staffId || '—')
                    ),
                    h('td', { style: t.td }, row.locationName || row.locationId || '—'),
                    h('td', { style: t.td }, statusBadge(row)),
                    h('td', { style: t.td }, fmtDuration(row.durationMinutes)),
                    h('td', { style: t.td },
                      h('button', { type: 'button', style: t.btnGhost, onClick: () => void openDetail(row.id) }, 'View')
                    )
                  ))
                : h('tr', null, h('td', { style: t.td, colSpan: 8 }, loading ? 'Loading appointments…' : 'No cached appointments found.'))
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
        title: detail?.clientName || detail?.serviceName || 'Appointment details',
        subtitle: detail?.appointmentId || selectedId,
        onClose: () => {
          setSelectedId(null);
          setDetail(null);
          setDetailError(null);
        },
        width: '64rem',
        children: detailLoading
          ? h('div', { style: t.faint }, 'Loading appointment details…')
          : detailError
            ? h('div', { style: t.danger }, detailError)
            : detail
              ? h('div', { className: 'space-y-4' },
                  h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' } },
                    detailField('Appointment ID', fieldValue(detail.appointmentId)),
                    detailField('Internal ID', fieldValue(detail.internalId)),
                    detailField('Status', statusBadge(detail)),
                    detailField('Category', fieldValue(detail.categoryName || detail.serviceCategoryName || detail.categoryId)),
                    detailField('Starts', detail.startsAt ? formatDateTime(detail.startsAt) : '—'),
                    detailField('Ends', detail.endsAt ? formatDateTime(detail.endsAt) : '—'),
                    detailField('Duration', fmtDuration(detail.durationMinutes)),
                    detailField('Created remotely', detail.createdAtRemote ? formatDateTime(detail.createdAtRemote) : '—'),
                    detailField('Updated remotely', detail.updatedAtRemote ? formatDateTime(detail.updatedAtRemote) : '—'),
                    detailField('Synced', formatDateTime(detail.syncedAt))
                  ),
                  h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem' } },
                    detailField('Location', fieldValue(detail.locationName || detail.locationId)),
                    detailField('Stylist', fieldValue(detail.stylistName || detail.stylistId || detail.staffId)),
                    detailField('Client', fieldValue(detail.clientName || detail.clientId)),
                    detailField('Client phone', fieldValue(detail.clientPhone)),
                    detailField('Service', fieldValue(detail.serviceName || detail.serviceNameRaw || detail.serviceId)),
                    detailField('Service key', fieldValue(detail.serviceId || detail.serviceNameNorm))
                  ),
                  h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem' } },
                    detailField('Client notes', fieldValue(detail.clientNotes), { whiteSpace: 'pre-wrap' as const }),
                    detailField('Description', fieldValue(detail.descriptionText), { whiteSpace: 'pre-wrap' as const }),
                    detailField('Arrival note', fieldValue(detail.arrivalNote), { whiteSpace: 'pre-wrap' as const }),
                    detailField('Referrer / promo', [detail.referrer, detail.promotionCode].filter(Boolean).join(' / ') || '—'),
                    detailField('Created by', fieldValue(detail.createdBy)),
                    detailField('Updated by', fieldValue(detail.updatedBy))
                  ),
                  h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' } },
                    detailField('Reminder sent', boolLabel(detail.reminderSent)),
                    detailField('Cancelled flag', boolLabel(detail.cancelledFlag)),
                    detailField('Online booking', boolLabel(detail.onlineBooking)),
                    detailField('New client', boolLabel(detail.newClient)),
                    detailField('Class booking', boolLabel(detail.isClass)),
                    detailField('Processing length', detail.processingLength == null ? '—' : `${detail.processingLength} min`),
                    detailField('Total', fmtCurrency(detail.total)),
                    detailField('Gross', fmtCurrency(detail.grossAmount)),
                    detailField('Discount', fmtCurrency(detail.discountAmount)),
                    detailField('Net', fmtCurrency(detail.netAmount))
                  ),
                  h('div', { style: noteCard },
                    h('div', { style: detailLabel }, 'Raw record'),
                    h('pre', { style: { ...detailValue, margin: 0, whiteSpace: 'pre-wrap' as const, fontSize: '0.78rem' } }, JSON.stringify(detail.raw, null, 2) || 'null')
                  )
                )
              : h('div', { style: t.faint }, 'No appointment details loaded.')
      })
    );
  }

  (window as any).KitchenPlugin.registerTab('yot', 'appointments', Appointments);
})();
