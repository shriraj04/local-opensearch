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
process.env.REDIS_HOST = '127.0.0.1';
process.env.REDIS_PORT = String(port || 6379);
const shipper = await import('../shipper/index.mjs');
const { _pass: pass, _resync: resync, _copies: copies, _parity: parity, state, docId, CopyCounter } = shipper;
const { default: Redis } = await import('../shipper/node_modules/ioredis/built/index.js');
const redis = container ? new Redis({ host: '127.0.0.1', port: Number(port) }) : null;
after(() => redis && redis.disconnect());
const KEY = 'nps-logs';

// Simulated OpenSearch: records every create (409 when the id exists) and serves the ids back to a scroll.
const store = new Map();
let creates = 0;
let conflicts = 0;
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
      if (store.has(id)) {
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
    body = { _scroll_id: 's', hits: { hits: [...store.keys()].map((id) => ({ _id: id, _index: store.get(id), _source: {} })) } };
  } else if (u.pathname === '/_search/scroll') {
    body = (init.method || 'GET') === 'DELETE' ? {} : { _scroll_id: 's', hits: { hits: [] } };
  } else if ((init.method || 'GET') === 'GET' && u.pathname.includes('astra-shipper-state')) {
    status = 404;
  }
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
};

const entry = (n, src) => JSON.stringify({ ts: '2026-10-23T10:00:00.000Z', e_event: `E${n}`, src });
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
