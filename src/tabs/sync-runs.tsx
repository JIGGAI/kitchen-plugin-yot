import { api, fmtNumber, formatDateTime, formatRelativeTime, t } from './common';

(function () {
  const R = (window as any).React;
  if (!R) return;
  const h = R.createElement;
  const useEffect = R.useEffect as typeof R.useEffect;
  const useState = R.useState as (initial: any) => [any, (value: any) => void];

  type Row = {
    id: string;
    resource: string;
    status: string;
    startedAt: string;
    completedAt: string | null;
    rowsSeen: number | null;
    rowsWritten: number | null;
    pageCount: number | null;
    notes: string | null;
    error: string | null;
  };

  function SyncRuns(props: any) {
    const teamId = typeof props?.teamId === 'string' && props.teamId.trim() ? props.teamId.trim() : null;
    const [rows, setRows] = useState([] as Row[]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null as string | null);

    const load = async () => {
      if (!teamId) return;
      setLoading(true);
      setError(null);
      try {
        const data = await api('yot', teamId, '/sync-runs?limit=100') as { data: Row[] };
        setRows(Array.isArray(data?.data) ? data.data : []);
      } catch (e: any) {
        setError(e?.message || 'Failed to load sync runs');
      } finally {
        setLoading(false);
      }
    };

    useEffect(() => { if (teamId) void load(); else setLoading(false); }, [teamId]);

    if (!teamId) {
      return h('div', { style: t.card },
        h('div', { className: 'text-sm font-medium', style: t.text }, 'Sync Runs'),
        h('div', { className: 'mt-2 text-sm', style: t.danger }, 'No team context was provided to the YOT Sync Runs tab.'),
        h('div', { className: 'mt-2 text-xs', style: t.faint }, 'Open this plugin from a specific team so it can query the correct yot-<team>.db cache instead of silently falling back to an empty default database.')
      );
    }

    return h('div', { className: 'space-y-3' },
      h('div', { style: t.card },
        h('div', { className: 'flex items-start justify-between gap-2' },
          h('div', null,
            h('div', { className: 'text-sm font-medium', style: t.text }, 'Sync Runs'),
            h('div', { className: 'mt-1 text-xs', style: t.faint }, 'Recent sync executions with clearer timing, counts, and error context.')
          ),
          h('button', { type: 'button', onClick: () => void load(), style: t.btnGhost, disabled: loading }, loading ? 'Loading…' : '↻ Refresh')
        ),
        error && h('div', { className: 'mt-3 text-xs', style: t.danger }, error)
      ),
      h('div', { style: t.card },
        h('div', { style: t.tableWrap },
          h('table', { style: t.table },
            h('thead', null, h('tr', null,
              h('th', { style: t.th }, 'Started'),
              h('th', { style: t.th }, 'Resource'),
              h('th', { style: t.th }, 'Status'),
              h('th', { style: t.th }, 'Rows'),
              h('th', { style: t.th }, 'Pages'),
              h('th', { style: t.th }, 'Completed'),
              h('th', { style: t.th }, 'Notes / Error')
            )),
            h('tbody', null,
              rows.length
                ? rows.map((row: Row) => {
                    const statusColor = row.status === 'success'
                      ? 'rgba(74,222,128,0.7)'
                      : row.status === 'error'
                        ? 'rgba(248,113,113,0.7)'
                        : 'rgba(251,191,36,0.7)';
                    return h('tr', { key: row.id },
                      h('td', { style: t.td },
                        h('div', null, formatDateTime(row.startedAt)),
                        h('div', { className: 'text-xs', style: t.faint }, `${formatRelativeTime(row.startedAt)} • ${row.id}`)
                      ),
                      h('td', { style: t.td }, row.resource),
                      h('td', { style: t.td },
                        h('span', { style: t.badge(statusColor) }, row.status)
                      ),
                      h('td', { style: t.td }, `${fmtNumber(row.rowsWritten)} written / ${fmtNumber(row.rowsSeen)} seen`),
                      h('td', { style: t.td }, fmtNumber(row.pageCount)),
                      h('td', { style: t.td }, row.completedAt ? `${formatDateTime(row.completedAt)}` : 'Still running / not recorded'),
                      h('td', { style: { ...t.td, ...(row.error ? t.danger : t.faint) } },
                        h('div', null, row.error || row.notes || '—'),
                        row.completedAt
                          ? h('div', { className: 'text-xs', style: t.faint }, `Finished ${formatRelativeTime(row.completedAt)}`)
                          : null
                      )
                    );
                  })
                : h('tr', null, h('td', { style: t.td, colSpan: 7 }, loading ? 'Loading sync runs…' : 'No sync runs recorded yet.'))
            )
          )
        )
      )
    );
  }

  (window as any).KitchenPlugin.registerTab('yot', 'sync-runs', SyncRuns);
})();
