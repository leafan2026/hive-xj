# HIVE Dashboard Agent Guide

## Purpose and boundaries

This repository contains the **HIVE service dashboard**: a WDL Worker that reads Jiri AI-conversation quality data from 金数据, aggregates it into KV, and serves the authenticated dashboard at `https://lf.run.jinapp.net/hive/`.

Use WDL Team / `github.com/wdl-dev` when attributing the platform. Do not describe the user-facing product as deployed on Cloudflare.

The dashboard is a data product, not a mockup. Runtime data, API credentials, browser fixtures, login cookies, and deployment tokens are never committed. A successful local preview, a Git push, and a production deployment are separate facts; report them separately.

## Read this before changing code

| Work | Read first |
|---|---|
| Dashboard API, calculations, charts, visual design, filters, or local preview | `.skill/hive-dashboard/SKILL.md` |
| Commit, push, WDL deployment, production verification, or rollback | `.skill/hive-release/SKILL.md` |

The skills live in the repository by design. Keep all future repository-specific skills under `.skill/<skill-name>/SKILL.md`, not under a personal Codex directory.

## Repository map

| Path | Responsibility |
|---|---|
| `workers/hive/src/index.js` | Worker routes, authentication, 金数据 fetch, aggregation, KV cache, generated page shell |
| `workers/hive/public/hive.js` | Dashboard state, API calls, Chart.js plugins and chart configuration |
| `workers/hive/public/hive.css` | Dashboard layout, visual tokens, chart-card and tooltip styling |
| `workers/hive/public/chart.min.js` | Pinned Chart.js asset; do not edit for dashboard styling |
| `workers/hive/wrangler.jsonc` | Worker name `hive`, KV `CACHE`, static assets, 30-minute cron |
| `workers/hive/scripts/preview.mjs` | Local preview server; stubs the KV binding with synthetic data, no credentials |
| `workers/hive/README.md` | Business/data definitions and operational background |
| `workers/hive/.key` | Local raw WDL deployment token; ignored by Git, never read or printed in conversation |

### Second worker at the repository root

`src/index.js`, `public/dashboard.{js,css}` and the root `wrangler.jsonc` are a **separate**
worker (`app`) — the 明道云 HAP「收款反馈跟进」dashboard, last changed 2026-07-14 in `01a80af`.
It shares nothing with `workers/hive` beyond the repository. Do not edit it while working on
HIVE, and do not assume a HIVE change needs mirroring there. Its deployment status is not
recorded here; ask before deploying or deleting it.

## Non-negotiable safety rules

- Preserve unrelated dirty changes. Inspect `git status --short` before edits, commits, pushes, rollbacks, or deployment.
- Do not log, cat, echo, copy into chat, or commit `.key`, `.env`, cookies, 金数据 credentials, or raw production data.
- Do not change data definitions merely to make a chart look cleaner. State the denominator and filtering rule next to any metric change.
- Do not push, deploy, promote a version, refresh production data, or roll back without explicit user authorization for that external action.
- Do not use `wrangler deploy` against WDL. WDL deployment uses the `wdl` CLI, which locally invokes Wrangler only for bundling.
- Do not delete retained WDL versions, workers, KV data, or credentials as part of rollback. Those are separate destructive operations requiring explicit authorization.

## Baseline validation

For a frontend or Worker change, run at least:

```bash
node --check workers/hive/public/hive.js
git diff --check
```

Then verify the requested route/chart in a local preview with representative data. Browser-console errors, clipped labels, distorted rings, and wrong API-path prefixes are failures even when JavaScript syntax passes.

## Delivery language

Always say which stages actually completed:

- **Local preview:** locally rendered and visually inspected only.
- **Committed/pushed:** provide commit SHA and branch.
- **Deployed:** provide the promoted WDL version and live URL.
- **Production verified:** provide the HTTP/status or route evidence.

Never say “deployed” when only the local preview or Git push succeeded.
