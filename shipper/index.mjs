// Ships the ASTRA log list (Redis `nps-logs`) into the local OpenSearch, the way the remote
// shipper fills nps-app-* on mnops.cdmx.io: every entry as it is, plus @timestamp, into a monthly
// index nps-app-YYYY.MM.
//
// Read-only on Redis: LLEN / LINDEX / LRANGE, never LPOP. The Redis Log Viewer and anything else
// reading the list keep working. Re-reading the list is harmless: every entry has a fixed _id, so an
// entry already in OpenSearch is skipped (409), never duplicated.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Redis from 'ioredis';
import { LOOKUPS, runLookup } from './mng-query.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

export const config = {
  redisHost: env.REDIS_HOST || 'nps_redis',
  redisPort: Number(env.REDIS_PORT || 6379),
  redisDb: Number(env.REDIS_DB || 0),
  listKey: env.LOG_REDIS_KEY || 'nps-logs',
  opensearchUrl: (env.OPENSEARCH_URL || 'http://astra-opensearch:9200').replace(/\/+$/, ''),
  indexPrefix: env.INDEX_PREFIX || 'nps-app-',
  rejectIndex: env.REJECT_INDEX || 'astra-shipper-rejected',
  templateName: 'nps-app',
  batchSize: Number(env.BATCH_SIZE || 500),
  maxBatchBytes: Number(env.MAX_BATCH_BYTES || 8 * 1024 * 1024),
  pollMs: Number(env.POLL_MS || 250),
  // An entry read within this long of its own ts is "live": @timestamp is the time it was shipped,
  // like remote (about 0.1 s after ts). An older one is backlog: @timestamp = ts.
  liveWindowMs: Number(env.LIVE_WINDOW_MS || 5000),
  // Two byte-identical entries are both kept, as remote keeps both: the n-th copy within this many
  // entries gets its own _id.
  dupWindow: Number(env.DUP_WINDOW || 2000),
  statusPort: Number(env.STATUS_PORT || 9700),
};

