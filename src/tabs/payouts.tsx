import { api, fmtNumber, formatDateTime, loadCacheMeta, renderCacheSummaryCards, t } from './common';

(function () {
  const R = (window as any).React;
  if (!R) return;
  const h = R.createElement;
  const useEffect = R.useEffect as typeof R.useEffect;
  const useState = R.useState as (initial: any) => [any, (value: any) => void];

  type LocationRow = { id: string; name: string | null };
  type PayoutRow = {
    date: string;
    locationName: string;
    staffName: string;
    staffId: string | null;
    bankToBankAmount: number | null;
    originalPayoutAmount: number | null;
    garnishmentPercent: number | null;
    garnishmentAmount: number;
    loanPaymentAmount: number;
    netPayoutAmount: number | null;
    lastUpdatedAt: string;
  };
  type BranchTotalRow = {
    date: string;
    locationName: string;
    branchTotal: number;
    originalPayoutTotal: number;
    garnishmentTotal: number;
    loanPaymentTotal: number;
    stylistCount: number;
    lastUpdatedAt: string | null;
  };
  type PayoutTotals = {
    payoutTotal: number;
    originalPayoutTotal: number;
    garnishmentTotal: number;
    loanPaymentTotal: number;
    rowCount: number;
    dayCount: number;
    branchCount: number;
    stylistCount: number;
    lastUpdatedAt: string | null;
  };
  type PayoutResponse = {
    startDate: string | null;
    endDate: string | null;
    locationName: string | null;
    rows: PayoutRow[];
    locationTotals: BranchTotalRow[];
    totals: PayoutTotals;
    lastSyncedAt: string | null;
  };

  const fmtCurrency = (value: number | null | undefined) => {
    if (value == null || Number.isNaN(value)) return '—';
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value); } catch { return `$${value.toFixed(2)}`; }
  };

  const isoDay = (d: Date) => d.toISOString().slice(0, 10);
  const yesterday = () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return isoDay(d);
  };

  const mostRecentIso = (a: string | null | undefined, b: string | null | undefined) => {
    if (!a) return b || null;
    if (!b) return a || null;
    return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
  };

  const buildGroupedPayouts = (rows: PayoutRow[], locationTotals: BranchTotalRow[]) => {
    const totalsByDateLocation = new Map(locationTotals.map((row) => [`${row.date}::${row.locationName}`, row]));
    const byDate = new Map<string, {
      date: string;
      totalPayout: number;
      originalPayoutTotal: number;
      garnishmentTotal: number;
      loanPaymentTotal: number;
      stylistKeys: Set<string>;
      lastUpdatedAt: string | null;
      locations: Map<string, {
        locationName: string;
        rows: PayoutRow[];
        branchTotal: number | null;
        originalPayoutTotal: number | null;
        garnishmentTotal: number | null;
        loanPaymentTotal: number | null;
        stylistCount: number | null;
        lastUpdatedAt: string | null;
      }>;
    }>();

    for (const row of rows) {
      const dateBucket = byDate.get(row.date) || {
        date: row.date,
        totalPayout: 0,
        originalPayoutTotal: 0,
        garnishmentTotal: 0,
        loanPaymentTotal: 0,
        stylistKeys: new Set<string>(),
        lastUpdatedAt: null,
        locations: new Map(),
      };
      dateBucket.totalPayout += row.netPayoutAmount || 0;
      dateBucket.originalPayoutTotal += row.originalPayoutAmount || 0;
      dateBucket.garnishmentTotal += row.garnishmentAmount || 0;
      dateBucket.loanPaymentTotal += row.loanPaymentAmount || 0;
      dateBucket.stylistKeys.add(`${row.locationName}::${row.staffName}`);
      dateBucket.lastUpdatedAt = mostRecentIso(dateBucket.lastUpdatedAt, row.lastUpdatedAt);

      const locationKey = `${row.date}::${row.locationName}`;
      const existingTotal = totalsByDateLocation.get(locationKey);
      const locationBucket = dateBucket.locations.get(row.locationName) || {
        locationName: row.locationName,
        rows: [],
        branchTotal: existingTotal?.branchTotal ?? null,
        originalPayoutTotal: existingTotal?.originalPayoutTotal ?? null,
        garnishmentTotal: existingTotal?.garnishmentTotal ?? null,
        loanPaymentTotal: existingTotal?.loanPaymentTotal ?? null,
        stylistCount: existingTotal?.stylistCount ?? null,
        lastUpdatedAt: existingTotal?.lastUpdatedAt ?? null,
      };
      locationBucket.rows.push(row);
      locationBucket.lastUpdatedAt = mostRecentIso(locationBucket.lastUpdatedAt, row.lastUpdatedAt);
      dateBucket.locations.set(row.locationName, locationBucket);
      byDate.set(row.date, dateBucket);
    }

    return [...byDate.values()]
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((dateBucket) => ({
        date: dateBucket.date,
        totalPayout: dateBucket.totalPayout,
        originalPayoutTotal: dateBucket.originalPayoutTotal,
        garnishmentTotal: dateBucket.garnishmentTotal,
        loanPaymentTotal: dateBucket.loanPaymentTotal,
        stylistCount: dateBucket.stylistKeys.size,
        lastUpdatedAt: dateBucket.lastUpdatedAt,
        locations: [...dateBucket.locations.values()]
          .sort((a, b) => a.locationName.localeCompare(b.locationName))
          .map((locationBucket) => ({
            ...locationBucket,
            rows: [...locationBucket.rows].sort((a, b) => (b.netPayoutAmount || 0) - (a.netPayoutAmount || 0) || a.staffName.localeCompare(b.staffName)),
          })),
      }));
  };

  function Payouts(props: any) {
    const teamId = typeof props?.teamId === 'string' && props.teamId.trim() ? props.teamId.trim() : null;
    const defaultDay = yesterday();
    const [locations, setLocations] = useState([] as LocationRow[]);
    const [data, setData] = useState(null as PayoutResponse | null);
    const [locationName, setLocationName] = useState('');
    const [startDateInput, setStartDateInput] = useState(defaultDay);
    const [endDateInput, setEndDateInput] = useState(defaultDay);
    const [startDate, setStartDate] = useState(defaultDay);
    const [endDate, setEndDate] = useState(defaultDay);
    const [syncState, setSyncState] = useState(null as any);
    const [latestRun, setLatestRun] = useState(null as any);
    const [totalRows, setTotalRows] = useState(null as number | null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(null as string | null);
    const [message, setMessage] = useState(null as string | null);
    const [error, setError] = useState(null as string | null);
    const [openDays, setOpenDays] = useState({} as Record<string, boolean>);

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
        const meta = await loadCacheMeta(teamId, 'staff_cashout_facts');
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
          startDate ? `startDate=${encodeURIComponent(startDate)}` : '',
          endDate ? `endDate=${encodeURIComponent(endDate)}` : '',
          locationName ? `locationName=${encodeURIComponent(locationName)}` : '',
        ].filter(Boolean).join('&');
        const res = await api('yot', teamId, `/payouts${params ? `?${params}` : ''}`) as PayoutResponse;
        setData(res);
      } catch (e: any) {
        setError(e?.message || 'Failed to load payouts');
      } finally {
        setLoading(false);
      }
    };

    const refreshAll = async () => {
      await Promise.all([loadLocations(), loadMeta(), load()]);
    };

    const runSync = async () => {
      if (!teamId) return;
      setBusy('sync');
      setMessage(null);
      setError(null);
      try {
        const params = [
          startDate ? `startDate=${encodeURIComponent(startDate)}` : '',
          endDate ? `endDate=${encodeURIComponent(endDate)}` : '',
        ].filter(Boolean).join('&');
        const res = await api('yot', teamId, `/payouts/sync${params ? `?${params}` : ''}`, { method: 'POST', headers: { 'content-type': 'application/json' } }) as any;
        setMessage(`Payout export complete • ${fmtNumber(res?.dayCount)} day${res?.dayCount === 1 ? '' : 's'} regenerated from ${res?.startDate || startDate} to ${res?.endDate || endDate}`);
        await Promise.all([loadMeta(), load()]);
      } catch (e: any) {
        setError(e?.message || 'Failed to sync payouts');
      } finally {
        setBusy(null);
      }
    };

    useEffect(() => { if (teamId) { void refreshAll(); } else setLoading(false); }, [teamId, startDate, endDate, locationName]);

    const groupedPayouts = data?.rows?.length ? buildGroupedPayouts(data.rows, data.locationTotals || []) : [];

    useEffect(() => {
      if (!groupedPayouts.length) return;
      setOpenDays((current: Record<string, boolean>) => {
        const next = { ...current };
        let changed = false;
        for (const dayGroup of groupedPayouts as any[]) {
          if (!(dayGroup.date in next)) {
            next[dayGroup.date] = false;
            changed = true;
          }
        }
        return changed ? next : current;
      });
    }, [JSON.stringify(groupedPayouts.map((row: any) => row.date))]);

    if (!teamId) return h('div', { style: t.card }, h('div', { className: 'text-sm font-medium', style: t.text }, 'Payouts'), h('div', { className: 'mt-2 text-sm', style: t.danger }, 'No team context was provided to the YOT Payouts tab.'));

    return h('div', { className: 'space-y-3' },
      h('div', { style: t.card },
        h('div', { className: 'flex items-start justify-between gap-2' },
          h('div', null,
            h('div', { className: 'text-sm font-medium', style: t.text }, 'Payouts'),
            h('div', { className: 'mt-1 text-xs', style: t.faint }, 'Finalized payout rows sourced from the branch export files in /Users/hairmx/hmx-reports.')
          ),
          h('button', { type: 'button', onClick: () => void refreshAll(), style: t.btnGhost, disabled: loading || !!busy }, loading ? 'Loading…' : '↻ Refresh')
        ),
        error && h('div', { className: 'mt-3 text-xs', style: t.danger }, error),
        message && h('div', { className: 'mt-3 text-xs', style: t.success }, message),
        renderCacheSummaryCards(h, { syncState, latestRun, totalRows, emptyLatestRunText: 'No staff cashout sync runs recorded yet.' }),
        h('div', { className: 'mt-3', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' } },
          h('label', { style: { ...t.faint, display: 'block', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em' } }, 'Start date',
            h('input', { type: 'date', value: startDateInput, onChange: (e: any) => setStartDateInput(e.target.value), style: { ...t.input, marginTop: '0.35rem' } })
          ),
          h('label', { style: { ...t.faint, display: 'block', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em' } }, 'End date',
            h('input', { type: 'date', value: endDateInput, onChange: (e: any) => setEndDateInput(e.target.value), style: { ...t.input, marginTop: '0.35rem' } })
          ),
          h('label', { style: { ...t.faint, display: 'block', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em' } }, 'Branch',
            h('select', { value: locationName, onChange: (e: any) => setLocationName(e.target.value), style: { ...t.input, marginTop: '0.35rem' } },
              h('option', { value: '' }, 'All branches'),
              ...locations.map((row: LocationRow) => h('option', { key: row.id, value: row.name || '' }, row.name || row.id))
            )
          )
        ),
        h('div', { className: 'mt-3 flex flex-wrap gap-2' },
          h('button', { type: 'button', style: t.btnPrimary, onClick: () => { setStartDate(startDateInput); setEndDate(endDateInput); } }, 'Apply filters'),
          h('button', { type: 'button', style: t.btnGhost, onClick: () => { const day = yesterday(); setLocationName(''); setStartDateInput(day); setEndDateInput(day); setStartDate(day); setEndDate(day); } }, 'Reset to yesterday'),
          h('button', { type: 'button', style: t.btnGhost, disabled: !!busy, onClick: () => void runSync() }, busy === 'sync' ? 'Regenerating…' : 'Regenerate range')
        )
      ),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' } },
        h('div', { style: t.card }, h('div', { className: 'text-xs', style: t.faint }, 'Net payout total'), h('div', { className: 'mt-1 text-lg font-semibold', style: t.text }, fmtCurrency(data?.totals?.payoutTotal ?? null))),
        h('div', { style: t.card }, h('div', { className: 'text-xs', style: t.faint }, 'Garnishments total'), h('div', { className: 'mt-1 text-lg font-semibold', style: t.text }, fmtCurrency(data?.totals?.garnishmentTotal ?? null))),
        h('div', { style: t.card }, h('div', { className: 'text-xs', style: t.faint }, 'Loan payments total'), h('div', { className: 'mt-1 text-lg font-semibold', style: t.text }, fmtCurrency(data?.totals?.loanPaymentTotal ?? null))),
        h('div', { style: t.card }, h('div', { className: 'text-xs', style: t.faint }, 'Original payout total'), h('div', { className: 'mt-1 text-lg font-semibold', style: t.text }, fmtCurrency(data?.totals?.originalPayoutTotal ?? null))),
        h('div', { style: t.card }, h('div', { className: 'text-xs', style: t.faint }, 'Branches'), h('div', { className: 'mt-1 text-lg font-semibold', style: t.text }, fmtNumber(data?.totals?.branchCount ?? null))),
        h('div', { style: t.card }, h('div', { className: 'text-xs', style: t.faint }, 'Stylists'), h('div', { className: 'mt-1 text-lg font-semibold', style: t.text }, fmtNumber(data?.totals?.stylistCount ?? null))),
        h('div', { style: t.card }, h('div', { className: 'text-xs', style: t.faint }, 'Days'), h('div', { className: 'mt-1 text-lg font-semibold', style: t.text }, fmtNumber(data?.totals?.dayCount ?? null)))
      ),
      h('div', { style: t.card },
        h('div', { className: 'text-sm font-medium mb-3', style: t.text }, 'Payout rows'),
        groupedPayouts.length
          ? groupedPayouts.map((dayGroup: any) =>
              h('div', {
                key: dayGroup.date,
                style: {
                  border: '1px solid var(--ck-border-subtle)',
                  borderRadius: '10px',
                  marginBottom: '0.9rem',
                  overflow: 'hidden',
                  background: 'rgba(255,255,255,0.02)',
                }
              },
                h('button', {
                  type: 'button',
                  onClick: () => setOpenDays((current: Record<string, boolean>) => ({ ...current, [dayGroup.date]: !current[dayGroup.date] })),
                  style: {
                    width: '100%',
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    padding: '0.85rem 1rem',
                    display: 'grid',
                    gridTemplateColumns: 'minmax(150px, 1.1fr) minmax(140px, 1fr) minmax(100px, 0.8fr) minmax(180px, 1.2fr) 24px',
                    gap: '0.75rem',
                    alignItems: 'center',
                    textAlign: 'left',
                  }
                },
                  h('div', null,
                    h('div', { className: 'text-xs', style: t.faint }, 'Date'),
                    h('div', { className: 'text-sm font-medium', style: t.text }, dayGroup.date)
                  ),
                  h('div', null,
                    h('div', { className: 'text-xs', style: t.faint }, 'Net payout'),
                    h('div', { className: 'text-sm font-medium', style: t.text }, fmtCurrency(dayGroup.totalPayout))
                  ),
                  h('div', null,
                    h('div', { className: 'text-xs', style: t.faint }, 'Stylists'),
                    h('div', { className: 'text-sm font-medium', style: t.text }, fmtNumber(dayGroup.stylistCount))
                  ),
                  h('div', null,
                    h('div', { className: 'text-xs', style: t.faint }, 'Last updated'),
                    h('div', { className: 'text-sm font-medium', style: t.text }, formatDateTime(dayGroup.lastUpdatedAt))
                  ),
                  h('div', { style: { ...t.text, fontSize: '1rem', textAlign: 'right' } }, openDays[dayGroup.date] ? '▴' : '▾')
                ),
                openDays[dayGroup.date] && h('div', { style: { padding: '0 1rem 1rem 1rem' } },
                  h('div', {
                    style: {
                      marginTop: '0.75rem',
                      marginBottom: '0.25rem',
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '1rem',
                      fontSize: '0.8rem',
                      color: t.faint.color,
                    }
                  },
                    h('span', null, `Original: ${fmtCurrency(dayGroup.originalPayoutTotal)}`),
                    h('span', null, `Garnishments: ${fmtCurrency(dayGroup.garnishmentTotal)}`),
                    h('span', null, `Loan payments: ${fmtCurrency(dayGroup.loanPaymentTotal)}`),
                    h('span', null, `Net: ${fmtCurrency(dayGroup.totalPayout)}`)
                  ),
                  ...dayGroup.locations.map((locationGroup: any) =>
                    h('div', {
                      key: `${dayGroup.date}::${locationGroup.locationName}`,
                      style: {
                        marginTop: '0.8rem',
                        border: '1px solid rgba(255,255,255,0.05)',
                        borderRadius: '10px',
                        overflow: 'hidden',
                      }
                    },
                      h('div', {
                        style: {
                          padding: '0.75rem 0.9rem',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: '0.75rem',
                          background: 'rgba(255,255,255,0.03)',
                          borderBottom: '1px solid rgba(255,255,255,0.05)',
                        }
                      },
                        h('div', { className: 'text-sm font-medium', style: t.text }, locationGroup.locationName),
                        h('div', { className: 'text-xs', style: t.faint }, `${fmtNumber(locationGroup.stylistCount)} stylists • ${fmtCurrency(locationGroup.branchTotal)} net • ${fmtCurrency(locationGroup.loanPaymentTotal)} loans`)
                      ),
                      h('div', { style: t.tableWrap },
                        h('table', { style: t.table },
                          h('thead', null, h('tr', null,
                            h('th', { style: t.th }, 'Stylist'),
                            h('th', { style: t.th }, 'Staff ID'),
                            h('th', { style: t.th }, 'Original payout'),
                            h('th', { style: t.th }, 'Loan payment'),
                            h('th', { style: t.th }, 'Garnishment'),
                            h('th', { style: t.th }, 'Net payout'),
                            h('th', { style: t.th }, 'Last updated')
                          )),
                          h('tbody', null,
                            ...locationGroup.rows.map((row: PayoutRow) => h('tr', { key: `${row.date}::${row.locationName}::${row.staffId || row.staffName}` },
                              h('td', { style: t.td }, row.staffName),
                              h('td', { style: t.td }, row.staffId || '—'),
                              h('td', { style: t.td }, fmtCurrency(row.originalPayoutAmount)),
                              h('td', { style: t.td }, row.loanPaymentAmount > 0 ? fmtCurrency(row.loanPaymentAmount) : '—'),
                              h('td', { style: t.td }, row.garnishmentAmount > 0
                                ? `${fmtCurrency(row.garnishmentAmount)}${row.garnishmentPercent ? ` (${fmtNumber(Math.round(row.garnishmentPercent * 100))}%)` : ''}`
                                : '—'),
                              h('td', { style: t.td }, fmtCurrency(row.netPayoutAmount)),
                              h('td', { style: t.td }, formatDateTime(row.lastUpdatedAt))
                            )),
                            h('tr', { style: { background: 'rgba(255,255,255,0.025)' } },
                              h('td', { style: { ...t.td, fontWeight: 700 } }, `${locationGroup.locationName} total`),
                              h('td', { style: { ...t.td, fontWeight: 700 } }, '—'),
                              h('td', { style: { ...t.td, fontWeight: 700 } }, fmtCurrency(locationGroup.originalPayoutTotal)),
                              h('td', { style: { ...t.td, fontWeight: 700 } }, fmtCurrency(locationGroup.loanPaymentTotal)),
                              h('td', { style: { ...t.td, fontWeight: 700 } }, fmtCurrency(locationGroup.garnishmentTotal)),
                              h('td', { style: { ...t.td, fontWeight: 700 } }, fmtCurrency(locationGroup.branchTotal)),
                              h('td', { style: { ...t.td, fontWeight: 700 } }, formatDateTime(locationGroup.lastUpdatedAt))
                            )
                          )
                        )
                      )
                    )
                  )
                )
              )
            )
          : h('div', { style: { ...t.tableWrap } },
              h('table', { style: t.table },
                h('tbody', null,
                  h('tr', null, h('td', { style: t.td }, loading ? 'Loading payouts…' : 'No payout rows found for this filter.'))
                )
              )
            )
      )
    );
  }

  (window as any).KitchenPlugin.registerTab('yot', 'payouts', Payouts);
})();
