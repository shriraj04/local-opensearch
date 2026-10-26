---
name: local-opensearch
description: Set up, update, check, connect (wire) or disconnect (unwire) Local OpenSearch for ASTRA on the local .local domains, so MNG Transaction Trace, Internal Notes, Account Trace and the WL-MNG trace work locally with real local data (repo github.com/shriraj04/local-opensearch). Use when someone asks to set up / install / update / repair / check local OpenSearch, local traces or internal notes, to connect or revert MNG's OPS_URL (wire / unwire), to stop or remove it, or when MNG trace / notes screens fail on local.
---

# Local OpenSearch for ASTRA

Local OpenSearch copies every log line the local ASTRA apps write to Redis `nps-logs` into a local OpenSearch, the way remote `nps-app-*` (mnops.cdmx.io) is filled. MNG and WL-MNG then read their trace and notes screens from it.

- **Containers:** `astra-opensearch`, `astra-opensearch-dashboards`, `astra-log-shipper`. They are capped at about 1 GB of RAM in total and use almost no CPU when idle.
- **Commands:** everything is driven by `npm run <command>` inside the repo folder.

**Repo folder:** `~/payment_system/local-opensearch` (a separate git repo inside the payment_system folder, like `qa-astra`). Below it is called `$LOS`.

## Rules (always)

1. **Never `git add`, commit or push in the `payment_system` repo.** It is the product repo. All git work happens in `$LOS` only. Before any commit there, check that `git -C $LOS rev-parse --show-toplevel` is `$LOS` and that the remote is `shriraj04/local-opensearch`. Teammates normally never commit anything.
2. **The only product-side change** is `OPS_URL` in `mng/app/config/config.json` and `wl-mng/app/config/config.json`. Both files are git-ignored. Make that change **only** with `npm run wire`: it saves the originals, and `npm run unwire` puts them back byte-for-byte. Never hand-edit those files.
   - If the user's own instructions (a CLAUDE.md, a working agreement) say app configs must not be changed without their say-so, ask before wiring: run setup **without** `--yes`, then `npm run wire` once they agree. Asking for setup "and connect my MNG" counts as that say-so.
3. **Never print or `cat` those config files.** They contain secrets. `npm run status` shows whether they are connected.
4. **Never restart, rebuild or modify the ASTRA containers** (`nps_*`). Never touch product code, the database or n8n. MNG restarts by itself when the config changes.
5. **Never delete Docker volumes or images** unless the user explicitly asks; volume `astra-opensearch-data` holds the trace history.
6. **Don't try to get around the office web gateway** (Cloudflare WARP). It blocks Java downloads; the setup already avoids them.
7. **Long-running commands:** the first `npm run setup` takes 3–10 minutes. Run it with the longest timeout available, or in the background. If it is cut off, run it again; it continues where it stopped.

## Set it up (one go)

Do all steps without stopping, unless a step says to ask. Then report as in "Report back".

1. **Check the laptop.** Run `docker ps --format '{{.Names}}' | grep -E '^nps_(redis|admin_web|wl-mng_web)$'` and `node -v`.
   - **The grep does not print all three names:** stop and tell the user to start their local ASTRA stack first.
   - **Node older than 20:** stop and tell them to install Node 20 or newer.
   - **Java:** don't check it here. It is only needed the first time, to build the OpenSearch image, and setup checks it for you (step 4).
2. **Get the repo.** If `$LOS` does not exist yet:
   ```bash
   cd ~/payment_system && git clone git@github.com:shriraj04/local-opensearch.git
   ```
   If it fails with "Permission denied" or "Repository not found", stop: they need access from Shriraj (and a GitHub SSH key). If `$LOS` already exists, run `git -C ~/payment_system/local-opensearch pull --ff-only`. If that pull is refused (local edits, or a local commit), don't force, stash or reset anything. Continue with the version they have, and tell them in the report.
3. **Keep it out of the payment_system repo** (safe to repeat):
   ```bash
   X=~/payment_system/.git/info/exclude; grep -qx 'local-opensearch/' "$X" || { [ -s "$X" ] && [ -n "$(tail -c1 "$X")" ] && echo >> "$X"; echo 'local-opensearch/' >> "$X"; }
   ```
   If their checkout is not at `~/payment_system`, use their path everywhere. When `$LOS` sits inside the checkout, the tool finds it by itself.
4. **Install and start everything, connect MNG, and test it:**
   ```bash
   cd ~/payment_system/local-opensearch && npm run setup -- --yes
   ```
   `--yes` connects MNG and WL-MNG (step 3 of the setup). The user's request to set it up is the consent; only if they said not to touch MNG, run `npm run setup` without `--yes`.
   - Setup prints a ✓/✗ checklist first. For each ✗, do what its line says, then run the command again.
     - A busy port: `echo "OPENSEARCH_PORT=9201" >> .env`.
     - **"Java 17 or 21 is installed" ✗:** installing Java needs their password, so ask them to run `! sudo apt install -y openjdk-17-jre-headless` in this chat. If that download is blocked, they can get the ready-made image file from Shriraj and run `docker load -i astra-opensearch-image.tar.gz`; after that, Java is not needed.
   - Setup also turns on the **background check**: a systemd *user* timer, `local-opensearch-guard`, that runs at login and every 10 minutes and repairs a removed container or a lost network. It uses no sudo, and its log is `journalctl --user -u local-opensearch-guard`.