const log = (...args) => console.log(new Date().toISOString(), ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha1 = (text) => crypto.createHash('sha1').update(text).digest();

// ---------- turning one Redis entry into one OpenSearch document ----------

export function monthIndex(prefix, ms) {
  const d = new Date(ms);
  return `${prefix}${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Fixed, remote-looking (20 chars, base64url) id: the same entry always gets the same id. */
export function docId(raw, copyNumber) {
  return sha1(`${copyNumber}\u0000${raw}`).toString('base64url').slice(0, 20);
}

/** Counts earlier byte-identical entries within the last `size` entries, in list order. */
export class CopyCounter {
  constructor(size) {
    this.size = size;
    this.ring = [];
    this.counts = new Map();
  }
  next(raw) {
    const key = sha1(raw).toString('hex');
    const copy = this.counts.get(key) || 0;
    this.counts.set(key, copy + 1);
    this.ring.push(key);
    if (this.ring.length > this.size) {
      const old = this.ring.shift();
      const left = this.counts.get(old) - 1;
      if (left) this.counts.set(old, left);
      else this.counts.delete(old);
    }
    return copy;
  }
  clear() {
    this.ring = [];
    this.counts.clear();
  }
  /** Saved before a batch and put back when it fails, so a retried entry keeps its copy number (and _id). */
  snapshot() {
    return { ring: this.ring.slice(), counts: new Map(this.counts) };
  }
  restore(saved) {
    this.ring = saved.ring;
    this.counts = saved.counts;
  }
}

/**
 * The document body is the entry's own JSON text with "@timestamp" put in front, so every value
 * reaches OpenSearch exactly as written (large integers included).
 * Returns { ok:true, index, body } or { ok:false, reason } for an entry that is not a JSON object.
 */
export function toDocument(raw, nowMs, cfg = config) {
  let entry;
  try {
    entry = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `not JSON: ${err.message}` };
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, reason: 'not a JSON object' };
  }
  const tsMs = Date.parse(entry.ts);
  const hasTs = Number.isFinite(tsMs);
  const index = monthIndex(cfg.indexPrefix, hasTs ? tsMs : nowMs);
  // A line break in valid JSON can only be whitespace between tokens (inside a string it must be
  // escaped), so folding it keeps the entry identical while keeping the bulk body one line per doc.
  const oneLine = raw.trim().replace(/[\r\n\u2028\u2029]+/g, ' ');
  if (Object.prototype.hasOwnProperty.call(entry, '@timestamp')) {
    return { ok: true, index, body: oneLine };
  }
  const live = !hasTs || Math.abs(nowMs - tsMs) <= cfg.liveWindowMs;
  const stamp = JSON.stringify(live ? new Date(nowMs).toISOString() : entry.ts);
  const rest = oneLine.slice(1).trimStart();
  const body = rest.startsWith('}') ? `{"@timestamp":${stamp}}` : `{"@timestamp":${stamp},${rest}`;
  return { ok: true, index, body };
}

// ---------- OpenSearch ----------

async function os(method, urlPath, body, contentType = 'application/json') {
  const res = await fetch(`${config.opensearchUrl}${urlPath}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': contentType },
    body,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}

async function ensureIndexSetup() {
  for (const [name, file] of [
    [config.templateName, 'index-template.json'],
    [`${config.templateName}-fallback`, 'index-template-fallback.json'],
  ]) {
    const template = fs.readFileSync(path.join(HERE, file), 'utf8');
    const put = await os('PUT', `/_index_template/${name}`, template);
    if (put.status !== 200) throw new Error(`index template ${name} not accepted (${put.status}): ${put.text.slice(0, 300)}`);
  }

  const head = await os('HEAD', `/${config.rejectIndex}`);
  if (head.status === 404) {
    const created = await os(
      'PUT',
      `/${config.rejectIndex}`,
      JSON.stringify({
        settings: { 'index.number_of_shards': 1, 'index.number_of_replicas': 0 },
        mappings: {
          dynamic: false,
          properties: {
            '@timestamp': { type: 'date' },
            target_index: { type: 'keyword' },
            target_id: { type: 'keyword' },
            list_index: { type: 'long' },
            reason: { type: 'text' },
            raw_bytes: { type: 'long' },
            raw: { type: 'text', index: false },
          },
        },
      }),
    );
    if (created.status !== 200 && !/resource_already_exists/.test(created.text)) {
      throw new Error(`could not create ${config.rejectIndex} (${created.status}): ${created.text.slice(0, 300)}`);
    }
  }
}

// ---------- state shown on the status page ----------

export const state = {
  startedAt: new Date().toISOString(),
  offset: 0, // list position of the next entry to read
  anchor: null, // sha1 of the entry just before `offset`, to notice the list being trimmed or reset
  listLength: null,
  caughtUpOnce: false,
  live: false,
  passes: 0,
  created: 0,
  alreadyThere: 0,
  fallback: 0,
  rejected: 0,
  resyncs: 0,
  lastShippedAt: null,
  lastEntryTs: null,
  redisOk: false,
  opensearchOk: false,
  lastError: null,
  lastErrorAt: null,
};

const copies = new CopyCounter(config.dupWindow);

function resync(reason) {
  log(`re-reading the list from the start: ${reason}`);
  state.offset = 0;
  state.anchor = null;
  state.live = false;
  state.resyncs += 1;
  copies.clear();
}

// ---------- one batch ----------

async function shipBatch(entries, firstListIndex) {
  const now = Date.now();
  const lines = [];
  const meta = [];
  const rejects = [];

  entries.forEach((raw, i) => {
    const listIndex = firstListIndex + i;
    const id = docId(raw, copies.next(raw));
    const doc = toDocument(raw, now);
    if (!doc.ok) {
      rejects.push({ raw, listIndex, id, index: null, reason: doc.reason });
      return;
    }
    lines.push(JSON.stringify({ create: { _index: doc.index, _id: id } }), doc.body);
    meta.push({ raw, listIndex, id, index: doc.index });
  });

  // First the monthly index; an entry it refuses (e.g. a value too long to index inside aux) goes,
  // unchanged, to <index>-fallback where aux is stored but not indexed; only if that refuses too is it
  // recorded as rejected.
  let pending = lines.length ? { lines, meta } : null;
  for (const target of ['primary', 'fallback']) {
    if (!pending) break;
    const res = await os('POST', '/_bulk', `${pending.lines.join('\n')}\n`, 'application/x-ndjson');
    if (res.status === 413 && entries.length > 1) {
      const err = new Error('batch too large');
      err.split = true;
      throw err;
    }
    if (res.status !== 200 || !res.json) {
      throw new Error(`bulk request failed (${res.status}): ${res.text.slice(0, 300)}`);
    }
    let retry = false;
    const refused = { lines: [], meta: [] };
    res.json.items.forEach((item, i) => {
      const r = item.create;
      const m = pending.meta[i];
      if (r.status === 201) {
        state.created += 1;
        if (target === 'fallback') state.fallback += 1;
      } else if (r.status === 409) state.alreadyThere += 1;
      else if (r.status === 429 || r.status >= 500) retry = true;
      else if (target === 'primary') {
        const index = `${m.index}-fallback`;
        refused.lines.push(JSON.stringify({ create: { _index: index, _id: m.id } }), pending.lines[i * 2 + 1]);
        refused.meta.push({ ...m, index, firstReason: JSON.stringify(r.error || r) });
      } else rejects.push({ ...m, reason: `${m.firstReason} | fallback: ${JSON.stringify(r.error || r)}` });
    });
    if (retry) throw new Error('OpenSearch is busy (429/5xx on some entries); retrying the batch');
    pending = refused.lines.length ? refused : null;
  }

  if (rejects.length) {
    const deadLines = [];
    for (const r of rejects) {
      deadLines.push(
        JSON.stringify({ index: { _index: config.rejectIndex, _id: r.id } }),
        JSON.stringify({
          '@timestamp': new Date(now).toISOString(),
          target_index: r.index,
          target_id: r.id,
          list_index: r.listIndex,
          reason: r.reason.slice(0, 4000),
          raw_bytes: Buffer.byteLength(r.raw),
          raw: r.raw.length > 1_000_000 ? `${r.raw.slice(0, 1_000_000)}…[cut]` : r.raw,
        }),
      );
      log(`rejected entry #${r.listIndex}: ${r.reason.slice(0, 200)}`);
    }
    const dead = await os('POST', '/_bulk', `${deadLines.join('\n')}\n`, 'application/x-ndjson');
    if (dead.status !== 200) throw new Error(`could not record rejected entries (${dead.status})`);
    state.rejected += rejects.length;
  }
}

// ---------- the loop ----------

async function readBatch(redis) {
  const end = Math.min(state.listLength, state.offset + config.batchSize) - 1;
  const entries = await redis.lrange(config.listKey, state.offset, end);
  // keep a batch under maxBatchBytes (one huge entry still goes on its own)
  let bytes = 0;
  let take = 0;
  for (const raw of entries) {
    bytes += Buffer.byteLength(raw);
    if (take > 0 && bytes > config.maxBatchBytes) break;
    take += 1;
  }
  return entries.slice(0, take);
}

async function pass(redis) {
  const length = await redis.llen(config.listKey);
  state.redisOk = true;
  state.listLength = length;

  if (state.offset > 0) {
    if (length < state.offset) {
      resync(`the list got shorter (${state.offset} → ${length}): Redis was flushed, restored or trimmed`);
    } else {
      const before = await redis.lindex(config.listKey, state.offset - 1);
      if (before === null || !sha1(before).equals(state.anchor)) {
        resync('the entries already shipped are no longer where they were (list trimmed or replaced)');
      }
    }
  }

  if (state.offset >= length) {
    if (!state.caughtUpOnce) log(`caught up: ${length} entries in the list, all in OpenSearch`);
    state.caughtUpOnce = true;
    state.live = true;
    return false;
  }

  let entries = await readBatch(redis);
  while (true) {
    const saved = copies.snapshot();
    try {
      await shipBatch(entries, state.offset);
      break;
    } catch (err) {
      copies.restore(saved);
      if (!err.split) throw err;
      entries = entries.slice(0, Math.max(1, Math.floor(entries.length / 2)));
    }
  }
  state.opensearchOk = true;
  state.offset += entries.length;
  state.anchor = sha1(entries[entries.length - 1]);
  state.lastShippedAt = new Date().toISOString();
  try {
    state.lastEntryTs = JSON.parse(entries[entries.length - 1]).ts || state.lastEntryTs;
  } catch {
    /* not JSON: already recorded as rejected */
  }
  return true;
}

async function waitForOpenSearch() {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await os('GET', '/_cluster/health?wait_for_status=yellow&timeout=5s');
      if (res.status === 200 && res.json && res.json.status !== 'red') {
        await ensureIndexSetup();
        state.opensearchOk = true;
        return;
      }
      throw new Error(`cluster health ${res.status} ${res.json ? res.json.status : ''}`);
    } catch (err) {
      state.opensearchOk = false;
      noteError(`waiting for OpenSearch at ${config.opensearchUrl}: ${err.message}`, attempt % 10 === 0);
      await sleep(Math.min(5000, 500 + attempt * 500));
    }
  }
}

