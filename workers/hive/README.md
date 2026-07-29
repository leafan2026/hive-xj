# hive — AI 会话质检看板

线上地址：https://lf.run.jinapp.net/hive/

数据源：金数据表单 `EQca39`（AI 会话质检 4.0），约 6600 条会话。

## 架构

- 金数据 API `per_page` 实际封顶 50 条/页，`next` 参数就是 `serial_number` 偏移，
  因此按偏移**并行**拉取（并发 10），全量约 13 秒；按 `serial_number` 去重
  （该表 `token` 字段多为 null，不能用作去重键）。
- 聚合结果与精简后的明细写入 KV（`hive:stats:v1` / `hive:entries:v1` / `hive:meta:v1`），
  页面只读缓存，接口响应在百毫秒级。
- cron `*/30 * * * *` 后台刷新；`POST /api/refresh` 手动触发（立即返回 202，
  进度写在 meta 里，前端轮询 `/api/status`）。

## 筛选

页面顶部筛选栏对**全部卡片和图表**生效：时间范围（近 7/14/30 天或自定义）、质检状态、
渠道、设备、处理状态、业务场景、会话性质、套餐。筛选走服务端 —— 无筛选时命中预聚合
缓存，有筛选时读 KV 明细现算，都在 200ms 量级。下拉选项只在首次全量结果时填充一次，
否则筛完选项会跟着缩水。

## 指标口径

`Jiri是否能解答` / `转人工方式` / `转人工原因` 只在人工质检过的会话上有值
（约 764 条，占 11.6%），AI 相关指标按这批口径计算，未打标记录不参与，
避免被稀释。会话性质、渠道、场景等字段全量有值，按全部会话计算。

## 接口

| 路径 | 说明 |
|---|---|
| `GET /` | 看板页面 |
| `GET /api/dashboard` | 聚合指标。无参数时返回预聚合缓存；带筛选参数（`from` / `to` / `channel` / `device` / `status` / `scene` / `nature` / `plan` / `qc`）时读明细现算，约 200ms |
| `GET /api/entries` | 明细，支持 `page` / `per_page` / `channel` / `scene` / `nature` / `jiri` / `search`（接口保留，页面已不展示明细） |
| `POST /api/refresh` | 触发后台全量刷新 |
| `GET /api/status` | 刷新状态与数据更新时间 |

## Secrets

| 名称 | 用途 |
|---|---|
| `JSJ_API_KEY` / `JSJ_API_SECRET` | 金数据 API 凭证 |
| `AUTH_USERS` | Basic Auth，格式 `user1:pass1,user2:pass2`，未配置则不校验 |

## 部署

```bash
cd workers/hive
wdl deploy .            # 需要 CONTROL_URL / ADMIN_TOKEN / WDL_NS
```
