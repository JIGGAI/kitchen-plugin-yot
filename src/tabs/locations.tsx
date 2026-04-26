import { api, boolLabel, fieldValue, fmtNumber, formatDateTime, joinAddress, modal, t, useEscapeToClose } from './common';

(function () {
  const R = (window as any).React;
  if (!R) return;
  const h = R.createElement;
  const useEffect = R.useEffect as typeof R.useEffect;
  const useState = R.useState as (initial: any) => [any, (value: any) => void];

  type Link = { id: string; label: string; appointmentCount: number; lastAppointmentAt: string | null };
  type Revenue = { available: boolean; source: 'revenue_facts' | 'appointments' | 'none'; grossAmount: number | null; discountAmount: number | null; netAmount: number | null; appointmentCount: number; lastUpdatedAt: string | null; note?: string | null };
  type Detail = {
    id: string;
    name: string | null;
    suburb: string | null;
    state: string | null;
    postcode: string | null;
    businessPhone: string | null;
    mobilePhone: string | null;
    emailAddress: string | null;
    active: boolean | null;
    syncedAt: string;
    street: string | null;
    country: string | null;
    canBookOnline: boolean | null;
    relationships?: {
      appointmentCount: number;
      uniqueClientCount: number;
      uniqueStylistCount: number;
      uniqueLocationCount: number;
      lastAppointmentAt: string | null;
      recentAppointmentCount: number;
      clients: Link[];
      stylists: Link[];
      locations: Link[];
      revenue?: Revenue | null;
    } | null;
    raw: unknown | null;
  };
  type Row = Pick<Detail, 'id' | 'name' | 'suburb' | 'state' | 'postcode' | 'businessPhone' | 'mobilePhone' | 'emailAddress' | 'active' | 'syncedAt'>;
  type StylistRow = { id: string; fullName: string | null; givenName: string | null; surname: string | null; privateId: string | null; emailAddress: string | null; mobilePhone: string | null; active: boolean | null; syncedAt: string };
  type AppointmentRow = { id: string; clientName: string | null; stylistName: string | null; serviceName: string | null; startsAt: string | null; statusDescription: string | null; status: string | null };
  type Pane = 'summary' | 'stylists' | 'appointments' | 'revenue';

  const noteCard = { background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '10px', padding: '0.75rem' };
  const detailLabel = { fontSize: '0.72rem', color: 'var(--ck-text-tertiary)', textTransform: 'uppercase' as const, letterSpacing: '0.04em' };
  const detailValue = { marginTop: '0.2rem', color: 'var(--ck-text-primary)', fontSize: '0.9rem', lineHeight: 1.4, wordBreak: 'break-word' as const };

  function Locations(props: any) {
    const teamId = typeof props?.teamId === 'string' && props.teamId.trim() ? props.teamId.trim() : null;
    const [rows, setRows] = useState([] as Row[]);
    const [searchInput, setSearchInput] = useState('');
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null as string | null);
    const [selectedId, setSelectedId] = useState(null as string | null);
    const [detail, setDetail] = useState(null as Detail | null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [detailError, setDetailError] = useState(null as string | null);
    const [pane, setPane] = useState('summary' as Pane);
    const [relatedStylists, setRelatedStylists] = useState([] as StylistRow[]);
    const [relatedAppointments, setRelatedAppointments] = useState([] as AppointmentRow[]);
    const [paneLoading, setPaneLoading] = useState(false);

    useEscapeToClose(R, !!selectedId, () => { setSelectedId(null); setDetail(null); setDetailError(null); setPane('summary'); });

    const fmtCurrency = (value: number | null | undefined) => {
      if (value == null || Number.isNaN(value)) return '—';
      try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value); } catch { return `$${value.toFixed(2)}`; }
    };

    const detailField = (label: string, value: any) => h('div', { key: label, style: noteCard }, h('div', { style: detailLabel }, label), h('div', { style: detailValue }, value));
    const locationLabel = (row: Row | Detail) => row.name || 'Unnamed';

    const load = async () => {
      if (!teamId) return;
      setLoading(true); setError(null);
      try {
        const data = await api('yot', teamId, `/locations?limit=200${search ? `&search=${encodeURIComponent(search)}` : ''}`) as { data: Row[] };
        setRows(Array.isArray(data?.data) ? data.data : []);
      } catch (e: any) {
        setError(e?.message || 'Failed to load locations');
      } finally { setLoading(false); }
    };

    const openDetail = async (id: string) => {
      if (!teamId) return;
      setSelectedId(id); setDetail(null); setDetailError(null); setDetailLoading(true); setPane('summary'); setRelatedStylists([]); setRelatedAppointments([]);
      try {
        const data = await api('yot', teamId, `/locations/${encodeURIComponent(id)}`) as Detail;
        setDetail(data);
      } catch (e: any) {
        setDetailError(e?.message || 'Failed to load location details');
      } finally { setDetailLoading(false); }
    };

    const openPane = async (nextPane: Pane) => {
      setPane(nextPane);
      if (!teamId || !selectedId || nextPane === 'summary' || nextPane === 'revenue') return;
      setPaneLoading(true);
      try {
        if (nextPane === 'stylists') {
          const res = await api('yot', teamId, `/stylists?limit=200&locationId=${encodeURIComponent(selectedId)}`) as { data: StylistRow[] };
          setRelatedStylists(Array.isArray(res?.data) ? res.data : []);
        }
        if (nextPane === 'appointments') {
          const res = await api('yot', teamId, `/appointments?limit=100&locationId=${encodeURIComponent(selectedId)}`) as { data: AppointmentRow[] };
          setRelatedAppointments(Array.isArray(res?.data) ? res.data : []);
        }
      } finally { setPaneLoading(false); }
    };

    useEffect(() => { if (teamId) void load(); else setLoading(false); }, [teamId, search]);

    if (!teamId) return h('div', { style: t.card }, h('div', { className: 'text-sm font-medium', style: t.text }, 'Locations Cache'), h('div', { className: 'mt-2 text-sm', style: t.danger }, 'No team context was provided to the YOT Locations tab.'));

    const relationships = detail?.relationships || null;
    const revenue = relationships?.revenue || null;
    const paneButton = (key: Pane, label: string, disabled = false) => h('button', { type: 'button', style: { ...t.btnGhost, opacity: disabled ? 0.55 : 1, cursor: disabled ? 'not-allowed' : 'pointer', borderColor: pane === key ? 'rgba(255,255,255,0.18)' : (t.btnGhost as any).border }, disabled, onClick: () => { if (!disabled) void openPane(key); } }, label);

    return h('div', { className: 'space-y-3' },
      h('div', { style: t.card },
        h('div', { className: 'flex items-start justify-between gap-2' },
          h('div', null,
            h('div', { className: 'text-sm font-medium', style: t.text }, 'Locations Cache'),
            h('div', { className: 'mt-1 text-xs', style: t.faint }, 'Search cached YOT locations and open linked relationship summaries from the local cache.')
          ),
          h('button', { type: 'button', onClick: () => void load(), style: t.btnGhost, disabled: loading }, loading ? 'Loading…' : '↻ Refresh')
        ),
        error && h('div', { className: 'mt-3 text-xs', style: t.danger }, error),
        h('div', { className: 'mt-3 flex gap-2' },
          h('input', { value: searchInput, onChange: (e: any) => setSearchInput(e.target.value), onKeyDown: (e: any) => { if (e.key === 'Enter') setSearch(searchInput); }, placeholder: 'Search by name, suburb, phone, or email', style: t.input }),
          h('button', { type: 'button', onClick: () => setSearch(searchInput), style: t.btnPrimary }, 'Search'),
          searchInput || search ? h('button', { type: 'button', onClick: () => { setSearchInput(''); setSearch(''); }, style: t.btnGhost }, 'Clear') : null
        )
      ),
      h('div', { style: t.card },
        h('div', { className: 'text-xs mb-3', style: t.faint }, `${rows.length} cached location${rows.length === 1 ? '' : 's'}`),
        h('div', { style: t.tableWrap },
          h('table', { style: t.table },
            h('thead', null, h('tr', null, h('th', { style: t.th }, 'Name'), h('th', { style: t.th }, 'Location'), h('th', { style: t.th }, 'Contact'), h('th', { style: t.th }, 'Active'), h('th', { style: t.th }, 'Synced'), h('th', { style: t.th }, 'Details'))),
            h('tbody', null,
              rows.length ? rows.map((row: Row) => h('tr', { key: row.id },
                h('td', { style: t.td }, h('div', { className: 'text-sm font-medium', style: t.text }, locationLabel(row)), h('div', { className: 'text-xs', style: t.faint }, row.id)),
                h('td', { style: t.td }, [row.suburb, row.state, row.postcode].filter(Boolean).join(', ') || '—'),
                h('td', { style: t.td }, h('div', null, row.businessPhone || row.mobilePhone || '—'), h('div', { className: 'text-xs', style: t.faint }, row.emailAddress || '—')),
                h('td', { style: t.td }, boolLabel(row.active, 'Active', 'Inactive')),
                h('td', { style: t.td }, formatDateTime(row.syncedAt)),
                h('td', { style: t.td }, h('button', { type: 'button', style: t.btnGhost, onClick: () => void openDetail(row.id) }, 'View'))
              )) : h('tr', null, h('td', { style: t.td, colSpan: 6 }, loading ? 'Loading locations…' : 'No cached locations found.'))
            )
          )
        )
      ),
      selectedId && modal(h, {
        title: detail?.name || 'Location details',
        subtitle: selectedId,
        onClose: () => { setSelectedId(null); setDetail(null); setDetailError(null); setPane('summary'); },
        width: '68rem',
        children: detailLoading ? h('div', { style: t.faint }, 'Loading location details…') : detailError ? h('div', { style: t.danger }, detailError) : detail ? h('div', { className: 'space-y-4' },
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem' } },
            paneButton('summary', 'Summary'),
            paneButton('stylists', `Stylists${relationships ? ` (${fmtNumber(relationships.uniqueStylistCount)})` : ''}`),
            paneButton('appointments', `Appointments${relationships ? ` (${fmtNumber(relationships.appointmentCount)})` : ''}`),
            paneButton('revenue', 'Revenue', !revenue?.available)
          ),
          pane === 'summary' ? h('div', { className: 'space-y-4' },
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' } },
              detailField('Name', fieldValue(detail.name)), detailField('Status', boolLabel(detail.active, 'Active', 'Inactive')), detailField('Can book online', boolLabel(detail.canBookOnline, 'Yes', 'No')), detailField('Business phone', fieldValue(detail.businessPhone)), detailField('Mobile phone', fieldValue(detail.mobilePhone)), detailField('Email', fieldValue(detail.emailAddress)), detailField('Address', joinAddress([detail.street, detail.suburb, detail.state, detail.postcode, detail.country])), detailField('Appointments', fmtNumber(relationships?.appointmentCount)), detailField('Unique stylists', fmtNumber(relationships?.uniqueStylistCount)), detailField('Unique clients', fmtNumber(relationships?.uniqueClientCount)), detailField('Recent 90d appointments', fmtNumber(relationships?.recentAppointmentCount)), detailField('Last appointment', relationships?.lastAppointmentAt ? formatDateTime(relationships.lastAppointmentAt) : '—'), detailField('Synced', formatDateTime(detail.syncedAt))
            ),
            relationships ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.75rem' } },
              h('div', { style: noteCard }, h('div', { style: detailLabel }, 'Top stylists'), ...(relationships.stylists.length ? relationships.stylists.map((item: Link) => h('div', { key: item.id, style: { ...detailValue, marginTop: '0.5rem' } }, `${item.label} • ${fmtNumber(item.appointmentCount)} appts`)) : [h('div', { style: detailValue }, 'No linked stylists found.')])),
              h('div', { style: noteCard }, h('div', { style: detailLabel }, 'Recent clients'), ...(relationships.clients.length ? relationships.clients.map((item: Link) => h('div', { key: item.id, style: { ...detailValue, marginTop: '0.5rem' } }, `${item.label} • ${fmtNumber(item.appointmentCount)} appts`)) : [h('div', { style: detailValue }, 'No linked clients found.')]))
            ) : null,
            h('div', { style: noteCard }, h('div', { style: detailLabel }, 'Raw record'), h('pre', { style: { ...detailValue, margin: 0, whiteSpace: 'pre-wrap' as const, fontSize: '0.78rem' } }, JSON.stringify(detail.raw, null, 2) || 'null'))
          ) : null,
          pane === 'stylists' ? h('div', { style: noteCard }, paneLoading ? 'Loading stylists…' : relatedStylists.length ? h('div', { style: t.tableWrap }, h('table', { style: t.table }, h('thead', null, h('tr', null, h('th', { style: t.th }, 'Stylist'), h('th', { style: t.th }, 'Contact'), h('th', { style: t.th }, 'Active'), h('th', { style: t.th }, 'Synced'))), h('tbody', null, ...relatedStylists.map((row: any) => h('tr', { key: row.id }, h('td', { style: t.td }, h('div', { className: 'text-sm font-medium', style: t.text }, row.fullName || [row.givenName, row.surname].filter(Boolean).join(' ') || 'Unnamed stylist'), h('div', { className: 'text-xs', style: t.faint }, row.privateId || row.id)), h('td', { style: t.td }, h('div', null, row.emailAddress || '—'), h('div', { className: 'text-xs', style: t.faint }, row.mobilePhone || '—')), h('td', { style: t.td }, boolLabel(row.active, 'Active', 'Inactive')), h('td', { style: t.td }, formatDateTime(row.syncedAt))))))) : 'No linked stylists found for this location.') : null,
          pane === 'appointments' ? h('div', { style: noteCard }, paneLoading ? 'Loading appointments…' : relatedAppointments.length ? h('div', { style: t.tableWrap }, h('table', { style: t.table }, h('thead', null, h('tr', null, h('th', { style: t.th }, 'When'), h('th', { style: t.th }, 'Client'), h('th', { style: t.th }, 'Stylist'), h('th', { style: t.th }, 'Service'), h('th', { style: t.th }, 'Status'))), h('tbody', null, ...relatedAppointments.map((row: any) => h('tr', { key: row.id }, h('td', { style: t.td }, row.startsAt ? formatDateTime(row.startsAt) : '—'), h('td', { style: t.td }, row.clientName || '—'), h('td', { style: t.td }, row.stylistName || '—'), h('td', { style: t.td }, row.serviceName || '—'), h('td', { style: t.td }, row.statusDescription || row.status || '—')))))) : 'No linked appointments found for this location.') : null,
          pane === 'revenue' ? h('div', { style: noteCard },
            revenue?.available ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' } }, detailField('Source', revenue.source), detailField('Gross', fmtCurrency(revenue.grossAmount)), detailField('Discounts', fmtCurrency(revenue.discountAmount)), detailField('Net', fmtCurrency(revenue.netAmount)), detailField('Appointments in revenue view', fmtNumber(revenue.appointmentCount)), detailField('Last updated', revenue.lastUpdatedAt ? formatDateTime(revenue.lastUpdatedAt) : '—')) : h('div', null, h('div', { className: 'text-sm font-medium', style: t.warning }, 'Revenue is not available from the current local cache yet.'), h('div', { className: 'mt-2 text-sm', style: t.text }, revenue?.note || 'No revenue facts or appointment money fields were available for this location.'))
          ) : null
        ) : h('div', { style: t.faint }, 'No location details loaded.')
      })
    );
  }

  (window as any).KitchenPlugin.registerTab('yot', 'locations', Locations);
})();
