// Runs a trace lookup exactly as the MNG / WL-MNG API does it: the product's own
// opensearch-query.js (mounted read-only from the checked-out repo) with the options of the
// opensearch-query step in the product's own action file. If a branch changes the query, this follows.
//
// Only the Wappler expressions those steps use are understood; anything else is refused rather than
// guessed, so a result here never silently differs from what MNG would get.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = process.env.ASTRA_MOUNT || '/astra';

export const LOOKUPS = {
  'tx-trace': {
    label: 'Transaction Trace',
    where: 'MNG › Transactions › Transaction Trace',
    action: 'mng/app/api/transactions/os_logs.json',
    params: ['tx_id'],
    dql: ({ tx_id }) => `p_key:"TRANSACTION" and p_value:"${tx_id}" and entry_type:("TRACE" or "NOTE")`,
  },
  'tx-notes': {
    label: 'Transaction Notes',
    where: 'MNG › Transactions › Notes',
    action: 'mng/app/api/transactions/notes.json',
    params: ['tx_id'],
    dql: ({ tx_id }) => `p_value:"${tx_id}" and entry_type:"NOTE"`,
  },
  'account-trace': {
    label: 'Account Trace',
    where: 'MNG › Accounts & Users › Accounts › Account Trace',
    action: 'mng/app/api/user_accounts/os_logs.json',
    params: ['account_id'],
    dql: ({ account_id }) => `p_key:"ACCOUNT" and p_value:"${account_id}" and entry_type:"TRACE"`,
  },
  'internal-notes': {
    label: 'Internal Notes report',
    where: 'MNG › Reports › Internal Notes',
    action: 'mng/app/api/reports/internal-notes/list.json',
    params: ['from_date', 'to_date'],
    dql: () => 'is_note:true',
  },
  'wl-tx-trace': {
    label: 'WL-MNG Transaction Trace',
    where: 'WL-MNG › Transactions › Transaction Trace',
    action: 'wl-mng/app/api/transactions/os_logs.json',
    params: ['tx_id'],
    dql: ({ tx_id }) => `t_id:"${tx_id}"`,
  },
};

function findStep(node) {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findStep(item);
      if (hit) return hit;
    }
  } else if (node && typeof node === 'object') {
    if (node.module === 'opensearch-query' && node.action === 'ops_query') return node;
    for (const value of Object.values(node)) {
      const hit = findStep(value);
      if (hit) return hit;
    }
  }
  return null;
}

function stepNames(node, names = new Set()) {
  if (Array.isArray(node)) node.forEach((item) => stepNames(item, names));
  else if (node && typeof node === 'object') {
    if (typeof node.name === 'string' && node.name) names.add(node.name);
    Object.values(node).forEach((value) => stepNames(value, names));
  }
  return names;
}

class Unsupported extends Error {}

/** Evaluates the small set of Wappler expressions found in the opensearch-query steps. */
export function makeParser(get, names) {
  const evalExpr = (expr) => {
    let m;
    if ((m = expr.match(/^\$_GET\.(\w+)$/))) return get[m[1]];
    if ((m = expr.match(/^\$_GET\.(\w+)\.toUTCTime\(\)$/))) {
      const value = get[m[1]];
      if (value === undefined || value === null || value === '') return value;
      const date = new Date(value); // the MNG container runs in UTC, like this one
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    if ((m = expr.match(/^\$_ENV\.(\w+)$/))) return process.env[m[1]];
    if ((m = expr.match(/^\[(.*)\]$/s))) {
      return m[1]
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const s = part.match(/^'(.*)'$|^"(.*)"$/s);
          if (!s) throw new Unsupported(`array item ${part}`);
          return s[1] ?? s[2];
        });
    }
    if ((m = expr.match(/^[A-Za-z_]\w*$/))) {
      // An unbound name is undefined in Wappler (e.g. notes.json's p_key "{{TRANSACTION}}").
      if (names.has(expr)) throw new Unsupported(`{{${expr}}} refers to a step output`);
      return undefined;
    }
    throw new Unsupported(`{{${expr}}}`);
  };
  return (value) => {
    if (typeof value !== 'string') return value;
    const m = value.match(/^\{\{(.*)\}\}$/s);
    if (m) return evalExpr(m[1].trim());
    if (value.includes('{{')) throw new Unsupported(value);
    return value;
  };
}

export async function runLookup(kind, params) {
  const lookup = LOOKUPS[kind];
  if (!lookup) throw new Error(`unknown lookup "${kind}"`);
  for (const p of lookup.params) {
    if (params[p] === undefined || params[p] === '') throw new Error(`${p} is required`);
  }
  const actionFile = path.join(REPO, lookup.action);
  const action = JSON.parse(fs.readFileSync(actionFile, 'utf8'));
  const step = findStep(action);
  if (!step) throw new Error(`no opensearch-query step in ${lookup.action}`);

  const app = lookup.action.split('/')[0];
  const moduleFile = path.join(REPO, app, 'extensions/server_connect/modules/opensearch-query.js');
  delete require.cache[require.resolve(moduleFile)];
  const { ops_query: opsQuery } = require(moduleFile);

  const parse = makeParser(params, stepNames(action));
  const started = Date.now();
  let rows;
  try {
    rows = await opsQuery.call({ parse }, step.options);
  } catch (err) {
    if (err instanceof Unsupported) throw new Error(`cannot reproduce this step's options: ${err.message}`);
    throw err;
  }
  return {
    kind,
    label: lookup.label,
    where: lookup.where,
    action_file: lookup.action,
    module_file: `${app}/extensions/server_connect/modules/opensearch-query.js`,
    step_options: step.options,
    params,
    dql: lookup.dql(params),
    took_ms: Date.now() - started,
    count: rows.length,
    rows,
  };
}
