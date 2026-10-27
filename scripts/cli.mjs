// ASTRA Local OpenSearch — one command for everything (see README.md):
//   npm run setup              first-time setup in one go: checks the laptop, starts it, connects MNG, tests it
//   npm run up                 start (or update) OpenSearch, Dashboards and the log shipper; set up Dashboards
//   npm run status             is everything running, how much is shipped, is MNG wired
//   npm run doctor             end-to-end proof: Redis → OpenSearch → the product's own query, inside MNG
//   npm run wire / unwire      point MNG + WL-MNG at the local OpenSearch / put the original OPS_URL back
//   npm run trace -- tx 189444            Transaction Trace      (also: notes 189444, account 140,
//                                          internal-notes 2026-10-01 2026-10-23, wl-trace 189444)
//   npm run logs [-- shipper|opensearch|dashboards] [-- -f]
//   npm run down               stop the containers (data is kept); stays stopped until npm run up
//   npm run autostart[:off]    background check at login + every 10 min that repairs it (setup turns it on)
//   npm run clear              delete all trace data now (keeps only new logs); old days also go by themselves after 5 days
//   npm run remove             remove everything it put on the laptop (data, containers, images, background check)
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDashboards, HOME_DASHBOARD } from './dashboards.mjs';
import { findJava, javaHelp } from './java.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dotenv = readDotEnv(path.join(ROOT, '.env'));
const setting = (key, fallback) => process.env[key] || dotenv[key] || fallback;

// Cloned inside payment_system (next to qa-astra)? Then that is the checkout; otherwise ~/payment_system.
const insideAstra = fs.existsSync(path.join(ROOT, '..', 'mng', 'app', 'api')) ? path.resolve(ROOT, '..') : null;
const ASTRA_REPO = setting('ASTRA_REPO', insideAstra || path.join(os.homedir(), 'payment_system'));
const OS_PORT = setting('OPENSEARCH_PORT', '9200');
const DASH_PORT = setting('DASHBOARDS_PORT', '5601');
const SHIP_PORT = setting('SHIPPER_PORT', '9700');
const OS = `http://127.0.0.1:${OS_PORT}`;
const DASH = `http://127.0.0.1:${DASH_PORT}`;
const SHIP = `http://127.0.0.1:${SHIP_PORT}`;
const HOME = `${DASH}/app/dashboards#/view/${HOME_DASHBOARD}`;

/** Sets up Dashboards with the kept period and the clear button's link from the running shipper. */
async function provisionDashboards() {
  const s = (await tryJson(`${SHIP}/status`))?.json;
  await setupDashboards(DASH, { retentionDays: s?.retention_days ?? Number(setting('RETENTION_DAYS', '5')), clearUrl: `${SHIP}/clear` });
}

// Rison, as OpenSearch Dashboards reads its URL state.
const rison = (v) => `'${String(v).replace(/!/g, '!!').replace(/'/g, "!'")}'`;
function discoverUrl(dql, from = 'now-7d', to = 'now') {
  const t = (v) => (v.startsWith('now') ? v : rison(v));
  const a = '(discover:(columns:!(e_event,msg,level,uid,domain,p_key,p_value,entry_type),isDirty:!f,sort:!(!(ts,desc))),metadata:(indexPattern:nps-app,view:discover))';
  const g = `(filters:!(),refreshInterval:(pause:!t,value:0),time:(from:${t(from)},to:${t(to)}))`;
  const q = `(filters:!(),query:(language:kuery,query:${rison(dql)}))`;
  return `${DASH}/app/data-explorer/discover#?_a=${encodeURIComponent(a)}&_g=${encodeURIComponent(g)}&_q=${encodeURIComponent(q)}`;
}
const IN_NETWORK_URL = 'http://astra-opensearch:9200';
const WIRE_DIR = path.join(os.homedir(), '.config', 'astra-local', 'opensearch-wiring');
const APPS = [
  { app: 'mng', container: 'nps_admin_web', domain: 'qa-alpha-astramng.local' },
  { app: 'wl-mng', container: 'nps_wl-mng_web', domain: 'qa-alpha-astrawlmng.local' },
];
const CONTAINERS = ['astra-opensearch', 'astra-opensearch-dashboards', 'astra-log-shipper'];
const SERVICE_OF = { 'astra-opensearch': 'opensearch', 'astra-opensearch-dashboards': 'dashboards', 'astra-log-shipper': 'shipper' };
const RUN_DIR = path.join(ROOT, '.run');
const STOPPED_MARK = path.join(RUN_DIR, 'stopped');
const GUARD = 'local-opensearch-guard';
const UNIT_DIR = path.join(os.homedir(), '.config', 'systemd', 'user');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => (n === null || n === undefined ? '–' : Number(n).toLocaleString('en-US'));
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);
const info = (m) => console.log(`    ${m}`);
function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function readDotEnv(file) {
  try {
    return Object.fromEntries(
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
        .filter(Boolean)
        .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]),
    );
  } catch {
    return {};
  }
}

/** A Docker / Java size such as 320m, 1g or 1536M in MB (0 when it cannot be read). */
function megabytes(size) {
  const m = String(size).trim().match(/^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i);
  if (!m) return 0;
  return Math.round(Number(m[1]) * { k: 1 / 1024, m: 1, g: 1024, '': 1 / 1048576 }[m[2].toLowerCase()]);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT, ...opts });
}
function compose(args, opts = {}) {
  return run('docker', ['compose', ...args], { ...opts, env: { ...process.env, ASTRA_REPO, ...(opts.env || {}) } });
}

async function getJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init?.timeout || 8000) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}
async function tryJson(url, init) {
  try {
    return await getJson(url, init);
  } catch {
    return null;
  }
}

function containerState(name) {
  const r = run('docker', ['inspect', name, '--format', '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}']);
  return r.status === 0 ? r.stdout.trim() : 'missing';
}

// ---------- wiring (MNG / WL-MNG config.json, OPS_URL only) ----------

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const configFile = (app) => path.join(ASTRA_REPO, app, 'app', 'config', 'config.json');

function readOpsUrl(text) {
  return JSON.parse(text).env?.OPS_URL;
}