5. **Confirm** with `npm run doctor`. It must end with `✓ All good: local traces work end to end.` If a ✗ remains, follow "Fix problems".
6. **Make this skill available in every future session:**
   ```bash
   L=~/.claude/skills/local-opensearch; mkdir -p ~/.claude/skills; if [ -e "$L" ] && [ ! -L "$L" ]; then echo "$L already exists as a folder: left as is"; else ln -sfn ~/payment_system/local-opensearch/.claude/skills/local-opensearch "$L"; fi
   ```

### Report back (plain English, short)

- It is set up and tested ("All good").
- What changed in payment_system: only `OPS_URL` in the two git-ignored config files. Nothing to commit, and nothing was committed. If setup said "Already connected", say that it was already connected from before.
- Anything that was already in place (repo, containers, wiring), so they know this run only re-checked it.
- Links:
  - MNG: open a transaction's **Transaction Trace** or **Add Internal Note** icon.
  - Dashboards: http://127.0.0.1:5601
  - Lookup page: http://127.0.0.1:9700
- How to undo after testing: "unwire opensearch" (or `npm run unwire`).
- It starts by itself after every restart. The background check (`local-opensearch-guard`) repairs it at login and every 10 minutes.

## Other requests

Run these from `~/payment_system/local-opensearch`.

| The user asks to… | Run | Tell them |
| --- | --- | --- |
| check it / "is it working?" | `npm run status`, and if anything is not ✓, `npm run doctor` | the ✓/✗ lines in plain words |
| connect MNG (wire) | `npm run wire` | MNG restarts by itself in a few seconds |
| revert after testing (unwire) | `npm run unwire` | the original config is back exactly; OpenSearch keeps running unless they also stop it |
| stop it | `npm run down` | it stays stopped, also after restarts, until "start it" |
| start it again | `npm run up` | — |
| update to the latest version | `git pull --ff-only && npm run setup -- --yes` (pull refused → see step 2) | — |
| look up a trace | `npm run trace -- tx <id>` (also `notes <id>`, `account <id>`, `internal-notes <from> <to>`, `wl-trace <id>`) | the rows; the lookup page is http://127.0.0.1:9700 |
| see the shipper's log | `npm run logs` (or `npm run logs -- opensearch`) | — |
| keep more / less history (default: 3 months) | `echo "RETENTION_MONTHS=6" >> .env && npm run up` (`0` = keep everything) | each month of traces is a few hundred MB at most |
| turn the background check off / on | `npm run autostart:off` / `npm run autostart` | — |
| remove it completely | `npm run unwire`, `npm run autostart:off`, `npm run down`. Then **ask first** before `docker compose down -v` (deletes all trace history) and before deleting the folder | — |

## Fix problems

| Symptom | Do |
| --- | --- |
| Setup ✗ "Your local ASTRA stack is running" | They start their ASTRA stack; then rerun setup. |
| Setup ✗ "payment_system folder is found" | `echo "ASTRA_REPO=/their/path/payment_system" > .env`, rerun. |
| ✗ Port … is free | Do what that line says (a new port in `.env`), rerun. |
| `No Java 17 or 21 found` | Step 1 (Java). |
| Image download keeps failing ("unexpected EOF", stops at the same point) | The office gateway is cutting it. Retry once. If it still fails, ask Shriraj for the ready-made image (`docker load -i …`). Do not try to get around the gateway. |
| MNG trace / notes screen shows an error | `npm run status`: containers ✓ and `mng: wired`? If not wired → `npm run wire`; if containers ✗ → `npm run up`. |
| New log rows don't appear in MNG | `npm run status` should say "Shipper: live". Otherwise `npm run logs`. Rows normally appear within about 2 s. |
| "Logs appear although nobody logged in" | Normal: n8n's crons log all day (about 1,000 lines every 10 minutes from the processor-status cron), and MNG logs every page request, even the login page, with `uid 0`. |
| The Internal Notes **report** is empty | Expected, product issue: the report filters on `is_note` / `t_id`, which MNG stopped writing in ASTRA-5487. The tool is not at fault. |
| doctor: "documents are no longer in the Redis list" | Fine: kept history after Redis was flushed or trimmed. |

## How it works (only if asked)

- **The shipper:** it tails `nps-logs` read-only, in one atomic `EVAL_RO` step per poll. The list grows at both ends (portals add at the end, n8n at the front). Each entry goes, unchanged plus `@timestamp`, into monthly `nps-app-YYYY.MM` indices, with the same field types as remote (strings are `keyword`).
- **OpenSearch** is built locally from the official no-Java OpenSearch 2.19.6 plus the laptop's own Java, because the office gateway blocks the Java runtime inside the official image.
- **Details:** README.md, SETUP.md and QUICK-SETUP.md in `$LOS`.
