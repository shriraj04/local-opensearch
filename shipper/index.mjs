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
  // Where the shipper keeps its position, so a restart (even after weeks) continues instead of re-reading
  // the whole list. Kept in OpenSearch itself: if the data is wiped, the position goes with it.
  stateIndex: env.STATE_INDEX || 'astra-shipper-state',
  saveEveryMs: Number(env.SAVE_EVERY_MS || 2000),
  // Keep this many months of traces (the current month included); older monthly indices are dropped.
  // n8n's crons alone write ~6,000 lines an hour, so without a limit the data grows a few GB a year. 0 = keep all.
  retentionMonths: Number(env.RETENTION_MONTHS ?? 3),
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
  /** Rebuilds the counter from a saved ring (oldest first). */
  load(ring) {
    this.clear();
    for (const key of ring.slice(-this.size)) {
      this.ring.push(key);
      this.counts.set(key, (this.counts.get(key) || 0) + 1);
    }
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
    return { ok: true, index, body: oneLine, tsMs: hasTs ? tsMs : null };
  }
  const live = !hasTs || Math.abs(nowMs - tsMs) <= cfg.liveWindowMs;
  const stamp = JSON.stringify(live ? new Date(nowMs).toISOString() : entry.ts);
  const rest = oneLine.slice(1).trimStart();
  const body = rest.startsWith('}') ? `{"@timestamp":${stamp}}` : `{"@timestamp":${stamp},${rest}`;
  return { ok: true, index, body, tsMs: hasTs ? tsMs : null };
}

/** Start of the oldest month kept (UTC), or null to keep everything. */
export function retentionCutoff(months = config.retentionMonths, nowMs = Date.now()) {
  if (!months || months < 1) return null;
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (months - 1), 1);
}

