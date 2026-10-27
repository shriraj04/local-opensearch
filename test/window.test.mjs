// The list grows at BOTH ends (portals RPUSH, n8n LPUSH). These tests run the real shipper loop and its
// atomic Redis step against a throwaway Redis (docker) and a simulated OpenSearch, and check: every entry
// is shipped exactly once, with the ids a full read gives, without re-reading what was already shipped.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });
const started = docker('run', '-d', '--rm', '-p', '127.0.0.1::6379', 'redis:latest');
const container = started.status === 0 ? started.stdout.trim() : null;
const skip = container ? false : 'needs Docker (a throwaway redis:latest container)';
let port = null;
if (container) {
  port = docker('port', container, '6379/tcp').stdout.trim().split(':').pop();
  for (let i = 0; i < 50 && docker('exec', container, 'redis-cli', 'ping').stdout.trim() !== 'PONG'; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
}
after(() => container && docker('rm', '-f', container));

process.env.BATCH_SIZE = '4'; // small steps, so pushes land in the middle of a read
process.env.SAVE_EVERY_MS = '0';
process.env.RETENTION_DAYS = '5';
process.env.REDIS_HOST = '127.0.0.1';
process.env.REDIS_PORT = String(port || 6379);
const shipper = await import('../shipper/index.mjs');
const { _pass: pass, _resync: resync, _copies: copies, _parity: parity, _clear: clear, _enforceRetention: enforceRetention, state, docId, CopyCounter } = shipper;
const { default: Redis } = await import('../shipper/node_modules/ioredis/built/index.js');
const redis = container ? new Redis({ host: '127.0.0.1', port: Number(port) }) : null;
after(() => redis && redis.disconnect());
const KEY = 'nps-logs';

// Simulated OpenSearch: records every create (409 when the id exists) and serves the ids back to a scroll.
const store = new Map();
let creates = 0;
let conflicts = 0;
let refuseRejected = 0; // > 0: the next writes to the rejected index are refused (disk nearly full)
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  let body = { acknowledged: true };
  let status = 200;
  if (u.pathname === '/_bulk') {
    const lines = init.body.trim().split('\n');
    const items = [];
    for (let i = 0; i < lines.length; i += 2) {
      const action = JSON.parse(lines[i]);
      const { _id: id, _index: index } = action.create || action.index;
      if (index === 'astra-shipper-rejected' && refuseRejected > 0) {
        refuseRejected -= 1;
        const reason = `index [${index}] blocked by: [TOO_MANY_REQUESTS/12/disk usage exceeded flood-stage watermark, index has read-only-allow-delete block];`;
        items.push({ index: { status: 429, error: { type: 'cluster_block_exception', reason } } });
      } else if (store.has(id)) {
        conflicts += 1;
        items.push({ create: { status: 409 } });
      } else {
        store.set(id, index);
        creates += 1;
        items.push({ create: { status: 201 } });
      }
    }
    body = { items };
  } else if (u.pathname.endsWith('/_search') && u.search.includes('scroll')) {
    // only the documents of the index (pattern) searched, e.g. nps-app-* or astra-shipper-rejected
    const pattern = decodeURIComponent(u.pathname.split('/')[1]);
    const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    const hits = [...store].filter(([, index]) => re.test(index)).map(([id, index]) => ({ _id: id, _index: index, _source: {} }));
    body = { _scroll_id: 's', hits: { hits } };
  } else if (u.pathname.startsWith('/_cat/indices')) {
    body = [...new Set(store.values())].map((index) => ({ index, 'store.size': '1000' }));
  } else if ((init.method || 'GET') === 'DELETE' && /^\/nps-app-|^\/astra-shipper-rejected$/.test(u.pathname)) {
    const index = decodeURIComponent(u.pathname.slice(1));
    for (const [id, ix] of [...store]) if (ix === index) store.delete(id);
  } else if (u.pathname === '/_search/scroll') {
    body = (init.method || 'GET') === 'DELETE' ? {} : { _scroll_id: 's', hits: { hits: [] } };
  } else if ((init.method || 'GET') === 'GET' && u.pathname.includes('astra-shipper-state')) {
    status = 404;
  }
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
};

const entry = (n, src, ts = new Date().toISOString()) => JSON.stringify({ ts, e_event: `E${n}`, src });
const list = () => redis.lrange(KEY, 0, -1);
const expectedIds = async () => {
  const c = new CopyCounter(2000);
  return new Set((await list()).map((raw) => docId(raw, c.next(raw))));
};
async function drain(between) {
  for (let i = 0; i < 300; i += 1) {
    const more = await pass(redis);
    if (between) between(i);
    if (!more && (!between || i > 30)) return;
  }
}
async function reset(items) {
  store.clear();
  creates = 0;
  conflicts = 0;
  resync('test');
  state.resyncs = 0;
  state.clearedAt = null;
  copies.clear();
  await redis.del(KEY);
  if (items.length) await redis.rpush(KEY, ...items);
}

test('first read, then n8n (head) and portal (tail) pushes are shipped once each', { skip }, async () => {
  await reset(Array.from({ length: 10 }, (_, i) => entry(i, 'start')));
  await drain();
  assert.equal(creates, 10);
  await redis.lpush(KEY, entry(100, 'n8n'), entry(101, 'n8n'), entry(102, 'n8n'));
  await redis.rpush(KEY, entry(200, 'portal'), entry(201, 'portal'));
  await drain();
  assert.equal(creates, 15);
  assert.equal(conflicts, 0, 'nothing was read twice');
  assert.equal(state.resyncs, 0);
  assert.deepEqual(new Set(store.keys()), await expectedIds());
});

