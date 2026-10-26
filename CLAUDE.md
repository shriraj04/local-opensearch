# Local OpenSearch for ASTRA: working rules

- For setup, update, wire / unwire, status, stop or repair, use the **local-opensearch** skill: `.claude/skills/local-opensearch/SKILL.md`.
- **Never `git add`, commit or push in the `payment_system` repo** (the product repo). Git work happens only in this repo, and is pushed only when the owner asks.
- The only change outside this folder is `OPS_URL` in `mng/app/config/config.json` and `wl-mng/app/config/config.json` (git-ignored). Change it only through `npm run wire` / `npm run unwire`. Never print those files: they contain secrets.
- Never restart, rebuild or modify the ASTRA containers (`nps_*`), product code, the database or n8n.
- Keep it light: every container has CPU / memory / log caps. Keep them, and measure before changing them.
- Run the tests with `npm test`. They start a throwaway Redis in Docker and remove it afterwards.