/** True for an entry older than what is kept (entries without a valid ts are always kept). */
export function tooOld(raw, cutoff = retentionCutoff()) {
  if (cutoff === null) return false;
  try {
    const ms = Date.parse(JSON.parse(raw).ts);
    return Number.isFinite(ms) && ms < cutoff;
  } catch {
    return false;
  }
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

  if ((await os('HEAD', `/${config.stateIndex}`)).status === 404) {
    const made = await os(
      'PUT',
      `/${config.stateIndex}`,
      JSON.stringify({
        settings: { 'index.number_of_shards': 1, 'index.number_of_replicas': 0 },
        mappings: { dynamic: false, properties: { saved_at: { type: 'date' } } },
      }),
    );
    if (made.status !== 200 && !/resource_already_exists/.test(made.text)) {
      throw new Error(`could not create ${config.stateIndex} (${made.status}): ${made.text.slice(0, 300)}`);
    }
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
//
// The list grows at BOTH ends: the portals RPUSH (tail) and n8n's Redis "push" node LPUSHes (head).
// What is shipped is always one window [a, b) of the list. Entries n8n pushes appear before `a` (and move
// the window: k pushes → [a + k, b + k)); entries the portals push appear after `b`. Each pass reads only
// the new entries; the two ends of the window (hashA / hashB) prove where it is now.

export const state = {
  startedAt: new Date().toISOString(),
  a: 0, // list index of the first shipped entry
  b: 0, // list index just after the last shipped entry
  hashA: null, // sha1 of the entry at a
  hashB: null, // sha1 of the entry at b - 1
  lastLen: 0, // list length when the window was last located
  listLength: null,
  caughtUpOnce: false,
  live: false,
  passes: 0,
  created: 0,
  alreadyThere: 0,
  fallback: 0,
  rejected: 0,
  resyncs: 0,
  skippedOld: 0,
  lastShippedAt: null,
  lastEntryTs: null,
  redisOk: false,
  opensearchOk: false,
  lastError: null,
  lastErrorAt: null,
};

const copies = new CopyCounter(config.dupWindow);
const shippedCount = () => state.b - state.a;

function resync(reason) {
  log(`re-reading the list from the start: ${reason}`);
  Object.assign(state, { a: 0, b: 0, hashA: null, hashB: null, lastLen: 0, live: false });
  state.resyncs += 1;
  copies.clear();
}

// ---------- the saved position ----------

const stateDocPath = () => `/${config.stateIndex}/_doc/${encodeURIComponent(`${config.redisHost}:${config.redisPort}:${config.redisDb}:${config.listKey}`)}`;
let lastSaved = { at: 0, key: '' };

async function loadSavedPosition() {
  const res = await os('GET', stateDocPath());
  return res.status === 200 && res.json && res.json._source ? res.json._source : null;
}

async function savePosition(force = false) {
  const key = `${state.a}:${state.b}:${state.lastLen}`;
  if (!state.hashA || key === lastSaved.key) return;
  if (!force && Date.now() - lastSaved.at < config.saveEveryMs) return;
  try {
    const res = await os(
      'PUT',
      stateDocPath(),
      JSON.stringify({
        version: 2,
        a: state.a,
        b: state.b,
        hashA: state.hashA,
        hashB: state.hashB,
        lastLen: state.lastLen,
        ring: copies.ring,
        saved_at: new Date().toISOString(),
      }),
    );
    if (res.status === 200 || res.status === 201) lastSaved = { at: Date.now(), key };
  } catch {
    /* OpenSearch down: saved on a later batch */
  }
}

/** Takes up the saved window; the next pass proves it is still valid (or reads the list again). */
async function resume() {
  const saved = await loadSavedPosition();
  if (!saved || saved.version !== 2 || !(saved.b > saved.a)) {
    log('no saved position: reading the list from the start');
    return;
  }
  Object.assign(state, {
    a: saved.a,
    b: saved.b,
    hashA: saved.hashA,
    hashB: saved.hashB,
    lastLen: saved.lastLen,
  });
  copies.load(saved.ring || []);
  lastSaved = { at: Date.now(), key: `${saved.a}:${saved.b}:${saved.lastLen}` };
  log(`continuing from the saved position (${saved.b - saved.a} entries shipped, saved ${saved.saved_at})`);
}

// ---------- one batch ----------

async function shipBatch(entries, listIndexOf) {
  const now = Date.now();
  const cutoff = retentionCutoff(config.retentionMonths, now);
  const lines = [];
  const meta = [];
  const rejects = [];

  entries.forEach((raw, i) => {
    const listIndex = listIndexOf(i);
    const id = docId(raw, copies.next(raw));
    const doc = toDocument(raw, now);
    if (doc.ok && cutoff !== null && doc.tsMs !== null && doc.tsMs < cutoff) {
      state.skippedOld += 1;
      return;
    }
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

/** Ships all `entries` (oldest first), in smaller bulk requests while OpenSearch says one is too large. */
async function shipAll(entries, listIndexOf) {
  let done = 0;
  let size = entries.length;
  while (done < entries.length) {
    const batch = entries.slice(done, done + size);
    const saved = copies.snapshot();
    try {
      await shipBatch(batch, (i) => listIndexOf(done + i));
      done += batch.length;
    } catch (err) {
      copies.restore(saved);
      if (!err.split) throw err;
      size = Math.max(1, Math.floor(size / 2));
    }
  }
}

// ---------- the loop ----------

// One atomic, read-only step inside Redis (EVAL_RO): find where the shipped window [a, b) is now
// (n8n's head pushes move it) and return the next new entries, oldest first: after b (portals) or,
// once those are done, before a (n8n). Nothing can push between "where am I" and "what is next".
// Returns {len, k, side, firstHash, lastHash, entries...}: k = -1 when the window is gone (list
// trimmed / flushed / restored); side 0 = nothing new, 1 = after b, 2 = before a.
const STEP_LUA = `
local key = KEYS[1]
local a, b, lastLen = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local hashA, hashB = ARGV[4], ARGV[5]
local maxCount, maxBytes = tonumber(ARGV[6]), tonumber(ARGV[7])
local len = redis.call('LLEN', key)
local k = 0
if b > a then
  k = -1
  local grown = len - lastLen
  local i = 0
  while grown >= 0 and k < 0 and i <= grown do
    local stop = math.min(i + 199, grown)
    local cands = redis.call('LRANGE', key, a + i, a + stop)
    if #cands == 0 then break end
    for j = 1, #cands do
      if redis.sha1hex(cands[j]) == hashA then
        local last = redis.call('LINDEX', key, b - 1 + i + j - 1)
        if last and redis.sha1hex(last) == hashB then k = i + j - 1 break end
      end
    end
    i = stop + 1
  end
  if k < 0 then return {len, -1, 0, '', ''} end
end
local na, nb = a + k, b + k
if b <= a then na, nb = 0, 0 end
local out, bytes, side = {}, 0, 0
local function take(item)
  if #out > 0 and bytes + #item > maxBytes then return false end
  out[#out + 1] = item
  bytes = bytes + #item
  return #out < maxCount
end
if nb < len then
  side = 1
  local i, more = nb, true
  while more and i < len do
    local items = redis.call('LRANGE', key, i, math.min(len, i + 50) - 1)
    if #items == 0 then break end
    for j = 1, #items do if not take(items[j]) then more = false break end end
    i = i + #items
  end
elseif na > 0 then
  side = 2
  local i, more = na - 1, true
  while more and i >= 0 do
    local from = math.max(0, i - 49)
    local items = redis.call('LRANGE', key, from, i)
    for j = #items, 1, -1 do if not take(items[j]) then more = false break end end
    i = from - 1
  end
end
local res = {len, k, side, '', ''}
if #out > 0 then res[4] = redis.sha1hex(out[1]) res[5] = redis.sha1hex(out[#out]) end
for j = 1, #out do res[#res + 1] = out[j] end
return res
`;

/** Runs one STEP_LUA for window `w` ({a, b, hashA, hashB, lastLen}). */
export async function step(redis, w, maxCount, maxBytes) {
  const r = await redis.call('EVAL_RO', STEP_LUA, 1, config.listKey, w.a, w.b, w.lastLen, w.hashA || '', w.hashB || '', maxCount, maxBytes);
  const [len, k, side, firstHash, lastHash, ...entries] = r;
  return { len: Number(len), k: Number(k), side: Number(side), firstHash, lastHash, entries };
}

/** Moves window `w` to where `step` found it, plus the entries it returned (now shipped). */
export function advance(w, r) {
  const empty = w.b <= w.a;
  const na = empty ? 0 : w.a + r.k;
  const nb = empty ? 0 : w.b + r.k;
  const n = r.entries.length;
  w.lastLen = r.len;
  if (r.side === 1) {
    Object.assign(w, { a: na, b: nb + n, hashB: r.lastHash });
    if (empty) w.hashA = r.firstHash;
  } else if (r.side === 2) {
    Object.assign(w, { a: na - n, b: nb, hashA: r.lastHash });
  } else Object.assign(w, { a: na, b: nb });
  return { from: r.side === 1 ? nb : na - 1, dir: r.side === 1 ? 1 : -1 };
}

function noteShipped(newestRaw) {
  state.opensearchOk = true;
  state.lastShippedAt = new Date().toISOString();
  try {
    const ts = JSON.parse(newestRaw).ts;
    if (ts && (!state.lastEntryTs || ts > state.lastEntryTs)) state.lastEntryTs = ts;
  } catch {
    /* not JSON: already recorded as rejected */
  }
}

async function pass(redis) {
  const r = await step(redis, state, config.batchSize, config.maxBatchBytes);
  state.redisOk = true;
  state.listLength = r.len;
  if (r.k === -1) {
    resync(r.len < state.lastLen ? `the list got shorter (${state.lastLen} → ${r.len}): Redis was flushed, restored or trimmed` : 'the entries already shipped are no longer where they were (list trimmed or replaced)');
    return true;
  }
  if (r.side === 0) {
    advance(state, r);
    if (!state.caughtUpOnce) log(`caught up: ${r.len} entries in the list, all in OpenSearch`);
    state.caughtUpOnce = true;
    state.live = true;
    await savePosition(true);
    return false;
  }
  // ship first, then move the window: a failed send is simply read again next pass
  const { a, b, hashA, hashB, lastLen } = state;
  const where = advance({ a, b, hashA, hashB, lastLen }, r);
  const counted = copies.snapshot();
  try {
    await shipAll(r.entries, (i) => where.from + where.dir * i);
  } catch (err) {
    copies.restore(counted); // the whole step is read again next pass, with the same copy numbers
    throw err;
  }
  advance(state, r);
  noteShipped(r.entries[r.entries.length - 1]);
  await savePosition();
  return true;
}

let lastRetentionAt = 0;
/** Drops monthly indices (and their -fallback) older than the retention; at start and every 6 hours. */
async function enforceRetention(force = false) {
  const cutoff = retentionCutoff();
  if (cutoff === null || (!force && Date.now() - lastRetentionAt < 6 * 3600_000)) return;
  lastRetentionAt = Date.now();
  try {
    const res = await os('GET', `/_cat/indices/${config.indexPrefix}*?format=json&h=index`);
    for (const { index } of Array.isArray(res.json) ? res.json : []) {
      const m = index.slice(config.indexPrefix.length).match(/^(\d{4})\.(\d{2})(-fallback)?$/);
      if (m && Date.UTC(Number(m[1]), Number(m[2]) - 1, 1) < cutoff) {
        const del = await os('DELETE', `/${index}`);
        log(`retention (${config.retentionMonths} months): removed ${index} (${del.status})`);
      }
    }
  } catch (err) {
    noteError(`retention clean-up: ${err.message}`);
  }
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
  await enforceRetention(true);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await resume();
      break;
    } catch (err) {
      noteError(`reading the saved position: ${err.message}`, attempt % 10 === 0);
      await sleep(Math.min(5000, 500 + attempt * 500));
    }
  }

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
      if (!more) await enforceRetention();
      state.passes += 1;
      failures = 0;
      if (!more) await sleep(config.pollMs);
    } catch (err) {
      failures += 1;
      noteError(err.message, failures === 1 || failures % 20 === 0);
      if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|bulk request failed|busy/.test(err.message)) {
        state.opensearchOk = false;
        await waitForOpenSearch();
        // Came back without our saved position = its data was removed: read the list again.
        const saved = await loadSavedPosition().catch(() => null);
        if (shippedCount() > 0 && !saved) resync('OpenSearch came back without its data');
      }
      await sleep(Math.min(5000, 250 * 2 ** Math.min(failures, 5)));
    }
  }
  await savePosition(true);
  redis.disconnect();
  log('stopped');
  process.exit(0);
}