/** Replaces the one "OPS_URL": "<value>" in the text, keeping every other byte. */
function replaceOpsUrl(text, from, to) {
  const pattern = new RegExp(`("OPS_URL"\\s*:\\s*)${JSON.stringify(from).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
  const hits = text.match(pattern) || [];
  if (hits.length !== 1) throw new Error(`expected exactly one "OPS_URL": ${JSON.stringify(from)}, found ${hits.length}`);
  const out = text.replace(pattern, `$1${JSON.stringify(to)}`);
  // nothing but OPS_URL may differ
  const a = JSON.parse(text);
  const b = JSON.parse(out);
  b.env.OPS_URL = a.env.OPS_URL;
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('refusing: the edit would change more than OPS_URL');
  return out;
}

function wiringState(app) {
  const file = configFile(app);
  if (!fs.existsSync(file)) return { app, file, exists: false };
  const text = fs.readFileSync(file, 'utf8');
  let url;
  try {
    url = readOpsUrl(text);
  } catch (err) {
    return { app, file, exists: true, error: `not valid JSON: ${err.message}` };
  }
  const backup = path.join(WIRE_DIR, `${app}.config.json.orig`);
  return { app, file, exists: true, url, wired: url === IN_NETWORK_URL, hasBackup: fs.existsSync(backup), backup };
}

const hostOf = (url) => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url ? '(not a URL)' : '(empty)';
  }
};

async function wire() {
  console.log('Pointing MNG and WL-MNG at the local OpenSearch (only OPS_URL changes):');
  fs.mkdirSync(WIRE_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(WIRE_DIR, 0o700);
  for (const { app } of APPS) {
    const s = wiringState(app);
    if (!s.exists) {
      warn(`${app}: ${s.file} not found — skipped`);
      continue;
    }
    if (s.error) fail(`${app}: ${s.error}`);
    if (s.wired) {
      ok(`${app}: already wired (OPS_URL = ${IN_NETWORK_URL})`);
      continue;
    }
    const original = fs.readFileSync(s.file);
    const metaFile = path.join(WIRE_DIR, `${app}.json`);
    // keep the very first original; a later wire after an edit by someone else adds a dated copy
    if (fs.existsSync(s.backup) && sha256(fs.readFileSync(s.backup)) !== sha256(original)) {
      fs.copyFileSync(s.backup, `${s.backup}.${Date.now()}`);
    }
    fs.writeFileSync(s.backup, original, { mode: 0o600 });
    const wired = replaceOpsUrl(original.toString('utf8'), s.url, IN_NETWORK_URL);
    const mode = fs.statSync(s.file).mode & 0o777;
    fs.writeFileSync(s.file, wired, { mode });
    fs.writeFileSync(
      metaFile,
      JSON.stringify(
        {
          app,
          file: s.file,
          wired_at: new Date().toISOString(),
          original_sha256: sha256(original),
          wired_sha256: sha256(Buffer.from(wired)),
          original_ops_url_host: hostOf(s.url),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    ok(`${app}: OPS_URL ${hostOf(s.url)} → ${IN_NETWORK_URL}  (original saved: ${s.backup})`);
  }
  console.log('\n  MNG / WL-MNG restart by themselves (nodemon) in a few seconds.');
  await waitForPortals();
  console.log('\n  Undo any time with: npm run unwire');
}

async function unwire() {
  console.log('Putting the original OPS_URL back in MNG and WL-MNG:');
  for (const { app } of APPS) {
    const s = wiringState(app);
    const metaFile = path.join(WIRE_DIR, `${app}.json`);
    if (!s.exists) {
      warn(`${app}: ${s.file} not found — skipped`);
      continue;
    }
    if (!s.wired) {
      ok(`${app}: not wired (OPS_URL = ${hostOf(s.url)}) — nothing to do`);
      continue;
    }
    if (!s.hasBackup || !fs.existsSync(metaFile)) fail(`${app}: wired but no backup in ${WIRE_DIR}; set OPS_URL back by hand`);
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const backup = fs.readFileSync(s.backup);
    const current = fs.readFileSync(s.file);
    if (sha256(current) === meta.wired_sha256) {
      fs.writeFileSync(s.file, backup); // byte-identical original
      const check = sha256(fs.readFileSync(s.file)) === meta.original_sha256;
      (check ? ok : bad)(`${app}: original restored byte-identical (OPS_URL = ${hostOf(readOpsUrl(backup.toString('utf8')))})`);
    } else {
      // the file was edited since wiring: put back only the OPS_URL value, keep the other edits
      const restored = replaceOpsUrl(current.toString('utf8'), IN_NETWORK_URL, readOpsUrl(backup.toString('utf8')));
      fs.writeFileSync(s.file, restored);
      warn(`${app}: the file changed since wiring, so only OPS_URL was put back (other edits kept)`);
    }
  }
  console.log('\n  MNG / WL-MNG restart by themselves (nodemon) in a few seconds.');
  await waitForPortals();
}

async function waitForPortals() {
  await sleep(3000);
  for (const { app, domain } of APPS) {
    let up = false;
    for (let i = 0; i < 30 && !up; i += 1) {
      const r = run('curl', ['-sk', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5', `https://${domain}/login`]);
      up = /^(2|3)\d\d$/.test(r.stdout);
      if (!up) await sleep(2000);
    }
    (up ? ok : warn)(`${app}: https://${domain} ${up ? 'is back up' : 'did not answer yet — check `docker logs nps_' + (app === 'mng' ? 'admin' : 'wl-mng') + '_web`'}`);
  }
}

// ---------- up / down / status ----------

async function waitFor(label, check, timeoutMs, everyMs = 2000) {
  const started = Date.now();
  process.stdout.write(`  … ${label}`);
  while (Date.now() - started < timeoutMs) {
    const result = await check();
    if (result) {
      process.stdout.write(` ✓ (${Math.round((Date.now() - started) / 1000)} s)\n`);
      return result;
    }
    process.stdout.write('.');
    await sleep(everyMs);
  }
  process.stdout.write(' ✗ timed out\n');
  return null;
}