function noteError(message, print = true) {
  state.lastError = message;
  state.lastErrorAt = new Date().toISOString();
  if (print) log(message);
}

export async function run() {
  const redis = new Redis({
    host: config.redisHost,
    port: config.redisPort,
    db: config.redisDb,
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => Math.min(times * 500, 5000),
  });
  redis.on('error', (err) => {
    state.redisOk = false;
    noteError(`Redis ${config.redisHost}:${config.redisPort}: ${err.message}`, false);
  });

  startStatusServer();
  log(`shipping redis://${config.redisHost}:${config.redisPort}/${config.redisDb} list "${config.listKey}" → ${config.opensearchUrl} ${config.indexPrefix}YYYY.MM`);
  await waitForOpenSearch();

  let failures = 0;
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  while (!stopping) {
    try {
      const more = await pass(redis);
      state.passes += 1;
      failures = 0;
      if (!more) await sleep(config.pollMs);
    } catch (err) {
      failures += 1;
      noteError(err.message, failures === 1 || failures % 20 === 0);
      if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|bulk request failed|busy/.test(err.message)) {
        state.opensearchOk = false;
        await waitForOpenSearch();
        // OpenSearch may have come back empty (volume removed): read the list again; existing entries are skipped.
        if (failures === 1) resync('OpenSearch was unreachable');
      }
      await sleep(Math.min(5000, 250 * 2 ** Math.min(failures, 5)));
    }
  }
  redis.disconnect();
  log('stopped');
  process.exit(0);
}

