import { api, formatDateTime, t } from './common';

(function () {
  const R = (window as any).React;
  if (!R) return;
  const h = R.createElement;
  const useEffect = R.useEffect as typeof R.useEffect;
  const useState = R.useState as (initial: any) => [any, (value: any) => void];
  const useMemo = R.useMemo as <T>(factory: () => T, deps: any[]) => T;

  type Slot = {
    startsAt: string;
    endsAt: string;
    customerCount: number;
    requiredStylists: number;
    scheduledStylists: number;
    light: boolean;
  };

  type LocationOption = { id: string; name: string };
  type LocationRow = {
    locationId: string;
    locationName: string;
    slots: Slot[];
    error?: string | null;
    computedAt?: string | null;
  };

  type Candidate = {
    stylistId: string;
    name: string;
    homeLocationId: string | null;
    qualifiedHere: boolean;
    rosteredToday: boolean;
    gapStart: string;
    gapEnd: string;
    gapMinutes: number;
    lastWorkedHereAt: string | null;
  };

  type SelectedCell = { locationId: string; locationName: string; slot: Slot } | null;

  function todayLocal(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function hhmm(iso: string): string { return iso.slice(11, 16); }

  function deepError(e: any): string {
    return String(e?.message || e || 'unknown error');
  }

  // Pull a stable column grid out of all loaded rows (union of slot startsAt).
  function unifySlotGrid(rows: LocationRow[]): string[] {
    const set = new Set<string>();
    for (const row of rows) for (const s of row.slots) set.add(s.startsAt);
    return Array.from(set).sort();
  }

  function Coverage(props: any) {
    const teamId = typeof props?.teamId === 'string' && props.teamId.trim() ? props.teamId.trim() : null;
    const [locations, setLocations] = useState([] as LocationOption[]);
    const [date, setDate] = useState(todayLocal());
    const [rows, setRows] = useState([] as LocationRow[]);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState(null as { current: number; total: number; phase: string } | null);
    const [error, setError] = useState(null as string | null);
    const [selected, setSelected] = useState(null as SelectedCell);
    const [candidates, setCandidates] = useState([] as Candidate[]);
    const [serviceMinutes, setServiceMinutes] = useState(60);
    const [pool, setPool] = useState('cross' as 'cross' | 'same');
    const [findingCover, setFindingCover] = useState(false);

    useEffect(() => {
      if (!teamId) return;
      void api('yot', teamId, '/locations').then((res: any) => {
        const opts: LocationOption[] = (res?.data || []).map((l: any) => ({ id: String(l.id), name: l.name || String(l.id) }));
        opts.sort((a, b) => a.name.localeCompare(b.name));
        setLocations(opts);
      }).catch((e: any) => setError(deepError(e)));
    }, [teamId]);

    async function loadOne(locationId: string, locationName: string, forceSync: boolean): Promise<LocationRow> {
      try {
        if (forceSync) {
          await api('yot', teamId!, '/coverage/sync', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ locationId, date }),
          });
        }
        const slotsRes = await api('yot', teamId!, `/coverage/slots?locationId=${encodeURIComponent(locationId)}&date=${date}`) as any;
        return { locationId, locationName, slots: slotsRes.slots || [], computedAt: slotsRes.computedAt };
      } catch (e: any) {
        const msg = deepError(e);
        if (msg.includes('NO_COVERAGE_CACHE') && !forceSync) {
          return loadOne(locationId, locationName, true);
        }
        return { locationId, locationName, slots: [], error: msg };
      }
    }

    async function refreshAll(forceSync: boolean) {
      if (!teamId || locations.length === 0) return;
      setBusy(true); setError(null); setSelected(null); setCandidates([]);
      setRows([]);
      setProgress({ current: 0, total: locations.length, phase: forceSync ? 'Syncing' : 'Loading' });
      try {
        const out: LocationRow[] = [];
        // Sequential to avoid blasting YOT MVC. Each call is one HTTP round trip.
        for (let i = 0; i < locations.length; i++) {
          const loc = locations[i];
          setProgress({ current: i, total: locations.length, phase: `${forceSync ? 'Syncing' : 'Loading'} ${loc.name}` });
          out.push(await loadOne(loc.id, loc.name, forceSync));
          setRows([...out]); // progressive render
        }
        // Surface any auth errors at top
        const authError = out.find((r) => r.error && (r.error.includes('MVC_AUTH_MISSING') || r.error.includes('MVC_AUTH_EXPIRED')));
        if (authError) {
          setError(authError.error!.includes('MVC_AUTH_MISSING')
            ? 'YOT MVC cookie not set. Run: openclaw config patch ... mvcCookie'
            : 'YOT session expired — refresh mvcCookie from a fresh logged-in browser session.');
        }
      } finally {
        setProgress(null);
        setBusy(false);
      }
    }

    async function findCover(loc: { locationId: string; locationName: string }, slot: Slot) {
      if (!teamId) return;
      setSelected({ locationId: loc.locationId, locationName: loc.locationName, slot });
      setCandidates([]);
      setFindingCover(true);
      try {
        const res = await api('yot', teamId,
          `/coverage/staff-available?locationId=${encodeURIComponent(loc.locationId)}&from=${encodeURIComponent(slot.startsAt)}&to=${encodeURIComponent(slot.endsAt)}&serviceMinutes=${serviceMinutes}&pool=${pool}`) as any;
        setCandidates(res.candidates || []);
      } catch (e: any) {
        setError(deepError(e));
      } finally {
        setFindingCover(false);
      }
    }

    const columns = useMemo(() => unifySlotGrid(rows), [rows]);
    const slotMap = useMemo(() => {
      const map = new Map<string, Map<string, Slot>>();
      for (const row of rows) {
        const inner = new Map<string, Slot>();
        for (const s of row.slots) inner.set(s.startsAt, s);
        map.set(row.locationId, inner);
      }
      return map;
    }, [rows]);

    // ===== render =====
    const headerCellStyle = { ...t.th, padding: '0.25rem 0.4rem', fontSize: '0.75rem', whiteSpace: 'nowrap' as const };
    const locCellStyle = { ...t.td, fontWeight: 600, whiteSpace: 'nowrap' as const, position: 'sticky' as const, left: 0, background: 'var(--ck-bg-soft, #1a1a1f)', zIndex: 1 };

    function cellFor(row: LocationRow, col: string) {
      const slot = slotMap.get(row.locationId)?.get(col);
      const baseStyle: any = {
        ...t.td,
        padding: '0.25rem 0.3rem',
        textAlign: 'center',
        fontSize: '0.75rem',
        cursor: 'default',
        minWidth: '36px',
      };
      if (!slot) {
        return h('td', { key: col, style: { ...baseStyle, background: 'transparent', color: 'rgba(255,255,255,0.2)' } }, '·');
      }
      if (slot.light) {
        const deficit = Math.max(1, slot.requiredStylists - slot.scheduledStylists);
        return h('td', {
          key: col,
          title: `Need ${slot.requiredStylists}, have ${slot.scheduledStylists}, ${slot.customerCount} customers`,
          style: { ...baseStyle, background: 'rgba(220, 50, 50, 0.55)', color: '#fff', fontWeight: 600, cursor: 'pointer' },
          onClick: () => void findCover({ locationId: row.locationId, locationName: row.locationName }, slot),
        }, `−${deficit}`);
      }
      // Covered: green. Slightly dimmer if required==0 (closed/no customers).
      const intensity = slot.requiredStylists === 0 ? 0.18 : 0.40;
      return h('td', {
        key: col,
        title: `Need ${slot.requiredStylists}, have ${slot.scheduledStylists}, ${slot.customerCount} customers`,
        style: { ...baseStyle, background: `rgba(80, 200, 120, ${intensity})`, color: '#cfe' },
      }, slot.requiredStylists === 0 ? '·' : '✓');
    }

    return h('div', { style: { padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem' } },
      // Controls
      h('div', { style: { display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' } },
        h('input', {
          type: 'date',
          value: date,
          onChange: (e: any) => setDate(e.target.value),
          style: t.input,
        }),
        h('button', {
          type: 'button',
          onClick: () => void refreshAll(false),
          disabled: busy || locations.length === 0,
          style: t.btnPrimary,
        }, busy ? (progress?.phase || 'Loading…') : 'Refresh'),
        h('button', {
          type: 'button',
          onClick: () => void refreshAll(true),
          disabled: busy || locations.length === 0,
          style: t.btnGhost,
        }, 'Force Sync (refresh from YOT)'),
        progress ? h('span', { style: { ...t.faint, fontSize: '0.85em' } },
          `${progress.current}/${progress.total}`) : null,
        h('span', { style: { ...t.faint, fontSize: '0.85em' } },
          'Click a red cell to find cover.'),
      ),

      // Error banner
      error ? h('div', {
        style: { color: '#ff8888', padding: '0.5rem', border: '1px solid #553', borderRadius: '4px' },
      }, error) : null,

      // Heatmap grid
      rows.length > 0 ? h('div', { style: { overflowX: 'auto' } },
        h('table', { style: { ...t.table, borderCollapse: 'separate', borderSpacing: 0 } },
          h('thead', null,
            h('tr', null,
              h('th', { style: { ...headerCellStyle, position: 'sticky', left: 0, background: 'var(--ck-bg-soft, #1a1a1f)', zIndex: 2 } }, 'Location'),
              ...columns.map((c) => h('th', { key: c, style: headerCellStyle }, hhmm(c))),
            ),
          ),
          h('tbody', null,
            ...rows.map((row) => h('tr', { key: row.locationId },
              h('td', { style: locCellStyle },
                row.locationName,
                row.error
                  ? h('div', { style: { ...t.faint, fontSize: '0.7rem', fontWeight: 400 } }, row.error.slice(0, 60))
                  : null,
              ),
              ...columns.map((c) => cellFor(row, c)),
            )),
          ),
        ),
      ) : (!busy && !error
        ? h('div', { style: t.faint }, 'Pick a date and click Refresh to load coverage.')
        : null),

      // Find-cover panel
      selected ? h('div', {
        style: { padding: '0.75rem', border: '1px solid #555', borderRadius: '4px', background: 'rgba(80,80,120,0.1)' },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.5rem', flexWrap: 'wrap' } },
          h('strong', null, `${selected.locationName} • ${hhmm(selected.slot.startsAt)}–${hhmm(selected.slot.endsAt)} • need ${selected.slot.requiredStylists}, have ${selected.slot.scheduledStylists}`),
          h('label', null, 'Min minutes: ',
            h('input', {
              type: 'number',
              value: serviceMinutes,
              min: 0,
              step: 15,
              onChange: (e: any) => setServiceMinutes(Number(e.target.value) || 0),
              style: { ...t.input, width: '5rem' },
            }),
          ),
          h('label', null, 'Pool: ',
            h('select', {
              value: pool,
              onChange: (e: any) => setPool(e.target.value),
              style: t.input,
            },
              h('option', { value: 'cross' }, 'Cross-location'),
              h('option', { value: 'same' }, 'Same location'),
            ),
          ),
          h('button', {
            type: 'button',
            onClick: () => void findCover({ locationId: selected.locationId, locationName: selected.locationName }, selected.slot),
            disabled: findingCover,
            style: t.btnPrimary,
          }, findingCover ? 'Searching…' : 'Re-search'),
          h('button', {
            type: 'button',
            onClick: () => { setSelected(null); setCandidates([]); },
            style: t.btnGhost,
          }, 'Close'),
        ),
        candidates.length === 0 && !findingCover
          ? h('div', { style: { ...t.faint, fontStyle: 'italic' } }, 'No candidates found for this window.')
          : candidates.length > 0
            ? h('table', { style: t.table },
                h('thead', null, h('tr', null,
                  ['Name', 'Home', 'Free', 'Rostered', 'Qualified', 'Last worked here'].map((c) => h('th', { key: c, style: t.th }, c)),
                )),
                h('tbody', null, ...candidates.map((c) => {
                  const homeName = locations.find((l) => l.id === c.homeLocationId)?.name || c.homeLocationId || '—';
                  return h('tr', { key: c.stylistId },
                    h('td', { style: t.td }, c.name),
                    h('td', { style: t.td }, homeName),
                    h('td', { style: t.td }, `${hhmm(c.gapStart)}–${hhmm(c.gapEnd)} (${c.gapMinutes}m)`),
                    h('td', { style: t.td }, c.rosteredToday ? '✓' : '—'),
                    h('td', { style: t.td }, c.qualifiedHere ? '✓' : '—'),
                    h('td', { style: t.td }, c.lastWorkedHereAt ? formatDateTime(c.lastWorkedHereAt) : '—'),
                  );
                })),
              )
            : null,
      ) : null,
    );
  }

  (window as any).KitchenPlugin.registerTab('yot', 'coverage', Coverage);
})();
