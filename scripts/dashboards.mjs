// Sets up OpenSearch Dashboards the same way every time (safe to run again): the nps-app-* index
// pattern used on mnops.cdmx.io, one saved search per MNG trace screen, and friendlier defaults.

const COLUMNS = ['e_event', 'msg', 'level', 'uid', 'domain', 'p_key', 'p_value', 'entry_type'];

const SEARCHES = [
  ['mng-transaction-trace', 'MNG Transaction Trace (add: and p_value:"<tx id>")', 'p_key:"TRANSACTION" and entry_type:("TRACE" or "NOTE")'],
  ['mng-transaction-notes', 'MNG Transaction Notes (add: and p_value:"<tx id>")', 'entry_type:"NOTE"'],
  ['mng-account-trace', 'MNG Account Trace (add: and p_value:"<account id>")', 'p_key:"ACCOUNT" and entry_type:"TRACE"'],
  ['mng-internal-notes', 'MNG Internal Notes report (is_note:true)', 'is_note:true', ['t_id', 'uid', 'aux.post.note', 'msg', 'domain']],
  ['wl-mng-transaction-trace', 'WL-MNG Transaction Trace (add: and t_id:"<tx id>")', 't_id:*'],
  ['everything-for-a-transaction', 'Everything for one transaction (edit the id)', 't_id:"189444" or p_value:"189444"', ['e_event', 'msg', 'level', 'domain', 'e_type', 'p_key', 'p_value', 't_id']],
  ['errors', 'Errors (level ERROR / CRITICAL)', 'level:("ERROR" or "CRITICAL")', ['e_event', 'msg', 'error_code', 'e_type', 'domain', 'uid']],
  ['n8n-workflows', 'n8n workflows (nps-api)', 'domain:"nps-api.local"', ['e_event', 'msg', 'level', 'e_type', 't_id', 'e_id']],
];

const search = ([id, title, query, columns = COLUMNS]) => ({
  type: 'search',
  id,
  attributes: {
    title,
    description: '',
    columns,
    sort: [['ts', 'desc']],
    version: 1,
    kibanaSavedObjectMeta: {
      searchSourceJSON: JSON.stringify({
        query: { query, language: 'kuery' },
        filter: [],
        indexRefName: 'kibanaSavedObjectMeta.searchSourceJSON.index',
      }),
    },
  },
  references: [{ name: 'kibanaSavedObjectMeta.searchSourceJSON.index', type: 'index-pattern', id: 'nps-app' }],
});

export async function setupDashboards(base) {
  const headers = { 'content-type': 'application/json', 'osd-xsrf': 'true' };
  const post = async (path, body) => {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Dashboards ${path}: ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };

  // With its field list stored, Discover does not try to save the index pattern on first load (several
  // tabs/panels doing that at once end in 409 Conflict). No indices yet → no list; Dashboards fetches it later.
  const fieldsOf = async (pattern) => {
    const meta = ['_source', '_id', '_type', '_index', '_score'].map((m) => `meta_fields=${m}`).join('&');
    const res = await fetch(`${base}/api/index_patterns/_fields_for_wildcard?pattern=${encodeURIComponent(pattern)}&${meta}`, { headers });
    if (!res.ok) return {};
    return { fields: JSON.stringify((await res.json()).fields) };
  };
  const objects = [
    { type: 'index-pattern', id: 'nps-app', attributes: { title: 'nps-app-*', timeFieldName: '@timestamp', ...(await fieldsOf('nps-app-*')) } },
    {
      type: 'index-pattern',
      id: 'astra-shipper-rejected',
      attributes: { title: 'astra-shipper-rejected', timeFieldName: '@timestamp', ...(await fieldsOf('astra-shipper-rejected')) },
    },
    ...SEARCHES.map(search),
  ];
  const created = await post('/api/saved_objects/_bulk_create?overwrite=true', objects);
  const errors = created.saved_objects.filter((o) => o.error);
  if (errors.length) throw new Error(`Dashboards refused: ${errors.map((o) => `${o.id} ${o.error.message}`).join('; ')}`);

  await post('/api/opensearch-dashboards/settings', {
    changes: {
      defaultIndex: 'nps-app',
      defaultRoute: '/app/data-explorer/discover',
      'timepicker:timeDefaults': JSON.stringify({ from: 'now-7d', to: 'now' }),
      'discover:sort:defaultOrder': 'desc',
      'home:useNewHomePage': false,
    },
  });
}
