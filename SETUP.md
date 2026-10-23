# Set up Local OpenSearch (for the QA team)

> Want the short version? See the **[Easy Setup Guide](QUICK-SETUP.md)** (3 steps). This page has every detail.

After this, the OpenSearch screens work on **your** local `.local` domains, using your own local data:

- MNG Transaction Trace
- Notes
- Account Trace
- Internal Notes report
- WL-MNG Transaction Trace

You also get OpenSearch Dashboards, the same Discover screen as `mnops.cdmx.io`.

It takes about 10 minutes, once.

## Before you start

| You need | Check with | If it is missing |
| --- | --- | --- |
| Your local ASTRA stack running | `docker ps` lists `nps_redis`, `nps_admin_web`, `nps_wl-mng_web` | Start your local ASTRA stack first |
| Docker with Compose | `docker compose version` | Install Docker Engine |
| Node 20 or later | `node -v` | Install Node 20 (nvm or apt) |
| Java 17 or 21 | `java -version` | `sudo apt install openjdk-17-jre-headless`. If the download is blocked, see "If Java will not install" below. |
| Access to the repo | You can open https://github.com/shriraj04/local-opensearch | Ask Shriraj to add you |

## Steps

1. **Get it.** Clone it into your `payment_system` folder (next to `qa-astra`). It then finds your ASTRA code by itself, and your editor shows it as its own repository:
   ```bash
   cd ~/payment_system
   git clone git@github.com:shriraj04/local-opensearch.git
   echo "local-opensearch/" >> .git/info/exclude   # so it can never be committed into payment_system
   cd local-opensearch
   ```
2. **Only if you cloned it somewhere else and your `payment_system` checkout is not at `~/payment_system`**, tell the tool where it is:
   ```bash
   echo "ASTRA_REPO=/path/to/your/payment_system" > .env
   ```
3. **Start it.** (Or do steps 3–5 in one go with `npm run setup`.) The first run takes 3–5 minutes because it downloads OpenSearch Dashboards and builds OpenSearch:
   ```bash
   npm run up
   ```
   It ends with a list of ✓ lines and three links.
4. **Point your MNG and WL-MNG at it.** This changes one setting, `OPS_URL`, in `mng/app/config/config.json` and `wl-mng/app/config/config.json`. The original files are saved first:
   ```bash
   npm run wire
   ```
   MNG restarts by itself within a few seconds.
5. **Check it.**
   ```bash
   npm run doctor
   ```
   You should see **"✓ All good: local traces work end to end."** Each ✗ line says what to do.
6. **Use it.**
   - In MNG, open any transaction's Transaction Trace or Internal Notes, or an account's Account Trace.
   - Dashboards: http://127.0.0.1:5601. It opens on Discover. Use **Open** to load the saved searches for each MNG screen.
   - Quick lookup page: http://127.0.0.1:9700

That's it. It starts by itself when your laptop starts, like the ASTRA containers do.

## Everyday commands

| I want to | Run |
| --- | --- |
| See if it is working | `npm run status` |
| Look up a trace in the terminal | `npm run trace -- tx 189445` (also `notes <tx>`, `account <id>`, `internal-notes 2026-10-01 2026-10-23`) |
| Get the latest version | `git pull && npm run up` |
| Stop it | `npm run down` (starts again with `npm run up`) |
| Undo the MNG change | `npm run unwire` (puts the original config files back exactly) |

## If something goes wrong

| You see | Do this |
| --- | --- |
| `No Java 17 or 21 found` | Install Java (table above), or see "If Java will not install". |
| `port 9200 is already used` (or 5601 / 9700) | Add another port to `.env`, e.g. `OPENSEARCH_PORT=9201`, then `npm run up`. |
| `… not found. Put the path of your payment_system checkout in .env` | Step 2. |
| doctor: `mng: not wired` | `npm run wire` |
| An MNG trace screen shows an error | `npm run status`. Every line should be ✓; if not, run `npm run up`. |
| New rows do not show up | `npm run logs` shows the shipper's messages. Rows normally appear within 2 seconds. |
| The Internal Notes **report** is empty | That is expected: it comes from the product, not from this tool (README → "Verified on local Alpha"). |

### If Java will not install

The office web gateway can block Java downloads. Ask Shriraj for the ready-made OpenSearch image file, then load it:

```bash
docker load -i astra-opensearch-image.tar.gz
npm run up
```

`npm run up` sees that the image is already there and skips the build, so Java is not needed.

*(For Shriraj, to make that file: `docker save astra-opensearch:2.19.6-local | gzip > ~/astra-opensearch-image.tar.gz`)*

## Resources

It is capped so it cannot slow your laptop down. In total it is about 1 GB of RAM and under 2% CPU when idle; README → "Resources" has the details.
