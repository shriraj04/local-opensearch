// Sets up OpenSearch Dashboards the same way every time (safe to run again). Dashboards is the one page:
// it opens on the "ASTRA Local OpenSearch" home dashboard (health, links to every MNG-style trace search,
// the latest trace rows, the clear link), plus the nps-app-* index pattern used on mnops.cdmx.io and one
// saved search per MNG trace screen.

const COLUMNS = ['e_event', 'msg', 'level', 'uid', 'domain', 'p_key', 'p_value', 'entry_type'];
export const HOME_DASHBOARD = 'astra-local-opensearch';
const VERSION = '2.19.7';

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

const searchSource = (query, indexRef = true) =>
  JSON.stringify({ query: { query, language: 'kuery' }, filter: [], ...(indexRef ? { indexRefName: 'kibanaSavedObjectMeta.searchSourceJSON.index' } : {}) });

const search = ([id, title, query, columns = COLUMNS]) => ({
  type: 'search',
  id,
  attributes: { title, description: '', columns, sort: [['ts', 'desc']], version: 1, kibanaSavedObjectMeta: { searchSourceJSON: searchSource(query) } },
  references: [{ name: 'kibanaSavedObjectMeta.searchSourceJSON.index', type: 'index-pattern', id: 'nps-app' }],
});

/** A big-number panel over the shipper's health document (index astra-shipper-health, one doc). */
const metric = (id, title, fields) => ({
  type: 'visualization',
  id,
  attributes: {
    title,
    description: '',
    uiStateJSON: '{}',
    version: 1,
    visState: JSON.stringify({
      title,
      type: 'metric',
      aggs: fields.map(([field, label], i) => ({ id: String(i + 1), enabled: true, type: 'max', schema: 'metric', params: { field, customLabel: label } })),
      params: {
        addTooltip: true,
        addLegend: false,
        type: 'metric',
        metric: {
          percentageMode: false,
          useRanges: false,
          colorSchema: 'Green to Red',
          metricColorMode: 'None',
          colorsRange: [{ from: 0, to: 10000 }],
          labels: { show: true },
          invertColors: false,
          style: { bgFill: '#000', bgColor: false, labelColor: false, subText: '', fontSize: 28 },
        },
      },
    }),
    kibanaSavedObjectMeta: { searchSourceJSON: searchSource('') },
  },
  references: [{ name: 'kibanaSavedObjectMeta.searchSourceJSON.index', type: 'index-pattern', id: 'astra-shipper-health' }],
});

const markdown = (id, title, text) => ({
  type: 'visualization',
  id,
  attributes: {
    title,
    description: '',
    uiStateJSON: '{}',
    version: 1,
    visState: JSON.stringify({ title, type: 'markdown', aggs: [], params: { markdown: text, fontSize: 12, openLinksInNewTab: false } }),
    kibanaSavedObjectMeta: { searchSourceJSON: searchSource('', false) },
  },
  references: [],
});

function guide({ retentionDays, clearUrl }) {
  const open = (id) => `/app/discover#/view/${id}`;
  const keep = retentionDays ? `the last **${retentionDays} days**` : '**everything**';
  return `### ASTRA Local OpenSearch

Log lines from your local ASTRA (portals + n8n, via Redis \`nps-logs\`), like \`nps-app-*\` on mnops. Keeps ${keep}; older days go by themselves.

**Open a search** (the same filters as the MNG screens):

- [MNG Transaction Trace](${open('mng-transaction-trace')})
- [MNG Transaction Notes](${open('mng-transaction-notes')})
- [MNG Account Trace](${open('mng-account-trace')})
- [MNG Internal Notes report](${open('mng-internal-notes')})
- [WL-MNG Transaction Trace](${open('wl-mng-transaction-trace')})
- [Errors](${open('errors')}) · [n8n workflows](${open('n8n-workflows')}) · [Everything](/app/data-explorer/discover)

For one transaction, add \`and p_value:"189444"\` to the query bar (account: the account id).

**Health:** *Health updated* should be under a minute ago and *Waiting to be shipped* 0. Otherwise run \`npm run doctor\`.

**Free disk space:** [Clear all trace data](${clearUrl}). It asks first; new log lines keep coming in.`;
}

