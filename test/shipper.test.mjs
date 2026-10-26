import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toDocument, docId, CopyCounter, monthIndex, retentionCutoff, tooOld } from '../shipper/index.mjs';
import { makeParser, LOOKUPS } from '../shipper/mng-query.mjs';

const cfg = { indexPrefix: 'nps-app-', liveWindowMs: 5000 };
const NOW = Date.parse('2026-10-23T09:30:00.000Z');

test('backlog entry: same JSON plus @timestamp = ts, monthly index from ts', () => {
  const raw = '{"ts":"2026-09-30T23:59:59.999Z","level":"INFO","p_key":"TRANSACTION","p_value":189444,"aux":{"a":1}}';
  const doc = toDocument(raw, NOW, cfg);
  assert.equal(doc.ok, true);
  assert.equal(doc.index, 'nps-app-2026.09');
  const parsed = JSON.parse(doc.body);
  assert.equal(parsed['@timestamp'], '2026-09-30T23:59:59.999Z');
  const { '@timestamp': _, ...rest } = parsed;
  assert.deepEqual(rest, JSON.parse(raw));
});

test('live entry: @timestamp is the time it was shipped, like remote ingest time', () => {
  const raw = '{"ts":"2026-10-23T09:29:59.900Z","msg":"x"}';
  const doc = toDocument(raw, NOW, cfg);
  assert.equal(JSON.parse(doc.body)['@timestamp'], '2026-10-23T09:30:00.000Z');
  assert.equal(doc.index, 'nps-app-2026.10');
});

test('values reach OpenSearch exactly as written (no re-serialising)', () => {
  const raw = '{"ts":"2026-10-01T00:00:00.000Z","big":12345678901234567890,"f":1.10,"s":"é\\u00e9"}';
  const doc = toDocument(raw, NOW, cfg);
  assert.ok(doc.body.endsWith('"big":12345678901234567890,"f":1.10,"s":"é\\u00e9"}'));
});

test('pretty-printed / trailing-newline entries become one line, values unchanged', () => {
  const raw = '{\n  "ts": "2026-10-01T00:00:00.000Z",\r\n  "msg": "a\\nb"\n}\n';
  const doc = toDocument(raw, NOW, cfg);
  assert.equal(doc.body.includes('\n'), false);
  assert.equal(JSON.parse(doc.body).msg, 'a\nb');
});

test('an entry that already has @timestamp keeps it', () => {
  const raw = '{"@timestamp":"2026-01-01T00:00:00Z","ts":"2026-10-01T00:00:00.000Z"}';
  assert.equal(JSON.parse(toDocument(raw, NOW, cfg).body)['@timestamp'], '2026-01-01T00:00:00Z');
});

test('empty object, non-JSON and non-object entries', () => {
  assert.equal(JSON.parse(toDocument('{}', NOW, cfg).body)['@timestamp'], new Date(NOW).toISOString());
  assert.equal(toDocument('', NOW, cfg).ok, false);
  assert.equal(toDocument('not json', NOW, cfg).ok, false);
  assert.equal(toDocument('[1,2]', NOW, cfg).ok, false);
  assert.equal(toDocument('"text"', NOW, cfg).ok, false);
});

test('ids are stable, remote-shaped, and identical copies stay separate', () => {
  const counter = new CopyCounter(3);
  const a = '{"x":1}';
  const ids = [a, a, '{"y":2}', a].map((raw) => docId(raw, counter.next(raw)));
  assert.equal(ids[0], docId(a, 0));
  assert.notEqual(ids[0], ids[1]);
  assert.equal(new Set(ids).size, 4);
  assert.match(ids[0], /^[A-Za-z0-9_-]{20}$/);
  // re-reading the list from the start gives the same ids
  const again = new CopyCounter(3);
  assert.deepEqual([a, a, '{"y":2}', a].map((raw) => docId(raw, again.next(raw))), ids);
});