test('pushes at both ends while the first read is still going', { skip }, async () => {
  await reset(Array.from({ length: 30 }, (_, i) => entry(i, 'start')));
  let n = 1000;
  await drain((i) => {
    if (i < 14) {
      redis.lpush(KEY, entry(n++, 'n8n'));
      if (i % 2) redis.rpush(KEY, entry(n++, 'portal'));
    }
  });
  await drain();
  assert.equal(store.size, await redis.llen(KEY));
  assert.equal(conflicts, 0);
  assert.equal(state.resyncs, 0);
  assert.deepEqual(new Set(store.keys()), await expectedIds());
});

test('identical entries pushed by n8n are all kept, like a full read', { skip }, async () => {
  const same = entry(7, 'n8n-loop');
  await reset([entry(1, 'a'), same, entry(2, 'b')]);
  await drain();
  await redis.lpush(KEY, same, same, same);
  await redis.rpush(KEY, entry(3, 'c'));
  await drain();
  assert.equal(store.size, await redis.llen(KEY));
  assert.deepEqual(new Set(store.keys()), await expectedIds());
});

test('a flushed list is read again, nothing lost', { skip }, async () => {
  await reset(Array.from({ length: 8 }, (_, i) => entry(i, 'start')));
  await drain();
  await redis.del(KEY);
  await redis.rpush(KEY, entry(50, 'after-flush'), entry(51, 'after-flush'));
  await drain();
  assert.equal(state.resyncs, 1);
  for (const id of await expectedIds()) assert.ok(store.has(id));
});

test('the exact check agrees, also while entries are being pushed', { skip }, async () => {
  await reset(Array.from({ length: 40 }, (_, i) => entry(i, 'start')));
  await drain();
  let n = 5000;
  const pusher = setInterval(() => redis.lpush(KEY, entry(n++, 'busy-n8n')), 1);
  await new Promise((r) => setTimeout(r, 30));
  clearInterval(pusher);
  await drain();
  const p = await parity();
  assert.equal(p.missing_in_opensearch, 0);
  assert.equal(p.not_in_redis, 0);
  assert.equal(p.redis_entries, await redis.llen(KEY));
});

test('entries older than the retention are not shipped, and the exact check agrees', { skip }, async () => {
  const old = JSON.stringify({ ts: '2020-01-01T00:00:00.000Z', e_event: 'ANCIENT' });
  await reset([entry(1, 'a'), old, entry(2, 'b')]);
  await drain();
  assert.equal(store.size, 2);
  assert.ok(state.skippedOld >= 1);
  const p = await parity();
  assert.equal(p.missing_in_opensearch, 0);
  assert.equal(p.not_in_redis, 0);
});

test('blank and non-JSON entries are recorded as rejected, and the exact check does not count them as missing', { skip }, async () => {
  await reset([entry(1, 'a'), '\n\n\n', '\n\n\n', 'not json', entry(2, 'b')]);
  await drain();
  const inIndex = (ix) => [...store.values()].filter((i) => i === ix).length;
  assert.equal(inIndex('astra-shipper-rejected'), 3);
  const p = await parity();
  assert.equal(p.missing_in_opensearch, 0);
  assert.equal(p.rejected_entries, 3);
  assert.equal(p.kept_entries, 2);
  assert.equal(p.not_in_redis, 0);
});

test('a rejected entry that cannot be recorded yet (disk nearly full) is retried, not dropped', { skip }, async () => {
  await reset([entry(1, 'a'), 'not json', entry(2, 'b')]);
  refuseRejected = 1;
  await assert.rejects(drain(), /busy: it paused writing because the disk is nearly full/);
  assert.equal(refuseRejected, 0);
  await drain();
  assert.equal([...store.values()].filter((i) => i === 'astra-shipper-rejected').length, 1);
  const p = await parity();
  assert.equal(p.missing_in_opensearch, 0);
  assert.equal(p.rejected_entries, 1);
});

test('older days are removed by themselves (daily indices)', { skip }, async () => {
  const day = (d) => new Date(Date.now() - d * 86_400_000).toISOString();
  await reset([entry(1, 'today'), entry(2, '3 days ago', day(3)), entry(3, '8 days ago', day(8))]);
  // the 8-day-old entry is never shipped; force an older index to exist, then let the clean-up remove it
  await drain();
  assert.equal(store.size, 2);
  store.set('stale-doc', `nps-app-${new Date(Date.now() - 9 * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '.')}`);
  await enforceRetention(true);
  assert.equal(store.has('stale-doc'), false);
  assert.equal(store.size, 2);
});

test('"Clear all trace data" empties it and keeps only what comes after', { skip }, async () => {
  await reset([entry(1, 'before'), entry(2, 'before')]);
  await drain();
  assert.equal(store.size, 2);
  const r = await clear();
  assert.equal(store.size, 0);
  assert.ok(r.cleared_at);
  await new Promise((res) => setTimeout(res, 5));
  await redis.rpush(KEY, entry(3, 'after'));
  await redis.lpush(KEY, entry(4, 'after-n8n'));
  await drain();
  assert.equal(store.size, 2, 'only the two new entries');
  resync('re-read after clear'); // even a full re-read does not bring the old ones back
  await drain();
  assert.equal(store.size, 2);
  const p = await parity();
  assert.equal(p.missing_in_opensearch, 0);
  assert.equal(p.not_in_redis, 0);
});