// ---------- status page (http://127.0.0.1:9700) ----------

export function statusSnapshot() {
  const lag = state.listLength === null ? null : Math.max(0, state.listLength - shippedCount());
  return {
    ok: state.redisOk && state.opensearchOk && lag !== null && lag < 1000,
    redis: { host: config.redisHost, list: config.listKey, connected: state.redisOk, length: state.listLength },
    opensearch: { url: config.opensearchUrl, reachable: state.opensearchOk, indices: `${config.indexPrefix}*` },
    shipped: shippedCount(),
    lag,
    live: state.live,
    created: state.created,
    already_there: state.alreadyThere,
    in_fallback: state.fallback,
    rejected: state.rejected,
    resyncs: state.resyncs,
    retention_months: config.retentionMonths,
    skipped_older_than_retention: state.skippedOld,
    dashboards_url: env.DASHBOARDS_PUBLIC_URL || 'http://127.0.0.1:5601',
    last_shipped_at: state.lastShippedAt,
    last_entry_ts: state.lastEntryTs,
    started_at: state.startedAt,
    last_error: state.lastError,
    last_error_at: state.lastErrorAt,
  };
}

/**
 * Exact check: every entry in the Redis list has its document in OpenSearch, once. Walks the list with the
 * same atomic steps as the shipper (so entries pushed meanwhile cannot shift the walk), keeping only ids.
 * Documents not in the list are history (Redis trimmed or flushed) — or duplicates, which `sample` shows.
 */
async function parity() {
  const redis = new Redis({ host: config.redisHost, port: config.redisPort, db: config.redisDb, maxRetriesPerRequest: 2 });
  try {
    let expected;
    let length = 0;
    for (let attempt = 0; attempt < 3 && !expected; attempt += 1) {
      const w = { a: 0, b: 0, hashA: '', hashB: '', lastLen: 0 };
      const counter = new CopyCounter(config.dupWindow);
      const ids = new Set();
      for (;;) {
        const r = await step(redis, w, 5000, 32 * 1024 * 1024);
        if (r.k === -1) break; // list replaced under us: start again
        advance(w, r);
        for (const raw of r.entries) {
          const id = docId(raw, counter.next(raw));
          if (!tooOld(raw)) ids.add(id);
        }
        if (r.side === 0) {
          expected = ids;
          length = r.len;
          break;
        }
      }
    }
    if (!expected) throw new Error('the list kept changing under the check; try again');
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

// for tests
export { pass as _pass, resync as _resync, copies as _copies, parity as _parity };