// OpenSearch is built from the official no-JDK distribution on Maven Central plus this computer's JDK,
// because the office web gateway cuts downloads of the JDK bundled in the official image/tarballs.
async function prepareOpenSearchBuild() {
  const version = setting('OPENSEARCH_VERSION', '2.19.6');
  const buildDir = path.join(ROOT, 'opensearch', 'build');
  const distDir = path.join(buildDir, `opensearch-${version}`);
  const jdkDir = path.join(buildDir, 'jdk');
  fs.mkdirSync(buildDir, { recursive: true });

  if (!fs.existsSync(path.join(distDir, 'bin', 'opensearch'))) {
    const zip = path.join(buildDir, `opensearch-${version}.zip`);
    const url = `https://repo1.maven.org/maven2/org/opensearch/distribution/integ-test-zip/opensearch/${version}/opensearch-${version}.zip`;
    console.log(`  … downloading OpenSearch ${version} (no-JDK distribution, Maven Central)`);
    let done = false;
    for (let attempt = 1; attempt <= 8 && !done; attempt += 1) {
      run('curl', ['-sf', '--http1.1', '-C', '-', '--max-time', '300', '-o', zip, url]);
      const sha = run('curl', ['-sf', '--max-time', '30', `${url}.sha512`]).stdout.trim().split(/\s+/)[0];
      done = sha && sha512File(zip) === sha;
    }
    if (!done) fail(`could not download ${url} with a matching sha512`);
    const unzip = run('python3', ['-I', '-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, buildDir]);
    if (unzip.status !== 0) fail(`could not unpack ${zip}: ${unzip.stderr}`);
    fs.rmSync(zip, { force: true }); // unpacked: the 55 MB zip is not needed any more
    for (const f of fs.readdirSync(path.join(distDir, 'bin'))) fs.chmodSync(path.join(distDir, 'bin', f), 0o755);
    ok(`OpenSearch ${version} downloaded and verified (sha512)`);
  }

  if (!fs.existsSync(path.join(jdkDir, 'bin', 'java'))) {
    const javaHome = setting('JAVA_HOME');
    const java = findJava({ javaHome });
    if (!java.home) fail(javaHelp({ javaHome, javaHomeProblem: java.javaHomeProblem }));
    if (java.javaHomeProblem) warn(`JAVA_HOME (${javaHome}) ${java.javaHomeProblem}: using ${java.home} instead`);
    const cp = run('cp', ['-rL', java.home, jdkDir]);
    if (cp.status !== 0 && !fs.existsSync(path.join(jdkDir, 'bin', 'java'))) fail(`could not copy ${java.home}: ${cp.stderr}`);
    for (const extra of ['docs', 'man', 'jmods', 'include']) fs.rmSync(path.join(jdkDir, extra), { recursive: true, force: true });
    ok(`Java ${java.major} for OpenSearch copied from ${java.home}`);
  }
}

function sha512File(file) {
  try {
    return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

async function up({ fromSetup = false } = {}) {
  console.log('Starting ASTRA Local OpenSearch\n');
  fs.rmSync(STOPPED_MARK, { force: true });
  if (run('docker', ['info', '--format', '{{.ServerVersion}}']).status !== 0) fail('Docker is not running.');
  if (run('docker', ['network', 'inspect', 'nps_default']).status !== 0) {
    fail('The ASTRA docker network nps_default does not exist — start the local ASTRA stack first.');
  }
  if (!containerState('nps_redis').startsWith('running')) warn('nps_redis is not running: the shipper will wait for it.');
  if (Number(process.versions.node.split('.')[0]) < 20) fail(`Node 20 or later is needed (this is ${process.version}).`);
  for (const rel of ['mng/app/api', 'mng/extensions/server_connect/modules', 'wl-mng/app/api', 'wl-mng/extensions/server_connect/modules']) {
    if (!fs.existsSync(path.join(ASTRA_REPO, rel))) {
      fail(`${path.join(ASTRA_REPO, rel)} not found. Put the path of your payment_system checkout in .env as ASTRA_REPO=/path/to/payment_system`);
    }
  }
  // Ports already taken by something else (our own containers holding them is fine).
  for (const [port, name] of [[OS_PORT, 'OPENSEARCH_PORT'], [DASH_PORT, 'DASHBOARDS_PORT'], [SHIP_PORT, 'SHIPPER_PORT']]) {
    const users = run('docker', ['ps', '--filter', `publish=${port}`, '--format', '{{.Names}}']).stdout.trim().split('\n').filter(Boolean);
    const busy = run('bash', ['-c', `ss -ltnH 'sport = :${port}' | head -1`]).stdout.trim();
    if (busy && !users.some((u) => CONTAINERS.includes(u))) fail(`port ${port} is already used by another program. Pick another one in .env, e.g. ${name}=${Number(port) + 1}`);
  }
  // Java needs about 180 MB besides its heap; with less, Docker stops OpenSearch whenever the heap fills up.
  const heap = setting('OPENSEARCH_HEAP', '320m');
  const limit = setting('OPENSEARCH_MEM_LIMIT', '500m');
  if (megabytes(heap) && megabytes(limit) && megabytes(heap) + 180 > megabytes(limit)) {
    warn(`OPENSEARCH_HEAP=${heap} does not fit in OPENSEARCH_MEM_LIMIT=${limit}: set OPENSEARCH_MEM_LIMIT to at least ${megabytes(heap) + 180}m in .env (or remove both to use the defaults)`);
  }

  // OpenSearch image: built once (or when its Dockerfile/config change); can also be loaded ready-made (SETUP.md).
  const osVersion = setting('OPENSEARCH_VERSION', '2.19.6');
  const osImage = `astra-opensearch:${osVersion}-local`;
  // The image carries a hash of its Dockerfile + opensearch.yml, so a loaded or older image is rebuilt
  // only when those files really differ (file dates change on every clone).
  const configHash = crypto
    .createHash('sha256')
    .update(['Dockerfile', 'opensearch.yml'].map((f) => fs.readFileSync(path.join(ROOT, 'opensearch', f), 'utf8')).join('\0'))
    .digest('hex')
    .slice(0, 16);
  const imageHash = run('docker', ['image', 'inspect', osImage, '--format', '{{index .Config.Labels "astra.config_hash"}}']).stdout.trim();
  if (imageHash !== configHash) {
    await prepareOpenSearchBuild();
    const built = compose(['build', 'opensearch'], { stdio: 'inherit', env: { ...process.env, ASTRA_REPO, CONFIG_HASH: configHash } });
    if (built.status !== 0) fail('building the OpenSearch image failed (see above).');
  } else ok(`OpenSearch image ${osImage} ready`);
  if (compose(['build', 'shipper'], { stdio: 'inherit' }).status !== 0) fail('building the shipper image failed (see above).');

  const r = compose(['up', '-d', '--remove-orphans'], { stdio: 'inherit' });
  if (r.status !== 0) fail('docker compose up failed (see above).');
  console.log('');

  const health = await waitFor('OpenSearch', async () => {
    const h = await tryJson(`${OS}/_cluster/health`);
    return h && h.status === 200 && h.json.status !== 'red' ? h.json : null;
  }, 240_000);
  if (!health) fail('OpenSearch did not start. See: npm run logs -- opensearch');

  const shipped = await waitFor('Shipper: copying Redis nps-logs into OpenSearch', async () => {
    const s = await tryJson(`${SHIP}/status`);
    if (s && s.json && s.json.lag !== null) {
      process.stdout.write(`\r  … Shipper: copying Redis nps-logs into OpenSearch — ${fmt(s.json.shipped)} / ${fmt(s.json.redis.length)}   `);
      return s.json.lag === 0 ? s.json : null;
    }
    return null;
  }, 600_000, 1500);
  if (!shipped) warn('The shipper is still catching up; it continues in the background (npm run status).');

  const dash = await waitFor('OpenSearch Dashboards', async () => {
    const s = await tryJson(`${DASH}/api/status`);
    return s && s.status === 200 && s.json?.status?.overall?.state === 'green' ? s.json : null;
  }, 300_000, 3000);
  if (dash) {
    await provisionDashboards();
    ok('Dashboards set up: home dashboard, index pattern nps-app-*, saved searches for every MNG trace screen');
  } else warn('Dashboards is still starting; run `npm run up` again in a minute to finish setting it up.');

  await status({ short: true, hideWiring: fromSetup });
}

function down() {
  const r = compose(['stop'], { stdio: 'inherit' });
  if (r.status !== 0) fail('docker compose stop failed.');
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(STOPPED_MARK, `${new Date().toISOString()}\n`);
  console.log('\nStopped. Data is kept, and it stays stopped (also after a restart) until `npm run up`.');
  const wired = APPS.map(({ app }) => wiringState(app)).filter((s) => s.wired);
  if (wired.length) console.log(`Note: ${wired.map((s) => s.app).join(' and ')} still point at the local OpenSearch; trace screens will error until it is up (or run: npm run unwire).`);
}

async function status({ short = false, hideWiring = false } = {}) {
  console.log('\nASTRA Local OpenSearch\n');
  for (const c of CONTAINERS) {
    const st = containerState(c);
    (st.startsWith('running') && !st.includes('unhealthy') ? ok : bad)(`${c.padEnd(28)} ${st}`);
  }
  const s = await tryJson(`${SHIP}/status`);
  const idx = await tryJson(`${SHIP}/api/indices`);
  console.log('');
  if (s && s.json) {
    const j = s.json;
    const docs = Array.isArray(idx?.json) ? idx.json.filter((i) => i.index.startsWith('nps-app-')).reduce((n, i) => n + i.docs, 0) : null;
    (j.redis.connected ? ok : bad)(`Redis ${j.redis.list}: ${fmt(j.redis.length)} entries`);
    (j.opensearch.reachable ? ok : bad)(`OpenSearch nps-app-*: ${fmt(docs)} documents`);
    (j.lag === 0 ? ok : warn)(j.lag === 0 ? 'Shipper: live, nothing waiting' : `Shipper: ${fmt(j.lag)} entries waiting`);
    const size = (await tryJson(`${SHIP}/api/size`))?.json;
    if (size) {
      const keep = j.retention_days ? `last ${j.retention_days} days` : 'everything';
      info(`Trace data: ${(size.data_bytes / 1048576).toFixed(1)} MB · keeps ${keep}${j.cleared_at ? ` (cleared ${j.cleared_at.slice(0, 16).replace('T', ' ')} UTC)` : ''} · free it now: npm run clear`);
    }
    (j.rejected ? warn : ok)(`Rejected by OpenSearch: ${fmt(j.rejected)}${j.rejected ? ' (kept in astra-shipper-rejected)' : ''}`);
    const recentError = j.last_error_at && Date.now() - Date.parse(j.last_error_at) < 120_000;
    if (j.last_error && (!j.redis.connected || !j.opensearch.reachable || (j.lag > 0 && recentError))) info(`last error: ${j.last_error}`);
  } else bad(`Shipper not reachable at ${SHIP}`);

  console.log('');
  for (const { app } of hideWiring ? [] : APPS) {
    const w = wiringState(app);
    if (!w.exists) warn(`${app}: config.json not found`);
    else if (w.wired) ok(`${app}: wired → reads traces from this local OpenSearch`);
    else warn(`${app}: not wired (OPS_URL = ${hostOf(w.url)}) — run: npm run wire`);
  }
  const guardOn = run('systemctl', ['--user', 'is-active', `${GUARD}.timer`]).stdout.trim() === 'active';
  (guardOn ? ok : warn)(guardOn ? 'Background check: on (at login and every 10 minutes)' : 'Background check: off — turn it on with: npm run autostart');
  console.log(`\n  OpenSearch Dashboards (home):  ${HOME}`);
  if (!short) console.log('\n  Full check: npm run doctor');
}

function logs(args) {
  const follow = args.includes('-f');
  const which = args.find((a) => !a.startsWith('-'));
  const services = { shipper: 'shipper', opensearch: 'opensearch', dashboards: 'dashboards' };
  const svc = which ? services[which] : 'shipper';
  if (!svc) fail(`unknown service "${which}" (shipper, opensearch, dashboards)`);
  compose(['logs', '--tail', '200', ...(follow ? ['-f'] : []), svc], { stdio: 'inherit' });
}

// ---------- trace lookups (same query as the MNG screen) ----------

const TRACE_KINDS = {
  tx: ['tx-trace', ['tx_id']],
  notes: ['tx-notes', ['tx_id']],
  account: ['account-trace', ['account_id']],
  'internal-notes': ['internal-notes', ['from_date', 'to_date']],
  'wl-trace': ['wl-tx-trace', ['tx_id']],
};

function dayRange(from, to) {
  // like the MNG report: whole days in this computer's time zone, sent as UTC
  const f = new Date(`${from}T00:00:00`);
  const t = new Date(`${to}T23:59:59.999`);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) fail('dates must look like 2026-10-01');
  return [f.toISOString(), t.toISOString()];
}

async function trace(args) {
  const [what, ...rest] = args;
  const spec = TRACE_KINDS[what];
  if (!spec) {
    fail('usage: npm run trace -- tx <id> | notes <id> | account <id> | internal-notes <from> <to> | wl-trace <id>');
  }
  const [kind, names] = spec;
  if (rest.length < names.length) fail(`${what} needs: ${names.join(' ')}`);
  let values = rest.slice(0, names.length);
  if (kind === 'internal-notes') values = dayRange(values[0], values[1]);
  const qs = new URLSearchParams({ kind, ...Object.fromEntries(names.map((n, i) => [n, values[i]])) });
  const r = await tryJson(`${SHIP}/api/lookup?${qs}`, { timeout: 60_000 });
  if (!r) fail(`the shipper is not reachable at ${SHIP} — run: npm run up`);
  if (r.json?.error) fail(r.json.error);
  const j = r.json;
  console.log(`\n${j.label} — ${fmt(j.count)} row${j.count === 1 ? '' : 's'}   (same query as ${j.where})`);
  console.log(`  ${j.action_file} → ${j.module_file}, ${j.took_ms} ms\n`);
  const rows = j.rows.map((row) =>
    kind === 'internal-notes'
      ? [row.ts, String(row.t_id ?? ''), String(row.uid ?? ''), (row.aux?.post?.note || '').slice(0, 80)]
      : [row.ts, row.e_event, row.level, String(row.uid ?? ''), (typeof row.msg === 'object' ? JSON.stringify(row.msg) : String(row.msg ?? '')).slice(0, 90)],
  );
  const head = kind === 'internal-notes' ? ['ts (UTC)', 't_id', 'uid', 'note'] : ['ts (UTC)', 'e_event', 'level', 'uid', 'msg'];
  printTable(head, rows);
  console.log(`\n  In Dashboards: ${discoverUrl(j.dql, j.params.from_date || 'now-7d', j.params.to_date || 'now')}`);
}

function printTable(head, rows) {
  if (!rows.length) {
    console.log('  (no rows — MNG would show "no records found")');
    return;
  }
  const widths = head.map((h, i) => Math.min(60, Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length))));
  const line = (cells) => `  ${cells.map((c, i) => String(c ?? '').slice(0, widths[i]).padEnd(widths[i])).join('  ')}`;
  console.log(line(head));
  console.log(line(widths.map((w) => '─'.repeat(w))));
  rows.forEach((r) => console.log(line(r)));
}

// ---------- doctor ----------

async function doctor() {
  let problems = 0;
  const check = (pass, good, badMsg) => {
    if (pass) ok(good);
    else {
      bad(badMsg);
      problems += 1;
    }
  };
  console.log('\nDoctor — ASTRA Local OpenSearch\n');

  console.log('Containers');
  for (const c of CONTAINERS) {
    const st = containerState(c);
    check(st.startsWith('running') && !st.includes('unhealthy'), `${c} ${st}`, `${c} ${st} — run: npm run up`);
  }

  console.log('\nOpenSearch');
  const h = await tryJson(`${OS}/_cluster/health`);
  check(h?.json && h.json.status !== 'red', `cluster ${h?.json?.status} (${h?.json?.cluster_name})`, 'not reachable / red');
  const canonical = (v) =>
    Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
  for (const [name, file, label] of [
    ['nps-app', 'index-template.json', 'index template nps-app-* (strings keyword, ts/@timestamp date)'],
    ['nps-app-fallback', 'index-template-fallback.json', 'fallback template nps-app-*-fallback'],
  ]) {
    const tpl = await tryJson(`${OS}/_index_template/${name}`);
    const want = JSON.parse(fs.readFileSync(path.join(ROOT, 'shipper', file), 'utf8'));
    const have = tpl?.json?.index_templates?.[0]?.index_template;
    const same = have && JSON.stringify(canonical(have.template.mappings)) === JSON.stringify(canonical(want.template.mappings));
    check(same, `${label} in place`, `${label} missing or different — run: npm run up`);
  }

  console.log('\nShipper');
  const s = (await tryJson(`${SHIP}/status`))?.json;
  check(s?.redis?.connected, `reads Redis ${s?.redis?.list} (${fmt(s?.redis?.length)} entries)`, 'cannot read Redis');
  check(s && s.lag === 0, 'live: every entry in the list is shipped', `${fmt(s?.lag)} entries still waiting`);
  if (s && s.lag > 0 && s.last_error) info(`last error: ${s.last_error}`);
  if (s?.rejected) warn(`${fmt(s.rejected)} entries could not be stored (not JSON, e.g. blank lines, or refused by OpenSearch): see index astra-shipper-rejected in Dashboards`);

  // Sample entries straight from Redis and find each one in OpenSearch.
  const len = Number(run('docker', ['exec', 'nps_redis', 'redis-cli', 'LLEN', 'nps-logs']).stdout.trim());
  if (len > 0) {
    const picks = [...new Set([0, len - 1, ...Array.from({ length: 18 }, () => Math.floor(Math.random() * len))])];
    let found = 0;
    let checked = 0;
    for (const i of picks) {
      const raw = run('docker', ['exec', 'nps_redis', 'redis-cli', '--raw', 'LINDEX', 'nps-logs', String(i)]).stdout.replace(/\n$/, '');
      let e;
      try {
        e = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!e || typeof e !== 'object' || !e.ts) continue;
      if (s?.kept_from && Date.parse(e.ts) < Date.parse(s.kept_from)) continue; // older than what is kept, on purpose
      checked += 1;
      const filter = [{ term: { ts: e.ts } }];
      if (e.e_id !== undefined && e.e_id !== '') filter.push({ term: { e_id: String(e.e_id) } });
      if (e.e_event) filter.push({ term: { e_event: e.e_event } });
      const q = await tryJson(`${OS}/nps-app-*/_count`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: { bool: { filter } } }) });
      if (q?.json?.count > 0) found += 1;
    }
    check(found === checked, `${found}/${checked} entries sampled from Redis (oldest, newest, random) are in OpenSearch`, `only ${found}/${checked} sampled entries found in OpenSearch`);
  }
  // Exact: every entry in the list has exactly its own document (retried once, in case new entries were in flight).
  let par = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    par = (await tryJson(`${SHIP}/api/parity`, { timeout: 180_000 }))?.json;
    if (!par || par.missing_in_opensearch === 0) break;
    await sleep(2000);
  }
  const rejectedNote = par?.rejected_entries ? `; the ${fmt(par.rejected_entries)} that could not be stored are in astra-shipper-rejected` : '';
  check(
    par && par.missing_in_opensearch === 0,
    par && par.kept_entries + (par.rejected_entries || 0) !== par.redis_entries
      ? `exact check: all ${fmt(par.kept_entries)} entries kept (the newer part of the ${fmt(par.redis_entries)} in Redis) are in OpenSearch, each once${rejectedNote}`
      : `exact check: all ${fmt(par?.kept_entries)} Redis entries are in OpenSearch, each once${rejectedNote}`,
    par ? `${fmt(par.missing_in_opensearch)} Redis entries are not in OpenSearch` : 'exact check could not run (shipper not reachable)',
  );
  if (par?.not_in_redis) warn(`${fmt(par.not_in_redis)} documents are no longer in the Redis list (kept history after Redis was trimmed or flushed, or a duplicate): ${SHIP}/api/parity`);

  console.log('\nMNG / WL-MNG');
  // a recent transaction with trace rows, to compare both query paths on
  const recent = await tryJson(`${OS}/nps-app-*/_search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ size: 1, sort: [{ ts: 'desc' }], query: { bool: { filter: [{ term: { p_key: 'TRANSACTION' } }, { term: { entry_type: 'TRACE' } }] } }, _source: ['p_value'] }),
  });
  const txId = recent?.json?.hits?.hits?.[0]?._source?.p_value;
  for (const { app, container } of APPS) {
    const w = wiringState(app);
    check(w.exists && w.wired, `${app}: config OPS_URL → ${IN_NETWORK_URL}`, `${app}: not wired (OPS_URL = ${hostOf(w.url)}) — run: npm run wire`);
    // Can the portal container reach it? (read-only check inside the running product container)
    const reach = run('docker', ['exec', container, 'node', '-e', `fetch(${JSON.stringify(IN_NETWORK_URL)}).then(r=>r.json()).then(j=>console.log(j.cluster_name)).catch(e=>console.log('ERR '+e.message))`]);
    check(reach.stdout.includes('astra-local'), `${container} reaches ${IN_NETWORK_URL}`, `${container} cannot reach ${IN_NETWORK_URL}: ${(reach.stdout + reach.stderr).trim().slice(0, 160)}`);
  }
  if (txId) {
    // The product's module, run by the product's node inside the MNG container, versus the status-page lookup.
    const inside = run('docker', ['exec', '-e', `OPS_URL=${IN_NETWORK_URL}`, 'nps_admin_web', 'node', '-e', `
      const m = require('/opt/node_app/extensions/server_connect/modules/opensearch-query.js');
      m.ops_query.call({ parse: (v) => v }, { output_fields: 'e_event,msg,level,ts,uid,aux,domain', sort_field: 'ts', p_key: 'TRANSACTION', p_value: ${JSON.stringify(String(txId))}, entry_type: ['TRACE','NOTE'] })
        .then((rows) => console.log('ROWS', rows.length)).catch((e) => console.log('ERR', e.message));`]);
    const insideRows = Number((inside.stdout.match(/ROWS (\d+)/) || [])[1]);
    const page = await tryJson(`${SHIP}/api/lookup?kind=tx-trace&tx_id=${encodeURIComponent(txId)}`, { timeout: 60_000 });
    check(
      Number.isFinite(insideRows) && insideRows > 0 && page?.json?.count === insideRows,
      `Transaction Trace of tx ${txId}: ${insideRows} rows from MNG's own code inside nps_admin_web = ${page?.json?.count} from the shipper`,
      `Transaction Trace of tx ${txId}: MNG container ${inside.stdout.trim() || inside.stderr.trim().slice(0, 160)}, shipper ${page?.json?.count ?? page?.json?.error}`,
    );
  } else warn('no transaction trace rows in OpenSearch yet — create a transaction locally, then run doctor again');

  console.log('\nDashboards');
  const ip = await tryJson(`${DASH}/api/saved_objects/index-pattern/nps-app`);
  const homeDash = await tryJson(`${DASH}/api/saved_objects/dashboard/${HOME_DASHBOARD}`);
  check(ip?.status === 200 && homeDash?.status === 200, `home dashboard and nps-app-* ready: ${HOME}`, 'Dashboards not set up — run: npm run up');
  const health = await tryJson(`${OS}/astra-shipper-health/_doc/current`);
  const age = health?.json?._source ? (Date.now() - Date.parse(health.json._source.updated_at)) / 1000 : null;
  check(age !== null && age < 120, `health on the home dashboard is current (updated ${Math.round(age)} s ago)`, 'the home dashboard health is not being updated — run: npm run up');

  console.log(problems ? `\n✗ ${problems} problem(s) found.` : '\n✓ All good: local traces work end to end.');
  process.exitCode = problems ? 1 : 0;
  return problems;
}

