# Local OpenSearch: Easy Setup Guide

> See **traces and internal notes on your local ASTRA**, just like on Alpha and Omega.
> No server needed. Setup takes about 10 minutes, once.

---

## What you get

- **Transaction Trace**, **Internal Notes** and **Account Trace** in your local MNG show real data from your own local testing.
- **OpenSearch Dashboards** on your laptop: the same screen as `mnops.cdmx.io`, but for your local data.
- **Live updates:** do something in your local ASTRA, and it shows up in the trace about 2 seconds later.

---

## Before you start

Tick these off. If one is missing, the setup will tell you what to do anyway.

| | What you need | How to check |
|:-:|---|---|
| ☐ | Your local ASTRA is running | https://qa-alpha-astramng.local opens |
| ☐ | Docker | `docker ps` works |
| ☐ | Node 20 or newer | `node -v` shows **v20** or higher |
| ☐ | Java 17 | `java -version` shows **17**. If not: `sudo apt install openjdk-17-jre-headless` |
| ☐ | Access to the GitHub repo | https://github.com/shriraj04/local-opensearch opens. If not, ask Shriraj. |

---

## Setup in 3 steps

### Step 1. Download it into your `payment_system` folder

```bash
cd ~/payment_system
git clone git@github.com:shriraj04/local-opensearch.git
echo "local-opensearch/" >> .git/info/exclude
```

> **Why inside `payment_system`?** It finds your ASTRA code by itself, and your code editor shows it as its own repository, next to `qa-astra`.
> The last line makes sure it can **never** be committed into the `payment_system` repo by mistake.

### Step 2. Run the setup

```bash
cd ~/payment_system/local-opensearch
npm run setup
```

The setup does everything for you:

1. **Checks your laptop.** You get a ✓ / ✗ list. Each ✗ says exactly how to fix it.
2. **Starts everything.** The first time takes 3–5 minutes.
3. **Asks one question:** `Connect them now? [Y/n]`. Press **Enter** (that means Yes).
4. **Tests everything** from start to end.

✅ **You are done when you see `You're all set!`**

### Step 3. Try it

1. Open your local MNG at https://qa-alpha-astramng.local and go to **Transactions → Outgoing (Payout)**.
2. On any row, click the **Transaction Trace** icon. The trace appears.
3. On the same row, click **Add Internal Note**, write a short note and **Save**. Open it again: your note is there.
4. Open **OpenSearch Dashboards** at http://127.0.0.1:5601

---

## Good to know

| | |
|---|---|
| 🔁 **Starts by itself** | Restarts, weeks switched off, Redis restarts: it picks up where it stopped. A small check at login and every 10 minutes repairs anything Docker cannot. |
| 🪶 **Light** | About 1 GB of memory and almost no CPU when idle. |
| ⬆️ **Update** | `git pull && npm run setup` |
| 🩺 **Check it** | `npm run doctor`. It should end with **All good**. |
| ↩️ **Undo the MNG change** | `npm run unwire` |
| ⏹️ **Stop it** | `npm run down`. To start it again: `npm run setup`. |
| 📝 **Internal Notes report** | The report (under **Reports**) stays empty. That is a known product issue, not your setup. |

---

## Something not working?

| You see | Do this |
|---|---|
| A red **✗** during setup | Do what that line says, then run `npm run setup` again. |
| `No Java 17 or 21 found` and the Java install is blocked | Ask Shriraj for the file `astra-opensearch-image.tar.gz`, then run `docker load -i astra-opensearch-image.tar.gz` and `npm run setup` again. |
| `Port … is already used` | Run the command shown on that line (it picks another port), then `npm run setup` again. |
| The trace screen in MNG shows an error | Run `npm run doctor` and follow any ✗ line. |
| Still stuck | Send Shriraj the output of `npm run doctor`. |

---

<sub>More detail: [SETUP.md](SETUP.md) (full guide) · [README.md](README.md) (how it works)</sub>
