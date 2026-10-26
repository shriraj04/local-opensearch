# ASTRA Local OpenSearch

Makes the OpenSearch-based screens work on the local `.local` domains, with real data from your local runs:

| Screen | Where |
| --- | --- |
| Transaction Trace | MNG › Transactions › (row) › Transaction Trace |
| Notes | MNG › Transactions › (row) › Notes |
| Account Trace | MNG › Accounts & Users › Accounts › (row) › Account Trace |
| Internal Notes report | MNG › Reports › Internal Notes |
| Transaction Trace | WL-MNG › Transactions › (row) |

It also gives you **OpenSearch Dashboards**, the same Discover screen you use on `mnops.cdmx.io`, but for your local logs.

Nothing is mocked. Every portal and n8n already write their log entries into the local Redis list `nps-logs`. On Alpha/Omega a shipper copies that list into OpenSearch (`nps-app-*`). Locally nothing did that, and MNG pointed at an OpenSearch it cannot reach, so those screens failed. This project adds the missing pieces:

```
portals + n8n ──RPUSH──▶ Redis nps-logs ──(read only)──▶ log shipper ──▶ OpenSearch nps-app-YYYY.MM.DD ──▶ MNG / WL-MNG screens
                              │                                                │
                              └──▶ Redis Log Viewer (unchanged)                └──▶ OpenSearch Dashboards
```

The list grows at **both ends**: the portals add entries at the end, and n8n's Redis node adds them at the front. The shipper tracks what it has copied as a window that new entries join from either side. Each step happens in one atomic, read-only Redis call (`EVAL_RO`), so an idle check costs a few tiny reads and only new entries are ever read.

## Start

