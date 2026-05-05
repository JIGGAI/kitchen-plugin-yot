import { api, formatDateTime, t } from './common';

(function () {
  const R = (window as any).React;
  if (!R) return;
  const h = R.createElement;
  const useEffect = R.useEffect as typeof R.useEffect;
  const useState = R.useState as (initial: any) => [any, (value: any) => void];

  type Slot = {
    startsAt: string;
    endsAt: string;
    customerCount: number;
    requiredStylists: number;
    scheduledStylists: number;
    light: boolean;
  };

  type LightWindow = {
    startsAt: string;
    endsAt: string;
    durationMinutes: number;
    customerCount: number;
    requiredStylists: number;
    scheduledStylists: number;
    deficit: number;
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

  type LocationOption = { id: string; name: string };

  function todayLocal(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function hhmm(iso: string): string { return iso.slice(11, 16); }

  function Coverage(props: any) {
    const teamId = typeof props?.teamId === 'string' && props.teamId.trim() ? props.teamId.trim() : null;
    const [locations, setLocations] = useState([] as LocationOption[]);
    const [locationId, setLocationId] = useState('');
    const [date, setDate] = useState(todayLocal());
    const [slots, setSlots] = useState([] as Slot[]);
    const [windows, setWindows] = useState([] as LightWindow[]);
    const [computedAt, setComputedAt] = useState(null as string | null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null as string | null);
    const [coverWindow, setCoverWindow] = useState(null as LightWindow | null);
    const [candidates, setCandidates] = useState([] as Candidate[]);
    const [serviceMinutes, setServiceMinutes] = useState(60);
    const [pool, setPool] = useState('cross' as 'cross' | 'same');

    useEffect(() => {
      if (!teamId) return;
      void api('yot', teamId, '/locations').then((res: any) => {
        const opts: LocationOption[] = (res?.data || []).map((l: any) => ({ id: String(l.id), name: l.name || String(l.id) }));
        opts.sort((a, b) => a.name.localeCompare(b.name));
        setLocations(opts);
        if (!locationId && opts.length > 0) setLocationId(opts[0].id);
      }).catch((e: any) => setError(String(e?.message || e)));
    }, [teamId]);

    async function refresh(forceSync: boolean = false) {
      if (!teamId || !locationId) return;
      setBusy(true);
      setError(null);
      setCoverWindow(null);
      setCandidates([]);
      try {
        if (forceSync) {
          await api('yot', teamId, '/coverage/sync', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ locationId, date }),
          });
        }
        try {
          const slotsRes = await api('yot', teamId, `/coverage/slots?locationId=${encodeURIComponent(locationId)}&date=${date}`) as any;
          setSlots(slotsRes.data.slots);
          setComputedAt(slotsRes.data.computedAt);
        } catch (e: any) {
          if (String(e?.message || '').includes('NO_COVERAGE_CACHE') && !forceSync) {
            return await refresh(true);
          }
          throw e;
        }
        const winRes = await api('yot', teamId, `/coverage/light-windows?locationId=${encodeURIComponent(locationId)}&date=${date}`) as any;
        setWindows(winRes.data.windows || []);
      } catch (e: any) {
        const msg = String(e?.message || e);
        if (msg.includes('MVC_AUTH_MISSING')) {
          setError('YOT MVC cookie not set. Add it via: openclaw config set plugins.entries.yot.config.mvcCookie "<cookie>"');
        } else if (msg.includes('MVC_AUTH_EXPIRED')) {
          setError('YOT session expired — refresh mvcCookie from a fresh logged-in browser session.');
        } else {
          setError(msg);
        }
      } finally {
        setBusy(false);
      }
    }

    async function findCover(w: LightWindow) {
      if (!teamId || !locationId) return;
      setCoverWindow(w);
      setCandidates([]);
      try {
        const res = await api('yot', teamId,
          `/coverage/staff-available?locationId=${encodeURIComponent(locationId)}&from=${encodeURIComponent(w.startsAt)}&to=${encodeURIComponent(w.endsAt)}&serviceMinutes=${serviceMinutes}&pool=${pool}`) as any;
        setCandidates(res.data.candidates || []);
      } catch (e: any) {
        setError(String(e?.message || e));
      }
    }

    return h('div', { style: { padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem' } },
      // Controls
      h('div', { style: { display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' } },
        h('select', {
          value: locationId,
          onChange: (e: any) => setLocationId(e.target.value),
          style: t.input,
        },
          h('option', { value: '' }, 'Pick a location…'),
          ...locations.map((l) => h('option', { key: l.id, value: l.id }, l.name)),
        ),
        h('input', {
          type: 'date',
          value: date,
          onChange: (e: any) => setDate(e.target.value),
          style: t.input,
        }),
        h('button', {
          type: 'button',
          onClick: () => refresh(false),
          disabled: !locationId || busy,
          style: t.btnPrimary,
        }, busy ? 'Loading…' : 'Refresh'),
        h('button', {
          type: 'button',
          onClick: () => refresh(true),
          disabled: !locationId || busy,
          style: t.btnGhost,
        }, 'Force Sync'),
        computedAt ? h('span', { style: { ...t.faint, fontSize: '0.85em' } },
          `Computed ${formatDateTime(computedAt)}`) : null,
      ),

      // Error
      error ? h('div', {
        style: { color: '#ff8888', padding: '0.5rem', border: '1px solid #553', borderRadius: '4px' },
      }, error) : null,

      // Slot table
      slots.length === 0 && !busy && !error ? h('div', { style: t.faint }, 'Pick a location and date, then Refresh.') : null,
      slots.length > 0 ? h('div', null,
        h('h3', { style: { margin: '0 0 0.5rem 0' } }, 'Coverage by 30-min slot'),
        h('table', { style: t.table },
          h('thead', null, h('tr', null,
            ['Time', 'Required', 'Scheduled', 'Customers', 'Status'].map((c) => h('th', { key: c, style: t.th }, c)),
          )),
          h('tbody', null, ...slots.map((s) => h('tr', {
            key: s.startsAt,
            style: s.light ? { background: 'rgba(255, 80, 80, 0.18)' } : undefined,
          },
            h('td', { style: t.td }, hhmm(s.startsAt) + '–' + hhmm(s.endsAt)),
            h('td', { style: t.td }, s.requiredStylists),
            h('td', { style: t.td }, s.scheduledStylists),
            h('td', { style: t.td }, s.customerCount),
            h('td', { style: t.td }, s.light ? 'LIGHT' : 'ok'),
          ))),
        ),
      ) : null,

      // Light windows
      windows.length > 0 ? h('div', null,
        h('h3', { style: { margin: '0 0 0.5rem 0' } }, `Light windows (${windows.length})`),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '0.5rem' } },
          ...windows.map((w) => h('div', {
            key: w.startsAt,
            style: { display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.5rem', border: '1px solid #444', borderRadius: '4px' },
          },
            h('div', { style: { flex: 1 } },
              h('strong', null, `${hhmm(w.startsAt)}–${hhmm(w.endsAt)}`),
              h('span', { style: { marginLeft: '1rem' } },
                `needs ${w.requiredStylists}, have ${w.scheduledStylists} → deficit ${w.deficit}`),
              h('span', { style: { ...t.faint, marginLeft: '0.5rem' } },
                `(${w.durationMinutes} min, peak ${w.customerCount} customers)`),
            ),
            h('button', {
              type: 'button',
              onClick: () => void findCover(w),
              style: t.btnGhost,
            }, 'Find cover'),
          )),
        ),
      ) : null,

      // Find cover panel
      coverWindow ? h('div', {
        style: { padding: '0.75rem', border: '1px solid #555', borderRadius: '4px', background: 'rgba(80,80,120,0.1)' },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.5rem' } },
          h('strong', null, `Find cover: ${hhmm(coverWindow.startsAt)}–${hhmm(coverWindow.endsAt)}`),
          h('label', null, 'Min minutes: ',
            h('input', {
              type: 'number',
              value: serviceMinutes,
              min: 0, step: 15,
              onChange: (e: any) => setServiceMinutes(Number(e.target.value) || 0),
              style: { ...t.input, width: '5rem' },
            }),
          ),
          h('label', null, 'Pool: ',
            h('select', {
              value: pool,
              onChange: (e: any) => setPool(e.target.value as 'cross' | 'same'),
              style: t.input,
            },
              h('option', { value: 'cross' }, 'Cross-location'),
              h('option', { value: 'same' }, 'Same location'),
            ),
          ),
          h('button', {
            type: 'button',
            onClick: () => void findCover(coverWindow),
            style: t.btnPrimary,
          }, 'Re-search'),
        ),
        candidates.length === 0
          ? h('div', { style: { ...t.faint, fontStyle: 'italic' } }, 'No candidates found for this window.')
          : h('table', { style: t.table },
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
            ),
      ) : null,
    );
  }

  (window as any).KitchenPlugin.registerTab('yot', 'coverage', Coverage);
})();