// ---------- status page (http://127.0.0.1:9700) ----------

export function statusSnapshot() {
  const lag = state.listLength === null ? null : Math.max(0, state.listLength - state.offset);
  return {
    ok: state.redisOk && state.opensearchOk && lag !== null && lag < 1000,
    redis: { host: config.redisHost, list: config.listKey, connected: state.redisOk, length: state.listLength },
    opensearch: { url: config.opensearchUrl, reachable: state.opensearchOk, indices: `${config.indexPrefix}*` },
    shipped: state.offset,
    lag,
    live: state.live,
    created: state.created,
    already_there: state.alreadyThere,
    in_fallback: state.fallback,
    rejected: state.rejected,
    resyncs: state.resyncs,
    dashboards_url: env.DASHBOARDS_PUBLIC_URL || 'http://127.0.0.1:5601',
    last_shipped_at: state.lastShippedAt,
    last_entry_ts: state.lastEntryTs,
    started_at: state.startedAt,
    last_error: state.lastError,
    last_error_at: state.lastErrorAt,
  };
}

/**
 * Exact check: every entry now in the Redis list has its document in OpenSearch, once. Reads the list in
 * chunks and keeps only ids, so memory stays small however long the list is.
 * Documents not in the list are history (Redis trimmed or flushed) — or duplicates, which `sample` shows.
 */
