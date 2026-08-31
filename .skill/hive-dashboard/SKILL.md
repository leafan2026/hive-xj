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
| Chart type, data binding, Chart.js plugin, tooltip/legend behavior | `workers/hive/public/hive.js` |
| Layout, card dimensions, colors, glass effects, responsive behavior | `workers/hive/public/hive.css` |
| WDL bindings, cron, asset deployment | `workers/hive/wrangler.jsonc` |

Read `workers/hive/README.md` for metric/business definitions before changing a denominator, a filter, a weekly/loop calculation, or a meaning-bearing label.

## Data and API invariants

- The Worker uses 金数据 AI 会话质检 form `EQca39`. Runtime credentials are `JSJ_API_KEY` and `JSJ_API_SECRET`; they must remain runtime secrets.
- KV caches are `hive:stats:v2`, `hive:entries:v2`, `hive:weekly:v1`, `hive:loop:v1`, and `hive:meta:v1` through binding `CACHE`.
- `/api/dashboard` respects the top filter bar. `/api/weekly` and `/api/loop` are independent cached reports; do not imply that top filters change them unless the backend contract changes too.
- Business-scene charts and the scene × plan table use only `会话性质=有效`. An empty plan is 免费版.
- Do not commit captured XHR payloads. If a user supplies fixtures, use them only for local visual validation unless they explicitly request a sanitized test fixture.

## Chart system

Keep visual semantics consistent across the dashboard. Reuse the existing helpers instead of introducing an unrelated chart style.

### Multi-category ring charts

- `drawDoughnut` plus `multiRingArcs` renders the 270-degree concentric progress rings.
- Keep a single global ring spec: `16px` text, `16px` ring width, and `10px` gap. Text, colored dot, and each ring must share the exact corresponding start height.
- Preserve a square canvas for multi-ring charts. Do not solve layout pressure by stretching the canvas into an ellipse or changing only one card’s ring/label size.
- Long category lists belong in wide cards or a horizontal bar chart. Do not force many rings into a narrow four-column card and silently clip labels.

### Single-metric service cards

- The three service-overview cards use `drawProgressRing`, not multi-category rings:
  - 人工接待会话 Jiri 能否解答 → **不能占比**
  - 转人工方式 → **沟通后转占比**
  - 最后接待对象 → **仅 Jiri 占比**
- They are 180-degree semicircular gauges and use a compact card height. Do not reintroduce other categories merely as decorative rings.

### Bars and line-plus-bar charts

- `业务场景分布（有效会话）` is a horizontal bar chart, not a ring chart.
- Apply the muted-bar / saturated-line treatment **only** to charts that combine bars and lines. Ordinary bar charts retain their established business colors.
- Combination-chart bars use the three-theme sequence `#8676FF`, `#FF708B`, `#383874`; lines are dashed and more saturated.
- In combination-chart legends and hover indicators, bars use square markers and lines use circular markers.
- Combination-chart hover content is the DOM `.chart-glass-tooltip`, with actual `backdrop-filter` blur. Do not replace it with an opaque Chart.js canvas tooltip.

## Local preview and visual review

1. Start from the source files above; do not leave a final change only in `/private/tmp` or another ad-hoc preview harness.
2. Use real/supplied XHR fixtures to exercise the requested tabs and hover states when data shape matters.
3. Check desktop layout, label clipping, circle geometry, tooltips, and browser console errors. For responsive work, also check the relevant narrower breakpoint.
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