**New here? Follow the [Easy Setup Guide](QUICK-SETUP.md): 3 steps, about 10 minutes.** Using Claude Code? [Paste one prompt](QUICK-SETUP.md#easiest-let-claude-code-do-it) and it does the setup for you (skill: `.claude/skills/local-opensearch`). Full details are in [SETUP.md](SETUP.md).

```bash
cd ~/payment_system && git clone git@github.com:shriraj04/local-opensearch.git
echo "local-opensearch/" >> .git/info/exclude      # never commit it into payment_system
cd local-opensearch && npm run setup                # checks the laptop, starts it, connects MNG, tests it
```

Needs Docker, Node 20+, Java 17 or 21 on this computer (found in `/usr/lib/jvm` or `JAVA_HOME`; not needed when the image is loaded ready-made, see SETUP.md), and the local ASTRA stack running (network `nps_default`, container `nps_redis`).

It starts by itself after a reboot, like the ASTRA containers do, and continues from where it stopped; it does not re-read everything. A small background check (`npm run autostart`, which `npm run setup` turns on) runs at login and every 10 minutes and repairs anything Docker cannot, such as a removed container or a recreated `nps_default` network. `npm run down` stops it until the next `npm run up`, and the background check then leaves it alone.

### Resources (hard limits)

Each container has a CPU and memory ceiling, so it can never take over the laptop. Docker's log files are capped at 30 MB per container.

| Container | Limit | Measured |
| --- | --- | --- |
| `astra-opensearch` | 1.5 CPU, 1.5 GB (Java heap 768 MB) | about 830 MB; under 2% CPU when idle |
| `astra-opensearch-dashboards` | 1 CPU, 1 GB | about 215 MB; about 0% when idle |
| `astra-log-shipper` | 0.5 CPU, 256 MB | about 17 MB; under 1% CPU when idle |

The heaviest moment is reading the whole Redis list again, after a restart for example. That is about 77,000 entries, done in about 3 seconds at about 1 CPU. Change the limits in `.env` (`OPENSEARCH_CPUS`, `OPENSEARCH_MEM_LIMIT`, `OPENSEARCH_HEAP`, …) if needed.

### How much disk it uses

Each log line takes about 250 bytes. n8n's scheduled jobs alone write about 6,000 lines an hour (the processor-status cron writes about 1,000 lines every 10 minutes). So the shipper keeps only the **last 5 days** (today plus the 4 days before) and removes older days by itself, which is usually a few MB in total. Change it with `RETENTION_DAYS` in `.env` (`0` = keep everything), then run `npm run up`.

- **Free space right now:** the red **Clear all trace data** button on the Dashboards home page, or `npm run clear`. It deletes all trace data at once; new log lines keep coming in, and nothing old comes back from Redis.
- **Remove everything** (data, containers, background check and the Docker images, about 2.3 GB, the biggest part): `npm run remove`. It asks first, and also puts MNG's original config back.

These lines appear even when nobody is logged in: n8n's crons run all the time, and every MNG page request (even the login page) is logged with `uid 0`.

### Why OpenSearch is built locally

The office web gateway (Cloudflare WARP) cuts the download of the Java runtime bundled inside the official OpenSearch image and tarballs. The download always stops in `jdk/jmods/java.base.jmod`. So `npm run up` instead builds the image from:

- the official **no-JDK** OpenSearch distribution from Maven Central (`org.opensearch.distribution.integ-test-zip`, 2.19.6), checked against its sha512 (and its PGP signature, which is good), and
- the Java 17 that is already installed on this computer.

It is the same OpenSearch engine. The bundled plugins (security, alerting, k-NN, …) are not included; nothing here uses them. On a network without that gateway, the official image would also work.

## Commands

| Command | What it does |
| --- | --- |
| `npm run setup` | First-time setup in one go: checks the laptop (each ✗ says how to fix it), starts everything, asks before connecting MNG / WL-MNG, then runs the doctor. Safe to run again. |
| `npm run up` | Starts OpenSearch, Dashboards and the log shipper (or updates them), waits until everything in Redis is copied, and sets up Dashboards. Safe to run again. |
| `npm run status` | Whether everything is running, how many entries are copied, and whether MNG is wired. |
| `npm run doctor` | Full check. It finds entries sampled from Redis in OpenSearch, checks that MNG can reach OpenSearch, and runs the Transaction Trace query with **MNG's own code inside the MNG container**, comparing the result with the same query run by the shipper. |
| `npm run wire` | Sets `OPS_URL` in `mng/app/config/config.json` and `wl-mng/app/config/config.json` to `http://astra-opensearch:9200`. Nothing else in those files changes. The original files are saved in `~/.config/astra-local/opensearch-wiring/`. The portals restart by themselves. |
| `npm run unwire` | Puts the original files back byte for byte. If someone edited a file since, only `OPS_URL` is put back and their edits are kept. |
| `npm run trace -- tx 189444` | Transaction Trace for a transaction, in the terminal. Also `notes 189444`, `account 140`, `internal-notes 2026-10-01 2026-10-23`, `wl-trace 189444`. |
| `npm run logs` | The shipper's own output. Use `npm run logs -- opensearch` or `-- dashboards` for the others, and add `-- -f` to keep following. |
| `npm run down` | Stops the containers. The data is kept, and it stays stopped (also after a reboot) until `npm run up`. |
| `npm run autostart` / `autostart:off` | Turns the background check on or off: at login and every 10 minutes it repairs a removed container or a lost network. Its log: `journalctl --user -u local-opensearch-guard`. |
| `npm run ensure` | Runs that check once, now. |
| `npm run clear` | Deletes all trace data now, to free disk space (the same as the red **Clear all trace data** button on the Dashboards home page). New log lines keep coming in. Older days are also removed by themselves after 5 days. |
| `npm run remove` | Removes everything it put on the laptop: puts MNG's config back, deletes the containers, data, Docker images (about 2.3 GB) and the background check. It asks first. |
| `npm test` | Unit tests. |

## The page

Everything is in **OpenSearch Dashboards**, at http://127.0.0.1:5601 (127.0.0.1 only). It opens on the **ASTRA Local OpenSearch** home dashboard, which refreshes every 30 s:

- **Health:** log lines waiting to be shipped (0 = live), log lines kept, trace data on disk, rejected entries, and when the health was last updated.
- **Links to one search per MNG screen:** MNG Transaction Trace, Notes, Account Trace, the Internal Notes report, the WL-MNG trace, errors and n8n. Add `and p_value:"<id>"` for one transaction or account.
- **The latest Transaction Trace rows.**
- **Clear all trace data:** a red button that opens a small confirmation page, then empties the data. New log lines keep coming in. (It is a Vega panel, the only panel type that can be styled; for its link Dashboards runs with `VEGA_ENABLEEXTERNALURLS=true`, local only.)

The shipper's own address (`127.0.0.1:9700`) is only a background API for the CLI, plus that confirmation page; opening it takes you to Dashboards. To run MNG's exact query code from the terminal, use `npm run trace -- tx <id>`.

## How close is it to Alpha / Omega?

**The same:**
- **Documents:** each document is the Redis entry exactly as the app wrote it, plus `@timestamp`, like on `mnops.cdmx.io`.
- **Indices:** `nps-app-*`, like remote. Locally there is one per day (`nps-app-YYYY.MM.DD`) instead of one per month, so old days can be dropped cheaply; MNG searches all indices, so this makes no difference.
- **Field types:** text fields are `keyword`, as on remote. That is why MNG's `terms` filter on `entry_type` works and why `domain` / `git_version` can be aggregated without `.keyword`. `ts` and `@timestamp` are dates.
- **Queries:** MNG and WL-MNG run their own unchanged code (`opensearch-query.js`) against it. `npm run trace` also run that module, with the options from the action files of the branch that is checked out.
- **Cross-tenant rows:** all local tenants (Alpha, Omega, white-labels) share one cluster, just as remote environments share one. So behaviour like an account's trace listing rows from another environment with the same id (PRE-03) shows up locally too.

**Different, on purpose:**
- **No TLS and no login on the local OpenSearch.** It is only reachable from this computer and the ASTRA containers. MNG still sends its usual user/password, which is simply ignored.
- **`_id`:** a fixed hash of the entry rather than a random id, so a restart never creates duplicates. MNG never reads `_id`.
- **`@timestamp`:** an entry copied as it happens gets the time it was copied, as on remote (about 0.1 s after `ts`). An entry copied late, for example when the shipper was off, gets its own `ts`.
- **`aux`:** stored as a `flat_object`, and text longer than 8,191 characters is kept but not searchable. As a result, entries whose `aux` changes shape between writers, or that carry very large values, are never refused. On remote, such entries may be refused; any entry OpenSearch still refuses here is kept in `astra-shipper-rejected` with the reason.

**History:** the shipper copies what is in Redis `nps-logs` now, then everything new as it happens. Local logs that were never in Redis cannot be recovered.

## Verified on local Alpha (23 Oct 2026, master @ 3102da2caf)

Logged in to `qa-alpha-astramng.local` as Management through the real identity provider:

| Check | Result |
| --- | --- |
| Transaction Trace, old: tx 189433 (internal payout, 21 Oct) | 20 of 20 rows. "Triggered By" is resolved to names by MNG. |
| Internal Notes, new: note added to 189433 | Saved (200). It appeared in the Notes list on the first reopen, 2.3 s later. |
| Internal Notes, old: tx 187266 (7 Oct) | The note and its document are shown. |
| New transaction: Upload Funds 189445 (PAYIN WIRE, EUR 1,250.00, account 263) | COMPLETED within 1 s. Its Transaction Trace shows 17 of 17 rows written live by n8n, and its Internal Notes show the note entered in the form. |
| Account Trace, old: account 13272 | 1 of 1 row (ACCOUNT_ADDED, 22 Oct). |
| Account Trace, new: account 13226, time zone Kolkata → Dubai → Kolkata in MNG | Both fresh ACCOUNT_UPDATED rows ("Time Zone is updated from … to …") appeared about 2 s after each save. The account was then verified identical to its snapshot, except for `updated_at`. |
| Dashboards Discover, last hour | All 4 fresh entries (2 account rows, 2 notes) are listed. |
| Internal Notes **report** | Empty. This comes from the product, not from this tool: the report still filters on `is_note: true` and joins on `t_id`. ASTRA-5487 (commit `536a73e164`, 8 Jun 2026) stopped MNG writing those two fields, so the report only finds notes written before that change and n8n conversion-settlement notes, which still set them. The code is the same on Alpha/Omega. |

Notes on reading the screens:
- MNG's Notes list shows only NOTE entries that have note text (`aux.post.note`). An entry with an empty note, such as an operational fee initiated without a note, is not listed. The status-page lookup shows the raw rows before that step, so it can show more.
- MNG's Account Trace only lists accounts of the tenant you are logged into. The trace query itself matches on the account id alone (see PRE-03).

## When something looks wrong

1. Run `npm run doctor`. Each ✗ line says what to do.
2. If a trace screen in MNG shows an error, check `npm run status` for `mng: wired` and a running `astra-opensearch`.
3. If new rows do not appear, check `npm run status` for "Shipper: live" and `npm run logs`. A row usually appears within a second.
4. If the Redis list was flushed or replaced, the shipper notices and reads it again. What is already in OpenSearch stays.
5. To stop using it: `npm run unwire`, then `npm run down`.

## Settings

Copy `.env.example` to `.env` to change ports, the OpenSearch version, memory (`OPENSEARCH_HEAP`, default `768m`; CPU/memory caps `OPENSEARCH_CPUS`, `OPENSEARCH_MEM_LIMIT`, …) or the ASTRA checkout (`ASTRA_REPO`, default `~/payment_system`). Run `npm run up` afterwards.