test('a failed batch that is retried keeps the same ids for identical entries', () => {
  const a = '{"ts":"2026-10-23T12:43:17.374Z","e_event":"COMPLETED","e_id":"124195"}';
  const batch = [a, a, a];
  const counter = new CopyCounter(2000);
  const saved = counter.snapshot();
  const firstTry = batch.map((raw) => docId(raw, counter.next(raw)));
  counter.restore(saved); // the send failed
  const retry = batch.map((raw) => docId(raw, counter.next(raw)));
  assert.deepEqual(retry, firstTry);
  const fresh = new CopyCounter(2000);
  assert.deepEqual(batch.map((raw) => docId(raw, fresh.next(raw))), firstTry); // same as a full re-read
});

test('continuing from a saved position gives the same ids as reading the whole list', () => {
  const list = ['{"a":1}', '{"b":2}', '{"a":1}', '{"c":3}', '{"a":1}', '{"b":2}'];
  const whole = new CopyCounter(4);
  const all = list.map((raw) => docId(raw, whole.next(raw)));
  // ship the first 3, save, "restart", continue
  const first = new CopyCounter(4);
  const head = list.slice(0, 3).map((raw) => docId(raw, first.next(raw)));
  const savedRing = first.ring.slice();
  const resumed = new CopyCounter(4);
  resumed.load(savedRing);
  const tail = list.slice(3).map((raw) => docId(raw, resumed.next(raw)));
  assert.deepEqual([...head, ...tail], all);
});

test('monthIndex uses UTC', () => {
  assert.equal(monthIndex('nps-app-', Date.parse('2026-10-31T23:30:00-02:00')), 'nps-app-2026.11');
});

// ---------- the MNG option resolution, against the real action files ----------

const REPO = process.env.ASTRA_REPO || path.join(os.homedir(), 'payment_system');
const step = (rel) => {
  const find = (n) => {
    if (Array.isArray(n)) return n.map(find).find(Boolean);
    if (n && typeof n === 'object') {
      if (n.module === 'opensearch-query') return n;
      return Object.values(n).map(find).find(Boolean);
    }
    return null;
  };
  return find(JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8')));
};

test('every lookup finds its opensearch-query step and resolves all of its options', { skip: !fs.existsSync(REPO) }, () => {
  for (const [kind, lookup] of Object.entries(LOOKUPS)) {
    const s = step(lookup.action);
    assert.ok(s, `${kind}: step found`);
    const params = Object.fromEntries(lookup.params.map((p) => [p, p.endsWith('date') ? '2026-10-01T00:00:00.000Z' : '189444']));
    const parse = makeParser(params, new Set());
    for (const value of Object.values(s.options)) parse(value); // throws on anything not understood
  }
});

test('Wappler expressions resolve like MNG', () => {
  const parse = makeParser({ tx_id: '189444', from_date: '2026-10-01T00:00:00' }, new Set(['logs']));
  assert.equal(parse('{{$_GET.tx_id}}'), '189444');
  assert.deepEqual(parse("{{['TRACE','NOTE']}}"), ['TRACE', 'NOTE']);
  assert.equal(parse('{{TRANSACTION}}'), undefined); // unbound name, as in notes.json
  assert.equal(parse('{{$_GET.from_date.toUTCTime()}}'), new Date('2026-10-01T00:00:00').toISOString());
  assert.equal(parse(true), true);
  assert.equal(parse(''), '');
  assert.throws(() => parse('{{logs.length}}'));
  assert.throws(() => parse('{{logs}}'));
  assert.throws(() => parse('id {{x}}'));
});

test('retention keeps whole months: the current one plus the ones before it', () => {
  const now = Date.parse('2026-10-26T05:00:00Z');
  assert.equal(new Date(retentionCutoff(3, now)).toISOString(), '2026-08-01T00:00:00.000Z');
  assert.equal(new Date(retentionCutoff(1, now)).toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(new Date(retentionCutoff(14, now)).toISOString(), '2025-09-01T00:00:00.000Z');
  assert.equal(retentionCutoff(0, now), null);
  const cutoff = retentionCutoff(3, now);
  assert.equal(tooOld('{"ts":"2026-07-31T23:59:59.999Z"}', cutoff), true);
  assert.equal(tooOld('{"ts":"2026-08-01T00:00:00.000Z"}', cutoff), false);
  assert.equal(tooOld('{"msg":"no ts"}', cutoff), false);
  assert.equal(tooOld('not json', cutoff), false);
  assert.equal(tooOld('{"ts":"2020-01-01T00:00:00Z"}', null), false);
});
