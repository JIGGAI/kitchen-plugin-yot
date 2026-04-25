import { api, boolLabel, describeFreshness, fmtNumber, formatDateTime, t } from './common';

(function () {
  const R = (window as any).React;
  if (!R) return;
  const h = R.createElement;
  const useEffect = R.useEffect as typeof R.useEffect;
  const useState = R.useState as (initial: any) => [any, (value: any) => void];

  type SyncStateRow = {
    resource: string;
    lastSyncedAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    rowCount: number | null;
  };

  type Health = {
    teamId: string;
    dbMode: string;
    yotConfigured: boolean;
    counts: { clients: number; locations: number; stylists: number; appointments: number; services: number };
    syncState: SyncStateRow[];
  };

  function Overview(props: any) {
    const teamId = typeof props?.teamId === 'string' && props.teamId.trim() ? props.teamId.trim() : null;
    const [health, setHealth] = useState(null as Health | null);
    const [busy, setBusy] = useState(null as string | null);
    const [loading, setLoading] = useState(true);
    const [message, setMessage] = useState(null as string | null);
    const [error, setError] = useState(null as string | null);

    const load = async () => {
      if (!teamId) return;
      setLoading(true);
      setError(null);
      try {
        setHealth(await api('yot', teamId, '/health'));
      } catch (e: any) {
        setError(e?.message || 'Failed to load health');
      } finally {
        setLoading(false);
      }
    };

    useEffect(() => { if (teamId) void load(); else setLoading(false); }, [teamId]);

    const runAction = async (key: string, label: string, path: string) => {
      if (!teamId) return;
      setBusy(key);
      setMessage(null);
      setError(null);
      try {
        const data = await api('yot', teamId, path, { method: 'POST', headers: { 'content-type': 'application/json' } }) as any;
        if (key === 'export') {
          setMessage(`${label} complete • ${data?.manifest?.directory || 'snapshot written'}`);
        } else if (key === 'clients') {
          setMessage(`${label} complete • ${fmtNumber(data?.synced)} clients synced across ${fmtNumber(data?.pageCount)} pages`);
        } else if (key === 'stylists' || key === 'services') {
          setMessage(`${label} complete • ${fmtNumber(data?.synced)} rows across ${fmtNumber(data?.locationCount)} locations`);
        } else {
          setMessage(`${label} complete`);
        }
        await load();
      } catch (e: any) {
        setError(e?.message || `Failed to ${label.toLowerCase()}`);
      } finally {
        setBusy(null);
      }
    };

    const stats = [
      ['Team', health?.teamId || teamId || '—'],
      ['Database', health?.dbMode || '—'],
      ['YOT configured', boolLabel(health?.yotConfigured, 'Configured', 'Missing')],
      ['Clients cached', fmtNumber(health?.counts?.clients)],
      ['Locations cached', fmtNumber(health?.counts?.locations)],
      ['Stylists cached', fmtNumber(health?.counts?.stylists)],
      ['Appointments cached', fmtNumber(health?.counts?.appointments)],
      ['Services cached', fmtNumber(health?.counts?.services)],
    ];

    const summaryRows = Array.isArray(health?.syncState) ? health!.syncState : [];

    if (!teamId) {
      return h('div', { style: t.card },
        h('div', { className: 'text-sm font-medium', style: t.text }, 'YOT Overview & Health'),
        h('div', { className: 'mt-2 text-sm', style: t.danger }, 'No team context was provided to the YOT plugin.'),
        h('div', { className: 'mt-2 text-xs', style: t.faint }, 'Open this plugin from a specific team so it can query the correct yot-<team>.db cache instead of silently falling back to an empty default database.')
      );
    }

    return h('div', { className: 'space-y-3' },
      h('div', { style: t.card },
        h('div', { className: 'flex items-start justify-between gap-2' },
          h('div', null,
            h('div', { className: 'text-sm font-medium', style: t.text }, 'YOT Overview & Health'),
            h('div', { className: 'mt-1 text-xs', style: t.faint }, 'Operator controls plus clearer freshness/error signals for each cached resource.')
          ),
          h('button', { type: 'button', onClick: () => void load(), style: t.btnGhost, disabled: loading || !!busy }, loading ? 'Loading…' : '↻ Refresh')
        ),
        error && h('div', { className: 'mt-3 text-xs', style: t.danger }, error),
        message && h('div', { className: 'mt-3 text-xs', style: t.success }, message),
        h('div', { className: 'mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4' },
          ...stats.map(([label, value]) => h('div', { key: label, style: { ...t.card, padding: '0.75rem' } },
            h('div', { className: 'text-xs', style: t.faint }, label),
            h('div', { className: 'mt-1 text-sm font-medium', style: t.text }, String(value))
          ))
        ),
        h('div', { className: 'mt-3 flex flex-wrap gap-2' },
          h('button', { type: 'button', style: t.btnPrimary, disabled: !!busy || !health?.yotConfigured, onClick: () => void runAction('locations', 'Locations sync', '/locations/sync') }, busy === 'locations' ? 'Syncing…' : 'Sync locations'),
          h('button', { type: 'button', style: t.btnGhost, disabled: !!busy || !health?.yotConfigured, onClick: () => void runAction('clients', 'Limited client sync', '/clients/sync?maxPages=5') }, busy === 'clients' ? 'Syncing…' : 'Limited client sync'),
          h('button', { type: 'button', style: t.btnGhost, disabled: !!busy || !health?.yotConfigured, onClick: () => void runAction('stylists', 'Stylists sync', '/stylists/sync') }, busy === 'stylists' ? 'Syncing…' : 'Sync stylists'),
          h('button', { type: 'button', style: t.btnGhost, disabled: !!busy || !health?.yotConfigured, onClick: () => void runAction('services', 'Services sync', '/services/sync') }, busy === 'services' ? 'Syncing…' : 'Sync services'),
          h('button', { type: 'button', style: t.btnGhost, disabled: !!busy, onClick: () => void runAction('export', 'Export snapshot', '/export') }, busy === 'export' ? 'Exporting…' : 'Export snapshot')
        )
      ),
      h('div', { style: t.card },
        h('div', { className: 'text-sm font-medium mb-3', style: t.text }, 'Sync State Summary'),
        !summaryRows.length
          ? h('div', { className: 'text-sm', style: t.faint }, loading ? 'Loading sync state…' : 'No sync state recorded yet.')
          : h('div', { style: t.tableWrap },
              h('table', { style: t.table },
                h('thead', null, h('tr', null,
                  h('th', { style: t.th }, 'Resource'),
                  h('th', { style: t.th }, 'Status'),
                  h('th', { style: t.th }, 'Rows'),
                  h('th', { style: t.th }, 'Last success'),
                  h('th', { style: t.th }, 'Last attempt'),
                  h('th', { style: t.th }, 'Detail')
                )),
                h('tbody', null,
                  ...summaryRows.map((row: SyncStateRow) => {
                    const freshness = describeFreshness(row);
                    return h('tr', { key: row.resource },
                      h('td', { style: t.td }, row.resource),
                      h('td', { style: t.td }, h('span', { style: t.badge(freshness.color) }, freshness.label)),
                      h('td', { style: t.td }, fmtNumber(row.rowCount)),
                      h('td', { style: t.td }, formatDateTime(row.lastSuccessAt)),
                      h('td', { style: t.td }, formatDateTime(row.lastSyncedAt)),
                      h('td', { style: { ...t.td, ...(freshness.tone === 'error' ? t.danger : freshness.tone === 'stale' || freshness.tone === 'aging' ? t.warning : t.faint) } }, freshness.detail)
                    );
                  })
                )
              )
            )
      )
    );
  }

  (window as any).KitchenPlugin.registerTab('yot', 'overview', Overview);
})();
