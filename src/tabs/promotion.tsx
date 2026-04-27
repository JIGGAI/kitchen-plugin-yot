import { api, detectRevenueDatePreset, fmtNumber, formatDateTime, loadCacheMeta, readLinkedViewParams, renderCacheSummaryCards, resolveRevenueDatePreset, REVENUE_DATE_PRESET_OPTIONS, t } from './common';

(function () {
  const R = (window as any).React;
  if (!R) return;
  const h = R.createElement;
  const useEffect = R.useEffect as typeof R.useEffect;
  const useState = R.useState as (initial: any) => [any, (value: any) => void];

  type LocationRow = { id: string; name: string | null };
  type PromotionSummaryRow = {
    promotionId: string;
    promotionName: string | null;
    promotionCode: string | null;
    usageCount: number;
    locationCount: number;
    dayCount: number;
    lastUsedAt: string | null;
  };
  type PromotionResponse = {
    locationId: string | null;
    startDate: string | null;
    endDate: string | null;
    availableRange: { minDate: string | null; maxDate: string | null };
    totals: {
      usageCount: number;
      promotionCount: number;
      locationCount: number;
      dayCount: number;
      rowCount: number;
      lastUpdatedAt: string | null;
    };
    promotions: PromotionSummaryRow[];
    matrixColumns: Array<{
      promotionId: string;
      promotionName: string | null;
      promotionCode: string | null;
    }>;
    matrixRows: Array<{
      rowKey: string;
      date: string;
      locationId: string;
      locationName: string | null;
      totalUsageCount: number;
      promotionCounts: Record<string, number>;
    }>;
  };

  const detailLabel = { fontSize: '0.72rem', color: 'var(--ck-text-tertiary)', textTransform: 'uppercase' as const, letterSpacing: '0.04em' };
  const detailValue = { marginTop: '0.2rem', color: 'var(--ck-text-primary)', fontSize: '0.9rem', lineHeight: 1.4 };
  const presetOptions = REVENUE_DATE_PRESET_OPTIONS.filter((option) => ['today', 'yesterday', 'this-week', 'last-week', 'this-month', 'last-month', 'custom'].includes(option.value));

  function Promotion(props: any) {
    const incoming = readLinkedViewParams(props);
    const teamId = typeof props?.teamId === 'string' && props.teamId.trim() ? props.teamId.trim() : (incoming.teamId || null);
    const incomingHasRange = Boolean(incoming.startDate && incoming.endDate);
    const defaultRange = incomingHasRange
      ? { startDate: incoming.startDate, endDate: incoming.endDate }
      : (resolveRevenueDatePreset('this-month') || { startDate: '', endDate: '' });
    const defaultPreset = incomingHasRange ? detectRevenueDatePreset(defaultRange.startDate, defaultRange.endDate) : 'this-month';
    const [locations, setLocations] = useState([] as LocationRow[]);
    const [data, setData] = useState(null as PromotionResponse | null);
    const [locationId, setLocationId] = useState(incoming.locationId || '');
    const [preset, setPreset] = useState(defaultPreset);
    const [startDateInput, setStartDateInput] = useState(defaultRange.startDate);
    const [endDateInput, setEndDateInput] = useState(defaultRange.endDate);
    const [startDate, setStartDate] = useState(defaultRange.startDate);
    const [endDate, setEndDate] = useState(defaultRange.endDate);
    const [syncState, setSyncState] = useState(null as any);
    const [latestRun, setLatestRun] = useState(null as any);
    const [totalRows, setTotalRows] = useState(null as number | null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(null as string | null);
    const [message, setMessage] = useState(null as string | null);
    const [error, setError] = useState(null as string | null);

    const statCard = (label: string, value: any, subtext?: string | null) => h('div', { key: label, style: { ...t.card, padding: '0.75rem' } },
      h('div', { style: detailLabel }, label),
      h('div', { style: { ...detailValue, fontSize: '1rem', fontWeight: 700 } }, value),
      subtext ? h('div', { className: 'mt-1 text-xs', style: t.faint }, subtext) : null
    );

    const monthlyLocationColumns = (() => {
      const columns = new Map<string, { locationId: string; locationName: string | null }>();
      for (const row of data?.matrixRows || []) {
        if (!row.locationId) continue;
        if (!columns.has(row.locationId)) columns.set(row.locationId, { locationId: row.locationId, locationName: row.locationName || null });
      }
      return Array.from(columns.values()).sort((a, b) => String(a.locationName || a.locationId).localeCompare(String(b.locationName || b.locationId)));
    })();

    const monthlyPromotionRows = (() => {
      const usageByPromotionAndLocation = new Map<string, Map<string, number>>();
      for (const row of data?.matrixRows || []) {
        for (const [promotionId, count] of Object.entries(row.promotionCounts || {})) {
          const byLocation = usageByPromotionAndLocation.get(promotionId) || new Map<string, number>();
          byLocation.set(row.locationId, (byLocation.get(row.locationId) || 0) + Number(count || 0));
          usageByPromotionAndLocation.set(promotionId, byLocation);
        }
      }

      return (data?.promotions || []).map((promotion: PromotionSummaryRow) => {
        const byLocation = usageByPromotionAndLocation.get(promotion.promotionId) || new Map<string, number>();
        const locationCounts = Object.fromEntries(monthlyLocationColumns.map((column) => [column.locationId, byLocation.get(column.locationId) || 0]));
        return {
          ...promotion,
          locationCounts,
        };
      });
    })();

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
        const meta = await loadCacheMeta(teamId, 'promotion_usage');
        setSyncState(meta.syncState);
        setLatestRun(meta.latestRun);
        setTotalRows(meta.totalRows);
      } catch {}
    };

    const load = async () => {
      if (!teamId) return;
      setLoading(true);
      setError(null);
      try {
        const params = [
          locationId ? `locationId=${encodeURIComponent(locationId)}` : '',
          startDate ? `startDate=${encodeURIComponent(startDate)}` : '',
          endDate ? `endDate=${encodeURIComponent(endDate)}` : '',
        ].filter(Boolean).join('&');
        const res = await api('yot', teamId, `/promotion-usage${params ? `?${params}` : ''}`) as PromotionResponse;
        setData(res);
      } catch (e: any) {
        setError(e?.message || 'Failed to load promotion usage');
      } finally {
        setLoading(false);
      }
    };

    const refreshAll = async () => {
      await Promise.all([loadLocations(), loadMeta(), load()]);
    };

    const runSync = async () => {
      if (!teamId || !startDate || !endDate) return;
      setBusy('sync');
      setMessage(null);
      setError(null);
      try {
        const path = `/promotion-usage/sync?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}${locationId ? `&locationId=${encodeURIComponent(locationId)}` : ''}`;
        const res = await api('yot', teamId, path, { method: 'POST', headers: { 'content-type': 'application/json' } }) as any;
        setMessage(`Promotion sync complete • ${fmtNumber(res?.rowsWritten)} rows written across ${fmtNumber(res?.promotionCount)} promotions`);
        await Promise.all([loadMeta(), load()]);
      } catch (e: any) {
        setError(e?.message || 'Failed to sync promotion usage');
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

    useEffect(() => { if (teamId) { void refreshAll(); } else setLoading(false); }, [teamId, locationId, startDate, endDate]);

    if (!teamId) return h('div', { style: t.card }, h('div', { className: 'text-sm font-medium', style: t.text }, 'Promotion'), h('div', { className: 'mt-2 text-sm', style: t.danger }, 'No team context was provided to the YOT Promotion tab.'));

    return h('div', { className: 'space-y-3' },
      h('div', { style: t.card },
        h('div', { className: 'flex items-start justify-between gap-2' },
          h('div', null,
            h('div', { className: 'text-sm font-medium', style: t.text }, 'Promotion'),
            h('div', { className: 'mt-1 text-xs', style: t.faint }, 'Promotion usage from the cached YOT report feed, summarized for month-style location comparisons.')
          ),
          h('button', { type: 'button', onClick: () => void refreshAll(), style: t.btnGhost, disabled: loading || !!busy }, loading ? 'Loading…' : '↻ Refresh')
        ),
        error && h('div', { className: 'mt-3 text-xs', style: t.danger }, error),
        message && h('div', { className: 'mt-3 text-xs', style: t.success }, message),
        renderCacheSummaryCards(h, { syncState, latestRun, totalRows, emptyLatestRunText: 'No promotion sync runs recorded yet.' }),
        h('div', { className: 'mt-3', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' } },
          h('label', { style: { ...detailLabel, display: 'block' } }, 'Preset', h('select', { value: preset, onChange: (e: any) => onPresetChange(e.target.value), style: { ...t.input, marginTop: '0.35rem' } }, ...presetOptions.map((option) => h('option', { key: option.value, value: option.value }, option.label)))),
          h('label', { style: { ...detailLabel, display: 'block' } }, 'Location', h('select', { value: locationId, onChange: (e: any) => setLocationId(e.target.value), style: { ...t.input, marginTop: '0.35rem' } }, h('option', { value: '' }, 'All locations'), ...locations.map((row: LocationRow) => h('option', { key: row.id, value: row.id }, row.name || row.id)))),
          h('label', { style: { ...detailLabel, display: 'block' } }, 'Start date', h('input', { type: 'date', value: startDateInput, onChange: (e: any) => { setPreset('custom'); setStartDateInput(e.target.value); }, style: { ...t.input, marginTop: '0.35rem' } })),
          h('label', { style: { ...detailLabel, display: 'block' } }, 'End date', h('input', { type: 'date', value: endDateInput, onChange: (e: any) => { setPreset('custom'); setEndDateInput(e.target.value); }, style: { ...t.input, marginTop: '0.35rem' } }))
        ),
        h('div', { className: 'mt-3 flex flex-wrap gap-2' },
          h('button', { type: 'button', style: t.btnPrimary, onClick: () => { setStartDate(startDateInput); setEndDate(endDateInput); } }, 'Apply filters'),
          h('button', { type: 'button', style: t.btnGhost, onClick: () => { const range = resolveRevenueDatePreset('this-month') || { startDate: '', endDate: '' }; setPreset('this-month'); setLocationId(''); setStartDateInput(range.startDate); setEndDateInput(range.endDate); setStartDate(range.startDate); setEndDate(range.endDate); } }, 'Reset'),
          h('button', { type: 'button', style: t.btnGhost, disabled: !!busy || !startDate || !endDate, onClick: () => void runSync() }, busy === 'sync' ? 'Syncing…' : 'Sync filtered range')
        ),
        data?.availableRange?.minDate || data?.availableRange?.maxDate ? h('div', { className: 'mt-3 text-xs', style: t.faint }, `Available cache window: ${data?.availableRange?.minDate || '—'} → ${data?.availableRange?.maxDate || '—'}`) : null
      ),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' } },
        statCard('Uses', fmtNumber(data?.totals?.usageCount ?? null), data?.startDate && data?.endDate ? `${data.startDate} → ${data.endDate}` : null),
        statCard('Promotions', fmtNumber(data?.totals?.promotionCount ?? null), data?.totals?.lastUpdatedAt ? `Updated ${formatDateTime(data.totals.lastUpdatedAt)}` : null),
        statCard('Locations', fmtNumber(data?.totals?.locationCount ?? null)),
        statCard('Days', fmtNumber(data?.totals?.dayCount ?? null)),
        statCard('Cached rows', fmtNumber(data?.totals?.rowCount ?? null))
      ),
      h('div', { style: t.card },
        h('div', { className: 'text-sm font-medium mb-3', style: t.text }, 'Unique promotions'),
        h('div', { style: t.tableWrap },
          h('table', { style: t.table },
            h('thead', null, h('tr', null,
              h('th', { style: t.th }, 'Promotion'),
              h('th', { style: t.th }, 'Code'),
              h('th', { style: t.th }, 'Uses'),
              h('th', { style: t.th }, 'Locations'),
              h('th', { style: t.th }, 'Days'),
              h('th', { style: t.th }, 'Last used')
            )),
            h('tbody', null,
              data?.promotions?.length
                ? data.promotions.map((row: PromotionSummaryRow) => h('tr', { key: row.promotionId },
                    h('td', { style: t.td }, h('div', { className: 'text-sm font-medium', style: t.text }, row.promotionName || row.promotionCode || row.promotionId), h('div', { className: 'text-xs', style: t.faint }, row.promotionId)),
                    h('td', { style: t.td }, row.promotionCode || '—'),
                    h('td', { style: t.td }, fmtNumber(row.usageCount)),
                    h('td', { style: t.td }, fmtNumber(row.locationCount)),
                    h('td', { style: t.td }, fmtNumber(row.dayCount)),
                    h('td', { style: t.td }, formatDateTime(row.lastUsedAt))
                  ))
                : h('tr', null, h('td', { style: t.td, colSpan: 6 }, loading ? 'Loading promotions…' : 'No promotion usage found for this filter.'))
            )
          )
        )
      ),
      h('div', { style: t.card },
        h('div', { className: 'text-sm font-medium mb-1', style: t.text }, 'Monthly usage by location'),
        h('div', { className: 'text-xs mb-3', style: t.faint }, 'Rows are promotions. Columns show how many times each promotion was used at each location across the selected date range.'),
        h('div', { style: t.tableWrap },
          h('table', { style: t.table },
            h('thead', null, h('tr', null,
              h('th', { style: t.th }, 'Promotion'),
              h('th', { style: t.th }, 'Code'),
              h('th', { style: t.th }, 'Total uses'),
              ...monthlyLocationColumns.map((column) => h('th', { key: column.locationId, style: t.th }, h('div', { className: 'text-sm font-medium', style: t.text }, column.locationName || column.locationId), h('div', { className: 'text-xs', style: t.faint }, column.locationId)))
            )),
            h('tbody', null,
              monthlyPromotionRows.length
                ? monthlyPromotionRows.map((row: PromotionSummaryRow & { locationCounts: Record<string, number> }) => h('tr', { key: row.promotionId },
                    h('td', { style: t.td }, h('div', { className: 'text-sm font-medium', style: t.text }, row.promotionName || row.promotionCode || row.promotionId), h('div', { className: 'text-xs', style: t.faint }, row.promotionId)),
                    h('td', { style: t.td }, row.promotionCode || '—'),
                    h('td', { style: t.td }, fmtNumber(row.usageCount)),
                    ...monthlyLocationColumns.map((column) => h('td', { key: `${row.promotionId}::${column.locationId}`, style: t.td }, fmtNumber(row.locationCounts[column.locationId] || 0)))
                  ))
                : h('tr', null, h('td', { style: t.td, colSpan: 3 + monthlyLocationColumns.length }, loading ? 'Loading promotion usage…' : 'No promotion usage rows found for this filter.'))
            )
          )
        )
      )
    );
  }

  (window as any).KitchenPlugin.registerTab('yot', 'promotion', Promotion);
})();
