---
name: hive-dashboard
description: Modify the HIVE Jiri service dashboard when a request touches dashboard data, charts, visual design, filters, or local preview. Do not use for release-only work.
---

# HIVE Dashboard

## Outcome

Make a source-faithful dashboard change in `workers/hive/`, validate it with the supplied or live data contract, and keep preview, Git, and production-release status distinct.

## Route before editing

| Need | Primary file |
|---|---|
| Fetching, aggregation, metric definitions, auth, cache, API routes | `workers/hive/src/index.js` |
| Chart type, data binding, DOM/SVG chart kit (`domChart()`), tooltip/legend behavior | `workers/hive/public/hive.js` |
| Layout, card dimensions, colors, glass effects, responsive behavior | `workers/hive/DESIGN.md` first, then `workers/hive/public/hive.css` |
| WDL bindings, cron, asset deployment | `workers/hive/wrangler.jsonc` |

Read `workers/hive/DESIGN.md` before any visual change: it records the information architecture (sidebar groups), design tokens, the fixed semantic chart palettes, capsule bars, the bar-label rules, the dark hover card, and the fixed green-up / black-down delta convention. A change that contradicts it must either be reverted or land together with an update to that file.

Read `workers/hive/README.md` for metric/business definitions before changing a denominator, a filter, a weekly/loop calculation, or a meaning-bearing label.

## Data and API invariants

- The Worker uses 金数据 AI 会话质检 form `EQca39`. Runtime credentials are `JSJ_API_KEY` and `JSJ_API_SECRET`; they must remain runtime secrets.
- KV caches are `hive:stats:v12`, `hive:entries:v6`, `hive:weekly:v7`, `hive:loop:v1`, and `hive:meta:v1` through binding `CACHE`. Any change to the shape of `stats` bumps `K_STATS` **and** `K_QUERY_PREFIX`; any new field in `trim()` bumps `K_ENTRIES` (first visit after a bump re-fetches 金数据 in the background).
- `/api/dashboard` respects the top filter bar. `/api/weekly` and `/api/loop` are independent cached reports; do not imply that top filters change them unless the backend contract changes too.
- Filtered `/api/dashboard` responses are memoised under `hive:q:v7:<meta.updatedAt>:<hash>`. The hash covers every key in `FILTER_KEYS` **and the resolved from/to dates**. If you add a filter parameter, add it to `FILTER_KEYS` too — otherwise two different filters share a cache entry and the dashboard serves the wrong numbers.
- `manualBusy` carries `slotMinutes` / `slotCount` / `capacity` plus `weekday[96]` / `weekend[96]` day-averages; `hourlyWeek.manual[7][24]` feeds the 24h heat grid; `agentScene` cells carry `sec` (m:ss) and `v` (minutes); `emotion.emoList` rows carry `q` (one-line summary). The frontend reads all of these — do not reintroduce hardcoded slot counts or capacities.
- Only add a field to `trim()` if something consumes it. Every field is parsed once per row (~6600) on each cache-miss filter request.
- Business-scene charts and the scene × plan table use only `会话性质=有效`. An empty plan is 免费版.
- Do not commit captured XHR payloads. If a user supplies fixtures, use them only for local visual validation unless they explicitly request a sanitized test fixture.

## Page structure and chart system

Keep visual semantics consistent across the dashboard. Reuse the existing helpers instead of introducing an unrelated chart style. Details live in `workers/hive/DESIGN.md`.

### Pages

- Sidebar groups: **分析**（总览 / 接待量与来源 / AI 表现 / 人工服务 / 业务与套餐，follow the filter bar）and **报告**（周报 / 业务闭环，fixed scope, filter bar hidden via `body.is-report`).
- Each analysis panel has a renderer in `PANEL_RENDER`; only the active panel is drawn, and switching tabs redraws it. A new panel must be added there and to `TAB_NAMES`.
- The page header text comes from the nav button (`data-desc`, `data-kind`). The active tab is kept in the URL hash.

### Charts

- **There is no Chart.js any more (2026-10-13).** Every page is built to match the Claude Design prototypes (`Main / Volume / AI / Cost / Business / Weekly / Loop.dc.html`) one-to-one; bar + line charts go through `domChart()` (flex capsule bars + one SVG smoothed line, `BAR_W` / `PAIR_W` widths per grain, `xLabelsFor()` axis labels, `bucketTitle()` hover titles). All bars are capsules; stacked segments have a 2px gap.
- Hover: the column gets a light band via `:hover::before`; the dark card `.chart-glass-tooltip` is painted by `bindDomTip(container, describe)` on elements with `data-tip`. Re-rendering swaps `el.$tip`, it never rebinds.
- Everything else (KPI sparks, unit bars, repeat-rate weekly bars, trio sparklines, ranking bars, heat grids `.hm`, emotion rows `.em`, detail rows `.ed`, repeats `.rt`, loop bars) is DOM too. `public/chart.min.js` is an orphaned asset kept only until it is removed from Git.
- The old ring/gauge helpers (`drawDoughnut`, `drawProgressRing`, `multiRingArcs`, …) were removed in the 2026-10 redesign. Do not reintroduce rings.
- Deltas: up = green, down = black, flat = gray (`changeText()`, `delta()`, `.dl`). The scene × agent median table says 快 / 慢 instead of arrows.

## Local preview and visual review

1. Start from the source files above; do not leave a final change only in `/private/tmp` or another ad-hoc preview harness.
2. Use real/supplied XHR fixtures to exercise the requested tabs and hover states when data shape matters.
3. Check desktop layout, label clipping, tooltips, and browser console errors for every sidebar page; also check ~800px (sidebar narrows to 200px but stays) and ≤640px (top bar with a hamburger that opens a right-side drawer; filter bar collapses to a one-line summary). Compare each page against its `.dc.html` prototype screenshot — the user expects them to be identical.
   `npm run preview` serves ~12k synthetic rows (`scripts/preview-data.mjs`), so weekly, loop and agent tables have content.
4. Run:

   ```bash
   node --check workers/hive/public/hive.js
   git diff --check
   ```

5. Say “local preview” until a separate user-authorized Git/release step happens.

## Boundaries

- Do not change cache keys, 金数据 fields, login/auth behavior, or deployment bindings for a visual-only request.
- Do not change every bar chart when the request is specifically about bar-plus-line combinations.
- Do not deploy during a local-preview request. Use `.skill/hive-release/SKILL.md` only after the user explicitly asks to release.