async function parity() {
  const redis = new Redis({ host: config.redisHost, port: config.redisPort, db: config.redisDb, maxRetriesPerRequest: 2 });
  try {
    const expected = new Set();
    const counter = new CopyCounter(config.dupWindow);
    const length = await redis.llen(config.listKey);
    for (let start = 0; start < length; start += 5000) {
      const chunk = await redis.lrange(config.listKey, start, Math.min(length, start + 5000) - 1);
      for (const raw of chunk) expected.add(docId(raw, counter.next(raw)));
    }
    let missing = expected.size;
    let extra = 0;
    const sample = [];
    let res = await os('POST', `/${config.indexPrefix}*/_search?scroll=1m`, JSON.stringify({ size: 10000, _source: ['ts', 'e_event', 'e_id'], sort: ['_doc'] }));
    while (res.json && res.json.hits && res.json.hits.hits.length) {
      for (const h of res.json.hits.hits) {
        if (expected.has(h._id)) missing -= 1;
        else {
          extra += 1;
          if (sample.length < 5) sample.push({ _id: h._id, _index: h._index, ...h._source });
        }
      }
      res = await os('POST', '/_search/scroll', JSON.stringify({ scroll: '1m', scroll_id: res.json._scroll_id }));
    }
    if (res.json && res.json._scroll_id) await os('DELETE', '/_search/scroll', JSON.stringify({ scroll_id: res.json._scroll_id }));
    return { redis_entries: length, missing_in_opensearch: missing, not_in_redis: extra, sample_not_in_redis: sample };
  } finally {
    redis.disconnect();
  }
}

async function indexStats() {
  const res = await os('GET', `/_cat/indices/${config.indexPrefix}*,${config.rejectIndex}?format=json&bytes=b&h=index,health,docs.count,store.size`);
  if (res.status !== 200 || !Array.isArray(res.json)) throw new Error(`OpenSearch ${res.status}`);
  return res.json
    .map((i) => ({ index: i.index, health: i.health, docs: Number(i['docs.count']), bytes: Number(i['store.size']) }))
    .sort((a, b) => a.index.localeCompare(b.index));
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body, null, 2));
}

function startStatusServer() {
  const page = fs.readFileSync(path.join(HERE, 'status.html'), 'utf8');
  http
    .createServer(async (req, res) => {
      const url = new URL(req.url, 'http://local');
      try {
        if (url.pathname === '/status' || url.pathname === '/healthz') {
          const snap = statusSnapshot();
          sendJson(res, url.pathname === '/healthz' && !snap.ok ? 503 : 200, snap);
          return;
        }
        if (url.pathname === '/api/indices') {
          sendJson(res, 200, await indexStats());
          return;
        }
        if (url.pathname === '/api/parity') {
          sendJson(res, 200, await parity());
          return;
        }
        if (url.pathname === '/api/lookups') {
          sendJson(res, 200, Object.fromEntries(Object.entries(LOOKUPS).map(([k, v]) => [k, { label: v.label, where: v.where, params: v.params, action: v.action }])));
          return;
        }
        if (url.pathname === '/api/lookup') {
          const params = Object.fromEntries(url.searchParams);
          const { kind } = params;
          delete params.kind;
          sendJson(res, 200, await runLookup(kind, params));
          return;
        }
        if (url.pathname === '/favicon.ico') {
          res.writeHead(204).end();
          return;
        }
        if (url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(page);
          return;
        }
        res.writeHead(404).end();
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
    })
    .listen(config.statusPort, '0.0.0.0');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    log(`fatal: ${err.stack || err}`);
    process.exit(1);
  });
}
