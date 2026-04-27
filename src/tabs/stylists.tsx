import { api, boolLabel, fieldValue, fmtNumber, formatDateTime, loadCacheMeta, modal, parseRawJson, readLinkedViewParams, renderCacheSummaryCards, t, useEscapeToClose } from './common';

(function () {
  const R = (window as any).React;
  if (!R) return;
  const h = R.createElement;
  const useEffect = R.useEffect as typeof R.useEffect;
  const useState = R.useState as (initial: any) => [any, (value: any) => void];

  type Link = { id: string; label: string; appointmentCount: number; lastAppointmentAt: string | null };
  type LocationOption = { id: string; name: string | null };
  type LocationDetail = { id: string; name: string | null; suburb: string | null; state: string | null; postcode: string | null; active: boolean | null; syncedAt: string };
  type Row = { id: string; locationId: string | null; privateId: string | null; givenName: string | null; surname: string | null; fullName: string | null; emailAddress: string | null; mobilePhone: string | null; active: boolean | null; sourceLocationId: string | null; syncedAt: string };
  type Detail = Row & { serviceCategoryNames?: string[]; serviceNames?: string[]; relationships?: { appointmentCount: number; uniqueClientCount: number; uniqueLocationCount: number; recentAppointmentCount: number; lastAppointmentAt: string | null; clients: Link[]; locations: Link[] } | null; raw: unknown | null };
  const select = { ...({} as any), background: 'rgba(255,255,255,0.03)', border: '1px solid var(--ck-border-subtle)', borderRadius: '10px', padding: '0.5rem 0.6rem', color: 'var(--ck-text-primary)', fontSize: '0.8rem', minWidth: '10rem' };
  const noteCard = { background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '10px', padding: '0.75rem' };
  const detailLabel = { fontSize: '0.72rem', color: 'var(--ck-text-tertiary)', textTransform: 'uppercase' as const, letterSpacing: '0.04em' };
  const detailValue = { marginTop: '0.2rem', color: 'var(--ck-text-primary)', fontSize: '0.9rem', lineHeight: 1.4, wordBreak: 'break-word' as const };

  function Stylists(props: any) {
    const incoming = readLinkedViewParams(props);
    const teamId = typeof props?.teamId === 'string' && props.teamId.trim() ? props.teamId.trim() : (incoming.teamId || null);
    const [rows, setRows] = useState([] as Row[]);
    const [locations, setLocations] = useState([] as LocationOption[]);
    const [searchInput, setSearchInput] = useState(incoming.search || incoming.stylistId || incoming.clientId || '');
    const [search, setSearch] = useState(incoming.search || '');
    const [locationId, setLocationId] = useState(incoming.locationId || '');
    const [stylistId, setStylistId] = useState(incoming.stylistId || '');
    const [clientId, setClientId] = useState(incoming.clientId || '');
    const [activeFilter, setActiveFilter] = useState('all');
    const [syncState, setSyncState] = useState(null as any);
    const [latestRun, setLatestRun] = useState(null as any);
    const [totalRows, setTotalRows] = useState(null as number | null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null as string | null);
    const [selectedId, setSelectedId] = useState(null as string | null);
    const [detail, setDetail] = useState(null as Detail | null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [detailError, setDetailError] = useState(null as string | null);
    const [linkedLocation, setLinkedLocation] = useState(null as LocationDetail | null);

    useEscapeToClose(R, !!selectedId, () => { setSelectedId(null); setDetail(null); setDetailError(null); setLinkedLocation(null); });

    const displayName = (row: Row | Detail) => row.fullName || [row.givenName, row.surname].filter(Boolean).join(' ').trim() || 'Unnamed stylist';
    const locationName = (id: string | null) => !id ? '—' : (locations.find((loc: LocationOption) => String(loc.id) === String(id))?.name || id);
    const detailField = (label: string, value: any) => h('div', { key: label, style: noteCard }, h('div', { style: detailLabel }, label), h('div', { style: detailValue }, value));

    const openDetail = async (id: string) => {
      if (!teamId) return;
      setSelectedId(id); setDetail(null); setDetailError(null); setDetailLoading(true); setLinkedLocation(null);
      try {
        const data = await api('yot', teamId, `/stylists/${encodeURIComponent(id)}`) as Detail;
        setDetail({ ...data, raw: parseRawJson(data?.raw) });
      } catch (e: any) { setDetailError(e?.message || 'Failed to load stylist details'); } finally { setDetailLoading(false); }
    };

    const openLinkedLocation = async (id: string | null) => {
      if (!teamId || !id) return;
      const data = await api('yot', teamId, `/locations/${encodeURIComponent(id)}`) as LocationDetail;
      setLinkedLocation(data);
    };

    const load = async () => {
      if (!teamId) return;
      setLoading(true); setError(null);
      try {
        const query: string[] = ['limit=200'];
        if (search) query.push(`search=${encodeURIComponent(search)}`);
        if (locationId) query.push(`locationId=${encodeURIComponent(locationId)}`);
        if (stylistId) query.push(`stylistId=${encodeURIComponent(stylistId)}`);
        if (clientId) query.push(`clientId=${encodeURIComponent(clientId)}`);
        if (activeFilter === 'active') query.push('active=true'); else if (activeFilter === 'inactive') query.push('active=false');
        const [stylistsRes, locationsRes, meta] = await Promise.all([
          api('yot', teamId, `/stylists?${query.join('&')}`) as Promise<{ data: Row[] }>,
          api('yot', teamId, '/locations?limit=500') as Promise<{ data: LocationOption[] }>,
          loadCacheMeta(teamId, 'stylists'),
        ]);
        setRows(Array.isArray(stylistsRes?.data) ? stylistsRes.data : []);
        setLocations(Array.isArray(locationsRes?.data) ? locationsRes.data : []);
        setSyncState(meta.syncState);
        setLatestRun(meta.latestRun);
        setTotalRows(meta.totalRows);
      } catch (e: any) { setError(e?.message || 'Failed to load stylists'); } finally { setLoading(false); }
    };

    useEffect(() => { if (teamId) void load(); else setLoading(false); }, [teamId, search, locationId, activeFilter]);
    if (!teamId) return h('div', { style: t.card }, h('div', { className: 'text-sm font-medium', style: t.text }, 'Stylists Cache'), h('div', { className: 'mt-2 text-sm', style: t.danger }, 'No team context was provided to the YOT Stylists tab.'));

    return h('div', { className: 'space-y-3' },
      h('div', { style: t.card },
        h('div', { className: 'flex items-start justify-between gap-2' }, h('div', null, h('div', { className: 'text-sm font-medium', style: t.text }, 'Stylists Cache'), h('div', { className: 'mt-1 text-xs', style: t.faint }, 'Cached stylists/staff records with linked locations and relationship summaries.')), h('button', { type: 'button', onClick: () => void load(), style: t.btnGhost, disabled: loading }, loading ? 'Loading…' : '↻ Refresh')),
        error && h('div', { className: 'mt-3 text-xs', style: t.danger }, error),
        renderCacheSummaryCards(h, { syncState, latestRun, totalRows, emptyLatestRunText: 'No stylist sync runs recorded yet.' }),
        h('div', { className: 'mt-3 flex gap-2' }, h('input', { value: searchInput, onChange: (e: any) => setSearchInput(e.target.value), onKeyDown: (e: any) => { if (e.key === 'Enter') setSearch(searchInput); }, placeholder: 'Search stylist name, email, phone, or private ID', style: t.input }), h('button', { type: 'button', onClick: () => setSearch(searchInput), style: t.btnPrimary }, 'Search'), searchInput || search ? h('button', { type: 'button', onClick: () => { setSearchInput(''); setSearch(''); }, style: t.btnGhost }, 'Clear') : null),
        (locationId || stylistId || clientId) ? h('div', { className: 'mt-3 text-xs', style: t.faint }, `Linked scope • ${[locationId ? `location=${locationId}` : '', stylistId ? `stylist=${stylistId}` : '', clientId ? `client=${clientId}` : ''].filter(Boolean).join(' • ')}`) : null,
        h('div', { className: 'mt-3', style: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' } },
          h('select', { value: locationId, onChange: (e: any) => setLocationId(e.target.value), style: select }, h('option', { value: '' }, 'All locations'), ...locations.map((loc: LocationOption) => h('option', { key: loc.id, value: String(loc.id) }, loc.name || `Location ${loc.id}`))),
          h('select', { value: activeFilter, onChange: (e: any) => setActiveFilter(e.target.value), style: select }, h('option', { value: 'all' }, 'Active & inactive'), h('option', { value: 'active' }, 'Active only'), h('option', { value: 'inactive' }, 'Inactive only'))
        )
      ),
      h('div', { style: t.card }, rows.length ? h('div', { style: t.tableWrap }, h('table', { style: t.table }, h('thead', null, h('tr', null, h('th', { style: t.th }, 'Stylist'), h('th', { style: t.th }, 'Location'), h('th', { style: t.th }, 'Contact'), h('th', { style: t.th }, 'Active'), h('th', { style: t.th }, 'Synced'), h('th', { style: t.th }, 'Details'))), h('tbody', null, ...rows.map((row: any) => h('tr', { key: row.id }, h('td', { style: t.td }, h('div', { className: 'text-sm font-medium', style: t.text }, displayName(row)), h('div', { className: 'text-xs', style: t.faint }, row.privateId || row.id)), h('td', { style: t.td }, h('div', null, locationName(row.locationId || row.sourceLocationId)), (row.locationId || row.sourceLocationId) ? h('div', { className: 'mt-2' }, h('button', { type: 'button', style: { ...t.btnGhost, padding: '0.35rem 0.55rem' }, onClick: () => void openLinkedLocation(row.locationId || row.sourceLocationId) }, 'Open location')) : null), h('td', { style: t.td }, h('div', null, row.emailAddress || '—'), h('div', { className: 'text-xs', style: t.faint }, row.mobilePhone || '—')), h('td', { style: t.td }, boolLabel(row.active, 'Active', 'Inactive')), h('td', { style: t.td }, formatDateTime(row.syncedAt)), h('td', { style: t.td }, h('button', { type: 'button', style: t.btnGhost, onClick: () => void openDetail(row.id) }, 'View')))))) ) : h('div', null, h('div', { className: 'text-sm font-medium', style: t.text }, loading ? 'Loading stylists…' : 'No cached stylists found.'))),
      selectedId && modal(h, { title: detail ? displayName(detail) : 'Stylist details', subtitle: selectedId, onClose: () => { setSelectedId(null); setDetail(null); setDetailError(null); setLinkedLocation(null); }, width: '64rem', children: detailLoading ? h('div', { style: t.faint }, 'Loading stylist details…') : detailError ? h('div', { style: t.danger }, detailError) : detail ? h('div', { className: 'space-y-4' },
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' } }, detailField('Full name', displayName(detail)), detailField('Stylist ID', fieldValue(detail.privateId)), detailField('Record ID', fieldValue(detail.id)), detailField('Given name', fieldValue(detail.givenName)), detailField('Surname', fieldValue(detail.surname)), detailField('Email', fieldValue(detail.emailAddress)), detailField('Mobile phone', fieldValue(detail.mobilePhone)), detailField('Linked location', h('div', null, h('div', null, locationName(detail.locationId || detail.sourceLocationId)), (detail.locationId || detail.sourceLocationId) ? h('div', { className: 'mt-2' }, h('button', { type: 'button', style: { ...t.btnGhost, padding: '0.35rem 0.55rem' }, onClick: () => void openLinkedLocation(detail.locationId || detail.sourceLocationId) }, 'View location')) : null)), detailField('Appointments', fmtNumber(detail.relationships?.appointmentCount)), detailField('Unique clients', fmtNumber(detail.relationships?.uniqueClientCount)), detailField('Recent 90d appointments', fmtNumber(detail.relationships?.recentAppointmentCount)), detailField('Last appointment', detail.relationships?.lastAppointmentAt ? formatDateTime(detail.relationships.lastAppointmentAt) : '—'), detailField('Status', boolLabel(detail.active, 'Active', 'Inactive')), detailField('Synced', formatDateTime(detail.syncedAt))),
        detail.relationships ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.75rem' } },
          h('div', { style: noteCard }, h('div', { style: detailLabel }, 'Known clients'), ...(detail.relationships.clients.length ? detail.relationships.clients.map((item: Link) => h('div', { key: item.id, style: { ...detailValue, marginTop: '0.5rem' } }, `${item.label} • ${fmtNumber(item.appointmentCount)} appts`)) : [h('div', { style: detailValue }, 'No linked clients found.')])),
          h('div', { style: noteCard }, h('div', { style: detailLabel }, 'Known locations'), ...(detail.relationships.locations.length ? detail.relationships.locations.map((item: Link) => h('div', { key: item.id, style: { ...detailValue, marginTop: '0.5rem' } }, h('span', null, `${item.label} • ${fmtNumber(item.appointmentCount)} appts `), h('button', { type: 'button', style: { ...t.btnGhost, padding: '0.25rem 0.45rem', marginLeft: '0.5rem' }, onClick: () => void openLinkedLocation(item.id) }, 'Open'))) : [h('div', { style: detailValue }, 'No linked locations found.')]))
        ) : null,
        detail.serviceNames?.length ? h('div', { style: noteCard }, h('div', { style: detailLabel }, 'Services'), h('div', { style: detailValue }, detail.serviceNames.join(', '))) : null,
        linkedLocation ? h('div', { style: { ...noteCard, borderColor: 'rgba(255,255,255,0.14)' } }, h('div', { style: detailLabel }, 'Linked location preview'), h('div', { style: detailValue }, h('div', { className: 'text-sm font-medium', style: t.text }, linkedLocation.name || linkedLocation.id), h('div', { className: 'mt-1 text-xs', style: t.faint }, [linkedLocation.suburb, linkedLocation.state, linkedLocation.postcode].filter(Boolean).join(', ') || '—'), h('div', { className: 'mt-1 text-xs', style: t.faint }, `${boolLabel(linkedLocation.active, 'Active', 'Inactive')} • synced ${formatDateTime(linkedLocation.syncedAt)}`))) : null,
        h('div', { style: noteCard }, h('div', { style: detailLabel }, 'Raw record'), h('pre', { style: { ...detailValue, margin: 0, whiteSpace: 'pre-wrap' as const, fontSize: '0.78rem' } }, JSON.stringify(detail.raw, null, 2) || 'null'))
      ) : h('div', { style: t.faint }, 'No stylist details loaded.') })
    );
  }

  (window as any).KitchenPlugin.registerTab('yot', 'stylists', Stylists);
})();
