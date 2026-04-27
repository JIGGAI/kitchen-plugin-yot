import { api, boolLabel, detectRevenueDatePreset, fmtNumber, formatDateTime, joinAddress, loadCacheMeta, readLinkedViewParams, renderCacheSummaryCards, resolveRevenueDatePreset, REVENUE_DATE_PRESET_OPTIONS, t } from './common';

(function () {
  const R = (window as any).React;
  if (!R) return;
  const h = R.createElement;
  const useEffect = R.useEffect as typeof R.useEffect;
  const useState = R.useState as (initial: any) => [any, (value: any) => void];

  type LocationRow = { id: string; name: string | null };
  type RevenueTotals = {
    grossAmount: number;
    discountAmount: number;
    netAmount: number;
    appointmentCount: number;
    uniqueClientCount: number;
    rowCount: number;
    locationCount: number;
    lastUpdatedAt: string | null;
  };
  type RevenuePeriodRow = {
    periodKey: string;
    periodStart: string;
    periodEnd: string;
    label: string;
    grossAmount: number;
    discountAmount: number;
    netAmount: number;
    appointmentCount: number;
    uniqueClientCount: number;
    locationCount: number;
    dayCount: number;
    lastUpdatedAt: string | null;
  };
  type RevenueLocationRow = {
    locationId: string;
    locationName: string | null;
    grossAmount: number;
    discountAmount: number;
    netAmount: number;
    appointmentCount: number;
    uniqueClientCount: number;
    dayCount: number;
    lastUpdatedAt: string | null;
  };
  type RevenueResponse = {
    grain: 'day' | 'week' | 'month';
    locationId: string | null;
    startDate: string | null;
    endDate: string | null;
    availableRange: { minDate: string | null; maxDate: string | null };
    totals: RevenueTotals;
    byPeriod: RevenuePeriodRow[];
    byLocation: RevenueLocationRow[];
  };
  type LocationDetail = { id: string; name: string | null; suburb: string | null; state: string | null; postcode: string | null; street: string | null; country: string | null; active: boolean | null; syncedAt: string };

  const noteCard = { background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '10px', padding: '0.75rem' };
  const detailLabel = { fontSize: '0.72rem', color: 'var(--ck-text-tertiary)', textTransform: 'uppercase' as const, letterSpacing: '0.04em' };
  const detailValue = { marginTop: '0.2rem', color: 'var(--ck-text-primary)', fontSize: '0.9rem', lineHeight: 1.4, wordBreak: 'break-word' as const };

  function Revenue(props: any) {
    const incoming = readLinkedViewParams(props);
    const teamId = typeof props?.teamId === 'string' && props.teamId.trim() ? props.teamId.trim() : (incoming.teamId || null);
    const incomingHasRange = Boolean(incoming.startDate && incoming.endDate);
    const defaultRange = incomingHasRange
      ? { startDate: incoming.startDate, endDate: incoming.endDate }
      : (resolveRevenueDatePreset('this-week') || { startDate: '', endDate: '' });
    const defaultPreset = incomingHasRange ? detectRevenueDatePreset(defaultRange.startDate, defaultRange.endDate) : 'this-week';
    const [locations, setLocations] = useState([] as LocationRow[]);
    const [data, setData] = useState(null as RevenueResponse | null);
    const [grain, setGrain] = useState('day' as 'day' | 'week' | 'month');
    const [locationId, setLocationId] = useState(incoming.locationId || '');
    const [preset, setPreset] = useState(defaultPreset);
    const [startDateInput, setStartDateInput] = useState(defaultRange.startDate);
    const [endDateInput, setEndDateInput] = useState(defaultRange.endDate);
    const [startDate, setStartDate] = useState(defaultRange.startDate);
    const [endDate, setEndDate] = useState(defaultRange.endDate);
    const [syncState, setSyncState] = useState(null as any);
    const [latestRun, setLatestRun] = useState(null as any);
    const [linkedLocation, setLinkedLocation] = useState(null as LocationDetail | null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(null as string | null);
    const [message, setMessage] = useState(null as string | null);
    const [error, setError] = useState(null as string | null);

    const fmtCurrency = (value: number | null | undefined) => {
      if (value == null || Number.isNaN(value)) return '—';
      try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value); } catch { return `$${value.toFixed(2)}`; }
    };

    const statCard = (label: string, value: any, subtext?: string | null) => h('div', { key: label, style: noteCard }, h('div', { style: detailLabel }, label), h('div', { style: { ...detailValue, fontSize: '1rem', fontWeight: 700 } }, value), subtext ? h('div', { className: 'mt-1 text-xs', style: t.faint }, subtext) : null);

    const loadLocations = async () => {
      if (!teamId) return;
      try {
        const res = await api('yot', teamId, '/locations?limit=200') as { data: LocationRow[] };
        const rows = Array.isArray(res?.data) ? res.data : [];
        setLocations(rows.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id))));
      } catch {}
    };

    const loadMeta = async () => {
      if (!teamId) return;
      try {
        const meta = await loadCacheMeta(teamId, 'revenue_facts');
        setSyncState(meta.syncState);
        setLatestRun(meta.latestRun);
      } catch {}
    };

    const load = async () => {
      if (!teamId) return;
      setLoading(true);
      setError(null);
      try {
        const params = [
          `grain=${encodeURIComponent(grain)}`,
          locationId ? `locationId=${encodeURIComponent(locationId)}` : '',
          startDate ? `startDate=${encodeURIComponent(startDate)}` : '',
          endDate ? `endDate=${encodeURIComponent(endDate)}` : '',
        ].filter(Boolean).join('&');
        const res = await api('yot', teamId, `/revenue${params ? `?${params}` : ''}`) as RevenueResponse;
        setData(res);
      } catch (e: any) {
        setError(e?.message || 'Failed to load revenue');
      } finally {
        setLoading(false);
      }
    };

    const refreshAll = async () => {
      await Promise.all([loadLocations(), loadMeta(), load()]);
    };

    const runSync = async (key: string, label: string, path: string) => {
      if (!teamId) return;
      setBusy(key);
      setMessage(null);
      setError(null);
      try {
        const res = await api('yot', teamId, path, { method: 'POST', headers: { 'content-type': 'application/json' } }) as any;
        setMessage(`${label} complete • ${fmtNumber(res?.rowsWritten)} rows written across ${fmtNumber(res?.matchedLocationCount)} locations`);
        await Promise.all([loadMeta(), load()]);
      } catch (e: any) {
        setError(e?.message || `Failed to ${label.toLowerCase()}`);
      } finally {
        setBusy(null);
      }
    };

    const onPresetChange = (value: string) => {
      setPreset(value as any);
      if (value === 'custom') return;
      const range = resolveRevenueDatePreset(value as any);
      if (!range) return;
      setStartDateInput(range.startDate);
      setEndDateInput(range.endDate);
      setStartDate(range.startDate);
      setEndDate(range.endDate);
    };

    const openLinkedLocation = async (id: string) => {
      if (!teamId) return;
      setLinkedLocation(await api('yot', teamId, `/locations/${encodeURIComponent(id)}`) as LocationDetail);
    };

    useEffect(() => { if (teamId) { void refreshAll(); } else setLoading(false); }, [teamId, grain, locationId, startDate, endDate]);

    if (!teamId) return h('div', { style: t.card }, h('div', { className: 'text-sm font-medium', style: t.text }, 'Revenue'), h('div', { className: 'mt-2 text-sm', style: t.danger }, 'No team context was provided to the YOT Revenue tab.'));

    return h('div', { className: 'space-y-3' },
      h('div', { style: t.card },
        h('div', { className: 'flex items-start justify-between gap-2' },
          h('div', null,
            h('div', { className: 'text-sm font-medium', style: t.text }, 'Revenue'),
            h('div', { className: 'mt-1 text-xs', style: t.faint }, 'Daily, weekly, monthly, and location rollups from cached YOT revenue facts.')
          ),
          h('button', { type: 'button', onClick: () => void refreshAll(), style: t.btnGhost, disabled: loading || !!busy }, loading ? 'Loading…' : '↻ Refresh')
        ),
        error && h('div', { className: 'mt-3 text-xs', style: t.danger }, error),
        message && h('div', { className: 'mt-3 text-xs', style: t.success }, message),
        renderCacheSummaryCards(h, { syncState, latestRun, emptyLatestRunText: 'No revenue sync runs recorded yet.' }),
        h('div', { className: 'mt-3', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' } },
          h('label', { style: { ...detailLabel, display: 'block' } }, 'Grain', h('select', { value: grain, onChange: (e: any) => setGrain(e.target.value), style: { ...t.input, marginTop: '0.35rem' } }, h('option', { value: 'day' }, 'Day'), h('option', { value: 'week' }, 'Week'), h('option', { value: 'month' }, 'Month'))),
          h('label', { style: { ...detailLabel, display: 'block' } }, 'Preset', h('select', { value: preset, onChange: (e: any) => onPresetChange(e.target.value), style: { ...t.input, marginTop: '0.35rem' } }, ...REVENUE_DATE_PRESET_OPTIONS.map((option) => h('option', { key: option.value, value: option.value }, option.label)))),
          h('label', { style: { ...detailLabel, display: 'block' } }, 'Location', h('select', { value: locationId, onChange: (e: any) => setLocationId(e.target.value), style: { ...t.input, marginTop: '0.35rem' } }, h('option', { value: '' }, 'All locations'), ...locations.map((row: LocationRow) => h('option', { key: row.id, value: row.id }, row.name || row.id)))),
          h('label', { style: { ...detailLabel, display: 'block' } }, 'Start date', h('input', { type: 'date', value: startDateInput, onChange: (e: any) => { setPreset('custom'); setStartDateInput(e.target.value); }, style: { ...t.input, marginTop: '0.35rem' } })),
          h('label', { style: { ...detailLabel, display: 'block' } }, 'End date', h('input', { type: 'date', value: endDateInput, onChange: (e: any) => { setPreset('custom'); setEndDateInput(e.target.value); }, style: { ...t.input, marginTop: '0.35rem' } }))
        ),
        h('div', { className: 'mt-3 flex flex-wrap gap-2' },
          h('button', { type: 'button', style: t.btnPrimary, onClick: () => { setStartDate(startDateInput); setEndDate(endDateInput); } }, 'Apply filters'),
          h('button', { type: 'button', style: t.btnGhost, onClick: () => { const range = resolveRevenueDatePreset('this-week') || { startDate: '', endDate: '' }; setPreset('this-week'); setLocationId(''); setStartDateInput(range.startDate); setEndDateInput(range.endDate); setStartDate(range.startDate); setEndDate(range.endDate); setLinkedLocation(null); } }, 'Reset'),
          h('button', { type: 'button', style: t.btnGhost, disabled: !!busy, onClick: () => void runSync('yesterday', 'Revenue sync (yesterday)', '/revenue/sync?days=1') }, busy === 'yesterday' ? 'Syncing…' : 'Sync yesterday')
        ),
        data?.availableRange?.minDate || data?.availableRange?.maxDate ? h('div', { className: 'mt-3 text-xs', style: t.faint }, `Available cache window: ${data?.availableRange?.minDate || '—'} → ${data?.availableRange?.maxDate || '—'}`) : null
      ),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' } },
        statCard('Gross sales', fmtCurrency(data?.totals?.grossAmount ?? null), data?.startDate && data?.endDate ? `${data.startDate} → ${data.endDate}` : null),
        statCard('Net sales', fmtCurrency(data?.totals?.netAmount ?? null), data?.totals?.lastUpdatedAt ? `Updated ${formatDateTime(data.totals.lastUpdatedAt)}` : null),
        statCard('Discounts', fmtCurrency(data?.totals?.discountAmount ?? null)),
        statCard('Appointments', fmtNumber(data?.totals?.appointmentCount)),
        statCard('Locations', fmtNumber(data?.totals?.locationCount)),
        statCard('Revenue rows', fmtNumber(data?.totals?.rowCount))
      ),
      h('div', { style: t.card },
        h('div', { className: 'text-sm font-medium mb-3', style: t.text }, `By ${grain}`),
        h('div', { style: t.tableWrap },
          h('table', { style: t.table },
            h('thead', null, h('tr', null,
              h('th', { style: t.th }, grain === 'day' ? 'Day' : grain === 'week' ? 'Week' : 'Month'),
              h('th', { style: t.th }, 'Gross'),
              h('th', { style: t.th }, 'Net'),
              h('th', { style: t.th }, 'Discounts'),
              h('th', { style: t.th }, 'Appointments'),
              h('th', { style: t.th }, 'Locations'),
              h('th', { style: t.th }, 'Last updated')
            )),
            h('tbody', null,
              data?.byPeriod?.length
                ? data.byPeriod.map((row: RevenuePeriodRow) => h('tr', { key: row.periodKey },
                    h('td', { style: t.td }, h('div', { className: 'text-sm font-medium', style: t.text }, row.label), grain !== 'day' ? h('div', { className: 'text-xs', style: t.faint }, `${row.periodStart} → ${row.periodEnd}`) : null),
                    h('td', { style: t.td }, fmtCurrency(row.grossAmount)),
                    h('td', { style: t.td }, fmtCurrency(row.netAmount)),
                    h('td', { style: t.td }, fmtCurrency(row.discountAmount)),
                    h('td', { style: t.td }, fmtNumber(row.appointmentCount)),
                    h('td', { style: t.td }, fmtNumber(row.locationCount)),
                    h('td', { style: t.td }, formatDateTime(row.lastUpdatedAt))
                  ))
                : h('tr', null, h('td', { style: t.td, colSpan: 7 }, loading ? 'Loading revenue…' : 'No revenue facts found for this filter.'))
            )
          )
        )
      ),
      h('div', { style: t.card },
        h('div', { className: 'text-sm font-medium mb-3', style: t.text }, 'By location'),
        h('div', { style: t.tableWrap },
          h('table', { style: t.table },
            h('thead', null, h('tr', null,
              h('th', { style: t.th }, 'Location'),
              h('th', { style: t.th }, 'Gross'),
              h('th', { style: t.th }, 'Net'),
              h('th', { style: t.th }, 'Discounts'),
              h('th', { style: t.th }, 'Appointments'),
              h('th', { style: t.th }, 'Days'),
              h('th', { style: t.th }, 'Last updated')
            )),
            h('tbody', null,
              data?.byLocation?.length
                ? data.byLocation.map((row: RevenueLocationRow) => h('tr', { key: row.locationId },
                    h('td', { style: t.td }, h('div', { className: 'text-sm font-medium', style: t.text }, row.locationName || row.locationId), h('div', { className: 'text-xs', style: t.faint }, row.locationId), h('div', { className: 'mt-2' }, h('button', { type: 'button', style: { ...t.btnGhost, padding: '0.35rem 0.55rem' }, onClick: () => void openLinkedLocation(row.locationId) }, 'Open location'))),
                    h('td', { style: t.td }, fmtCurrency(row.grossAmount)),
                    h('td', { style: t.td }, fmtCurrency(row.netAmount)),
                    h('td', { style: t.td }, fmtCurrency(row.discountAmount)),
                    h('td', { style: t.td }, fmtNumber(row.appointmentCount)),
                    h('td', { style: t.td }, fmtNumber(row.dayCount)),
                    h('td', { style: t.td }, formatDateTime(row.lastUpdatedAt))
                  ))
                : h('tr', null, h('td', { style: t.td, colSpan: 7 }, loading ? 'Loading revenue…' : 'No location rollups found for this filter.'))
            )
          )
        ),
        linkedLocation ? h('div', { className: 'mt-3', style: { ...noteCard, borderColor: 'rgba(255,255,255,0.14)' } },
          h('div', { style: detailLabel }, 'Linked location preview'),
          h('div', { style: detailValue },
            h('div', { className: 'text-sm font-medium', style: t.text }, linkedLocation.name || linkedLocation.id),
            h('div', { className: 'mt-1 text-xs', style: t.faint }, joinAddress([linkedLocation.street, linkedLocation.suburb, linkedLocation.state, linkedLocation.postcode, linkedLocation.country])),
            h('div', { className: 'mt-1 text-xs', style: t.faint }, `${boolLabel(linkedLocation.active, 'Active', 'Inactive')} • synced ${formatDateTime(linkedLocation.syncedAt)}`)
          )
        ) : null
      )
    );
  }

  (window as any).KitchenPlugin.registerTab('yot', 'revenue', Revenue);
})();