// ---------- keeping it running (background check) ----------

/**
 * Run by the background check at login and every 10 minutes. Docker already restarts the containers after a
 * reboot; this repairs what Docker cannot: containers removed (e.g. a docker cleanup), or cut off from the
 * ASTRA network when a redeploy recreated nps_default. Does nothing after `npm run down`. Never touches MNG config.
 */
async function ensure() {
  const say = (m) => console.log(`${new Date().toISOString()} ${m}`);
  if (fs.existsSync(STOPPED_MARK)) return say('stopped on purpose (npm run down): nothing to do');
  if (run('docker', ['info', '--format', '{{.ServerVersion}}']).status !== 0) return say('Docker is not running yet: checking again later');
  if (run('docker', ['network', 'inspect', 'nps_default']).status !== 0 || !containerState('nps_redis').startsWith('running')) {
    return say('the local ASTRA stack is not running: nothing to do until it is');
  }
  const broken = [];
  for (const c of CONTAINERS) {
    const st = containerState(c);
    const nets = st === 'missing' ? '' : run('docker', ['inspect', c, '--format', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}']).stdout;
    if (st === 'missing' || !st.startsWith('running') || st.includes('unhealthy') || !nets.includes('nps_default')) {
      broken.push({ c, why: st === 'missing' ? 'missing' : !nets.includes('nps_default') ? 'not on the ASTRA network' : st });
    }
  }
  if (!broken.length) {
    // Shipper up for a while but still cannot reach Redis / OpenSearch?
    const s = (await tryJson(`${SHIP}/status`))?.json;
    if (s && Date.now() - Date.parse(s.started_at) > 120_000 && (!s.redis.connected || !s.opensearch.reachable)) {
      broken.push({ c: 'astra-log-shipper', why: `cannot reach ${!s.redis.connected ? 'Redis' : 'OpenSearch'}` });
    }
  }
  if (!broken.length) return say('all running');

  say(`repairing: ${broken.map((b) => `${b.c} (${b.why})`).join(', ')}`);
  const imagesMissing = ['astra-log-shipper:local', `astra-opensearch:${setting('OPENSEARCH_VERSION', '2.19.6')}-local`].some(
    (img) => run('docker', ['image', 'inspect', img]).status !== 0,
  );
  if (imagesMissing) {
    await up();
    return;
  }
  const r = compose(['up', '-d', '--force-recreate', ...broken.map((b) => SERVICE_OF[b.c])], { stdio: 'inherit' });
  if (r.status !== 0) fail('repair failed (see above); run: npm run up');
  const back = await waitFor('back to normal', async () => {
    const s = (await tryJson(`${SHIP}/status`))?.json;
    return s && s.redis.connected && s.opensearch.reachable ? s : null;
  }, 180_000, 3000);
  say(back ? 'repaired' : 'still not right after 3 minutes; run: npm run doctor');
}

function autostart(on = true) {
  const service = path.join(UNIT_DIR, `${GUARD}.service`);
  const timer = path.join(UNIT_DIR, `${GUARD}.timer`);
  if (run('systemctl', ['--user', 'show-environment']).status !== 0) {
    warn('systemd user services are not available here, so there is no background check. Docker still restarts it after a reboot.');
    return false;
  }
  if (!on) {
    run('systemctl', ['--user', 'disable', '--now', `${GUARD}.timer`]);
    fs.rmSync(service, { force: true });
    fs.rmSync(timer, { force: true });
    run('systemctl', ['--user', 'daemon-reload']);
    ok('Background check turned off');
    return true;
  }
  fs.mkdirSync(UNIT_DIR, { recursive: true });
  fs.writeFileSync(
    service,
    `[Unit]
Description=Local OpenSearch for ASTRA traces: check it is running and repair it if not

[Service]
Type=oneshot
WorkingDirectory=${ROOT}
ExecStart=${process.execPath} ${path.join(ROOT, 'scripts', 'cli.mjs')} ensure
`,
  );
  fs.writeFileSync(
    timer,
    `[Unit]
Description=Check Local OpenSearch at login and every 10 minutes

[Timer]
OnStartupSec=90s
OnUnitActiveSec=10min
Unit=${GUARD}.service

[Install]
WantedBy=timers.target
`,
  );
  run('systemctl', ['--user', 'daemon-reload']);
  const en = run('systemctl', ['--user', 'enable', '--now', `${GUARD}.timer`]);
  if (en.status !== 0) {
    warn(`could not turn on the background check: ${en.stderr.trim()}`);
    return false;
  }
  ok('Background check on: at login and every 10 minutes it makes sure everything runs (log: journalctl --user -u local-opensearch-guard)');
  return true;
}

// ---------- setup: the whole first-time setup in one command ----------

/** Everything this laptop needs, as plain-English checks with the fix for each one that fails. */
function setupChecks() {
  const checks = [];
  const add = (pass, label, fix) => checks.push({ pass, label, fix });
  const dockerOk = run('docker', ['info', '--format', '{{.ServerVersion}}']).status === 0;
  add(dockerOk, 'Docker is running', 'Start Docker (sudo systemctl start docker), or install Docker Engine.');
  add(dockerOk && run('docker', ['compose', 'version']).status === 0, 'Docker Compose is installed', 'Install the Docker Compose plugin (sudo apt install docker-compose-plugin).');
  add(Number(process.versions.node.split('.')[0]) >= 20, `Node 20 or newer (you have ${process.version})`, 'Install Node 20 or newer (for example with nvm: nvm install 20).');
  const astraUp = dockerOk && ['nps_redis', 'nps_admin_web', 'nps_wl-mng_web'].every((c) => containerState(c).startsWith('running'));
  add(astraUp, 'Your local ASTRA stack is running', 'Start your local ASTRA stack first (docker ps must list nps_redis, nps_admin_web and nps_wl-mng_web).');
  add(
    fs.existsSync(path.join(ASTRA_REPO, 'mng', 'app', 'api')),
    `Your payment_system folder is found (${ASTRA_REPO})`,
    'Tell it where payment_system is: echo "ASTRA_REPO=/path/to/payment_system" > .env',
  );
  const image = `astra-opensearch:${setting('OPENSEARCH_VERSION', '2.19.6')}-local`;
  const haveImage = dockerOk && run('docker', ['image', 'inspect', image]).status === 0;
  const haveBuild = fs.existsSync(path.join(ROOT, 'opensearch', 'build', 'jdk', 'bin', 'java'));
  // Java is only needed to build the image the first time; look for one only then.
  const javaHome = setting('JAVA_HOME');
  const java = haveImage || haveBuild ? null : findJava({ javaHome });
  add(
    haveImage || haveBuild || Boolean(java?.home),
    haveImage ? 'OpenSearch image is already here' : haveBuild ? 'Java for OpenSearch is already copied' : java?.home ? `Java ${java.major} found (${java.home})` : 'A Java 17 to 21 is on this computer',
    javaHelp({ javaHome, javaHomeProblem: java?.javaHomeProblem }),
  );
  for (const [port, name] of [[OS_PORT, 'OPENSEARCH_PORT'], [DASH_PORT, 'DASHBOARDS_PORT'], [SHIP_PORT, 'SHIPPER_PORT']]) {
    const users = dockerOk ? run('docker', ['ps', '--filter', `publish=${port}`, '--format', '{{.Names}}']).stdout.trim().split('\n').filter(Boolean) : [];
    const busy = run('bash', ['-c', `ss -ltnH 'sport = :${port}' | head -1`]).stdout.trim();
    add(!busy || users.some((u) => CONTAINERS.includes(u)), `Port ${port} is free`, `Something else uses port ${port}. Pick another: echo "${name}=${Number(port) + 1}" >> .env`);
  }
  const freeGb = Number(run('bash', ['-c', "df -Pk /var/lib/docker 2>/dev/null | awk 'NR==2{print $4}' || df -Pk / | awk 'NR==2{print $4}'"]).stdout.trim()) / 1024 / 1024;
  add(!freeGb || freeGb >= 4, `At least 4 GB of free disk (${freeGb ? `${freeGb.toFixed(0)} GB free` : 'unknown'})`, 'Free up some disk space (the first setup downloads about 2 GB).');
  return checks;
}

async function ask(question) {
  if (!process.stdin.isTTY) return null;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return answer;
}

// ---------- freeing disk space ----------

/** Deletes all trace data now; from then on only new log lines are kept (nothing old flows back from Redis). */
async function clear() {
  const s = (await tryJson(`${SHIP}/status`))?.json;
  if (!s) fail(`the shipper is not reachable at ${SHIP} — run: npm run up`);
  if (!args.includes('--yes') && !args.includes('-y')) {
    const answer = await ask('Delete ALL local trace data now (Dashboards and MNG trace screens start empty, new logs keep coming)? [y/N] ');
    if (answer === null) fail('add --yes to confirm (npm run clear -- --yes)');
    if (!answer.startsWith('y')) return console.log('Nothing deleted.');
  }
  const r = await tryJson(`${SHIP}/api/clear`, { method: 'POST', timeout: 90_000 });
  if (!r || r.status !== 200) fail(`clear failed: ${r?.json?.error || 'shipper not reachable'}`);
  ok(`Cleared ${(r.json.freed_bytes / 1048576).toFixed(1)} MB of trace data. Only log lines from now on are kept.`);
}

/** Removes everything this tool put on the laptop (data, containers, images, background check). */
async function remove() {
  console.log(`This removes Local OpenSearch from this laptop:
  - puts the original MNG / WL-MNG config back (npm run unwire)
  - turns the background check off
  - deletes the containers, ALL trace data and the Docker images (about 2.3 GB)
  - deletes the local OpenSearch build (opensearch/build)
The repo folder itself stays; delete it yourself if you want.`);
  if (!args.includes('--yes') && !args.includes('-y')) {
    const answer = await ask('\nRemove it? [y/N] ');
    if (answer === null) fail('add --yes to confirm (npm run remove -- --yes)');
    if (!answer.startsWith('y')) return console.log('Nothing removed.');
  }
  if (APPS.some(({ app }) => wiringState(app).wired)) await unwire();
  autostart(false);
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(STOPPED_MARK, `${new Date().toISOString()}\n`);
  const r = compose(['down', '-v', '--rmi', 'all', '--remove-orphans'], { stdio: 'inherit' });
  if (r.status !== 0) warn('docker compose down reported a problem (see above)');
  fs.rmSync(path.join(ROOT, 'opensearch', 'build'), { recursive: true, force: true });
  ok('Removed. To set it up again later: npm run setup');
}

async function setup() {
  const yes = args.includes('--yes') || args.includes('-y');
  console.log('\nLocal OpenSearch setup\n======================\n');
  console.log('Step 1 of 4 — Checking your laptop\n');
  const checks = setupChecks();
  for (const c of checks) (c.pass ? ok : bad)(c.label);
  const missing = checks.filter((c) => !c.pass);
  if (missing.length) {
    console.log('\nPlease fix these first, then run  npm run setup  again:\n');
    missing.forEach((c, i) => console.log(`  ${i + 1}. ${c.fix.split("\n").join("\n     ")}`));
    process.exit(1);
  }

  console.log('\nStep 2 of 4 — Starting OpenSearch, Dashboards and the log copier (first time: 3–5 minutes)\n');
  await up({ fromSetup: true });

  console.log('\nStep 3 of 4 — Connecting your local MNG and WL-MNG\n');
  if (APPS.every(({ app }) => wiringState(app).wired)) ok('Already connected');
  else {
    info('This changes one setting (OPS_URL) in your local mng and wl-mng config files so their');
    info('trace and notes screens read from this OpenSearch. The original files are saved first;');
    info('"npm run unwire" puts them back exactly.');
    const answer = yes ? 'y' : await ask('\n  Connect them now? [Y/n] ');
    if (answer === null) warn('Not asked (no keyboard input). Run  npm run wire  yourself to connect them.');
    else if (answer === '' || answer.startsWith('y')) await wire();
    else warn('Skipped. Run  npm run wire  whenever you want to connect them.');
  }

  console.log('\nKeeping it running after restarts\n');
  autostart(true);

  console.log('\nStep 4 of 4 — Testing it end to end');
  const problems = await doctor();
  if (problems) {
    console.log('\nAlmost there: fix the ✗ lines above (each one says how), then run  npm run doctor  again.');
    return;
  }
  console.log(`
You're all set!

  Try it in MNG:   open Transactions, then the "Transaction Trace" or "Add Internal Note" icon on any row
  Dashboards:      ${HOME}
                   (the same screens as mnops.cdmx.io, for your local data: health, trace searches, clear button)

It starts by itself whenever your laptop starts, even after weeks off. To update later:  git pull --ff-only && npm run setup`);
}

// ---------- main ----------

const [cmd, ...args] = process.argv.slice(2);
const commands = {
  setup,
  up,
  ensure,
  autostart: () => autostart(true),
  'autostart:off': () => autostart(false),
  clear,
  remove,
  down,
  status: () => status(),
  doctor,
  wire,
  unwire,
  logs: () => logs(args),
  trace: () => trace(args),
  dashboards: async () => {
    await provisionDashboards();
    ok(`Dashboards set up: ${HOME}`);
  },
};
if (!commands[cmd]) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(cmd ? 1 : 0);
}
await commands[cmd]();