export async function setupDashboards(base, { retentionDays = 5, clearUrl = 'http://127.0.0.1:9700/clear' } = {}) {
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

  const panels = [
    ['home-guide', 'visualization', { x: 0, y: 0, w: 20, h: 22 }],
    ['home-health', 'visualization', { x: 20, y: 0, w: 28, h: 11 }],
    ['home-times', 'visualization', { x: 20, y: 11, w: 28, h: 11 }],
    ['mng-transaction-trace', 'search', { x: 0, y: 22, w: 48, h: 20 }],
  ];
  const home = {
    type: 'dashboard',
    id: HOME_DASHBOARD,
    attributes: {
      title: 'ASTRA Local OpenSearch',
      description: 'Home: health, trace searches and the latest MNG Transaction Trace rows',
      panelsJSON: JSON.stringify(
        panels.map(([, , grid], i) => ({ version: VERSION, gridData: { ...grid, i: String(i + 1) }, panelIndex: String(i + 1), embeddableConfig: {}, panelRefName: `panel_${i}` })),
      ),
      optionsJSON: JSON.stringify({ hidePanelTitles: false, useMargins: true }),
      // opens on the last 7 days and refreshes itself every 30 s, so the health numbers stay current
      timeRestore: true,
      timeFrom: 'now-7d',
      timeTo: 'now',
      refreshInterval: { pause: false, value: 30000 },
      version: 1,
      kibanaSavedObjectMeta: { searchSourceJSON: searchSource('', false) },
    },
    references: panels.map(([id, type], i) => ({ name: `panel_${i}`, type, id })),
  };

  const objects = [
    { type: 'index-pattern', id: 'nps-app', attributes: { title: 'nps-app-*', timeFieldName: '@timestamp', ...(await fieldsOf('nps-app-*')) } },
    {
      type: 'index-pattern',
      id: 'astra-shipper-rejected',
      attributes: { title: 'astra-shipper-rejected', timeFieldName: '@timestamp', ...(await fieldsOf('astra-shipper-rejected')) },
    },
    // no time field: the health document is always shown, whatever the time picker says
    { type: 'index-pattern', id: 'astra-shipper-health', attributes: { title: 'astra-shipper-health', ...(await fieldsOf('astra-shipper-health')) } },
    ...SEARCHES.map(search),
    markdown('home-guide', 'How to use', guide({ retentionDays, clearUrl })),
    metric('home-health', 'Health', [
      ['waiting', 'Waiting to be shipped'],
      ['kept', 'Log lines kept'],
      ['data_mb', 'Trace data on disk (MB)'],
      ['rejected', 'Rejected by OpenSearch'],
    ]),
    metric('home-times', 'Times', [
      ['updated_at', 'Health updated'],
      ['newest_entry', 'Newest log line'],
      ['kept_from', 'Kept since'],
    ]),
    home,
  ];
  const created = await post('/api/saved_objects/_bulk_create?overwrite=true', objects);
  const errors = created.saved_objects.filter((o) => o.error);
  if (errors.length) throw new Error(`Dashboards refused: ${errors.map((o) => `${o.id} ${o.error.message}`).join('; ')}`);

  await post('/api/opensearch-dashboards/settings', {
    changes: {
      defaultIndex: 'nps-app',
      defaultRoute: `/app/dashboards#/view/${HOME_DASHBOARD}`,
      'timepicker:timeDefaults': JSON.stringify({ from: 'now-7d', to: 'now' }),
      'discover:sort:defaultOrder': 'desc',
      'home:useNewHomePage': false,
    },
  });
}
