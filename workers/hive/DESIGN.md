# hive 服务看板 · 前端样式规范

本文是 `public/hive.css` 和 `public/hive.js` 里已有实现的提炼，**描述现状而非愿望**。
改样式前读这里；改完若与本文冲突，要么改回来，要么连本文一起改。

## 基调

浅紫灰底 + 纯白卡片的「轻卡片」风格。靠极淡阴影和 1px 近乎透明的描边分层，
**不用重边框**；圆角偏大（16–20px）。整体偏柔和现代，不是传统 BI 的密集网格风。

字体栈 `-apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", "Microsoft YaHei"`，
正文 14px，开 `-webkit-font-smoothing: antialiased`。

## 颜色 token

全部在 `:root`，换主题只动这里，**不要在组件里写死色值**。

| 用途 | 变量 | 值 |
| --- | --- | --- |
| 页面底色 | `--bg` | `#f5f6fb` |
| 卡片 | `--card` | `#ffffff` |
| 主文字 | `--ink` | `#20264a` |
| 次文字 | `--ink-soft` | `#555d80` |
| 弱化文字 | `--muted` | `#9198b2` |
| 分隔线 | `--line` | `#e9ebf4` |
| 主色 | `--primary` | `#635bea` |
| 主色浅底 | `--primary-soft` | `#efefff` |

辅助色：`--blue #6e99ee`、`--violet #806dfa`、`--amber #f8b84e`、
`--green #58c59a`、`--rose #ee8d87`、`--cyan #63cfc9`。

阴影两档：`--shadow: 0 6px 18px rgba(47,54,102,.055)`、
`--shadow-hover: 0 10px 26px rgba(47,54,102,.10)`。圆角基准 `--radius: 16px`。

## 字号层级

指标卡是全站视觉重心：

- `.card-label` 12px / 500 / `--muted`
- `.card-value` **23px / 字重 720 / 字距 -0.65px**，并开 `font-variant-numeric: tabular-nums`
  （等宽数字，数值刷新时不会左右抖动，这是刻意的，别去掉）
- `.card-sub` 10.5px / `--muted`

`.chart-card h3` 15px / 700 / 字距 -0.12px，左侧有 4px 宽圆角竖条做锚点。
竖条颜色**按栅格位置轮换**：默认 `--primary`，`:nth-child(3n+2)` 用 `--cyan`，
`:nth-child(3n)` 用 `--rose`。纯装饰节奏，不承载语义，不要拿它编码数据含义。

表格 13px；`th` 12.5px / 600 / `--muted`、底色 `#f9f8ff`、sticky 吸顶。

## 栅格与卡片

`.main` 内容区 `max-width: 1400px` 居中，padding `20px 28px 10px`。

`.grid` 是 flex wrap、`gap: 18px`；`.chart-card` 为 `flex: 1 1 340px`，
窄屏自动掉成单列。三个尺寸修饰符：

| 类 | min-height | canvas 上限 |
| --- | --- | --- |
| （默认） | 320px | 300px |
| `.wide` | 320px（占满整行） | 300px |
| `.tall` | 460px | 400px |

卡片 hover 统一 `translateY(-2px)` + `--shadow-hover`，过渡 `.15s ease`。

**环图是例外**：`.multi-ring-chart` 锁 1:1、`.progress-ring-chart` 锁 2:1
（`#panel-service` 内压到 3.6:1），且必须绕开 canvas 的 300px 高度上限
（`max-height: none`），否则同心环几何会被压扁。

## 图表配色

分两层，定义在 `public/hive.js` 顶部。

**第一层：语义固定色。** 同一个值在任何图里永远同一个颜色，这是硬规则。

- 设备 `COLOR_DEVICE`：pc `#5e8ef2`、mobile `#00c8a9`、未知 `#d3d8e6`
- 渠道 `COLOR_CHANNEL`：gd_next `#ffb65c`、gd4 `#d2aa79`、gd_app `#b594ff`、
  wechat_miniapp `#00c8a9`、wechat_official `#ff6689`、trade_weixin_app `#5e8ef2`、未知 `#bcc2d1`
- 会话性质 `COLOR_NATURE`：有效 `#806dfa`、填表人 `#00c8a9`、无效 `#77ddd3`、
  转接未应答 `#ff8dac`、电话引导·发链接图片 `#5e8ef2`、内部测试 `#f3d07a`、未标记 `#d3d8e6`

「未知 / 未标记」一律用灰（`#d3d8e6`、`#bcc2d1`），**不占用彩色**——
缺数据不该在图里抢注意力。

**第二层：兜底色序。** 没进映射表的维度走 15 色 `PALETTE`，按索引取模
（`colorFor(map, key, i)`）。新增维度优先进映射表，不要依赖取模顺序，
否则数据一变颜色就跟着漂。

hover 用 `darken(hex, .82)` 压暗同一支色，**不换成另一种颜色**。

## 坐标轴与网格

`cleanScales()` 统一产出，刻意做得很轻：

- X 轴：无网格线、无轴线
- Y 轴：仅 `#f2f4fa` 淡横线，无轴线，`maxTicksLimit: 6`，`padding: 10`

Chart.js v4 起轴线归 `border` 管，`grid.drawBorder` 已被移除，别再往 `grid` 里塞。

## 柱上数字（valueLabels 插件）

两档限流，**不是一个阈值**：

- 柱顶合计数：≤150 根柱时绘制
- 柱内分段值：≤40 根柱时绘制（挤在柱子里，柱多了必须让位）

超出部分交给碰撞检测按优先级丢弃：合计数 `p:0` > 折线值 `p:1` > 柱内分段 `p:2`。
合计数带白色描边（halo），压在柱子上也读得清。

并列柱（`grouped: true`）模式下值画在**柱顶**而非柱内——柱子矮时画在里面看不见。

## 语义色

**环比/同比固定红增绿减，不按指标好坏翻转。** 这条踩过坑后定死，别再改成
「指标变好就绿」——同一个色块在不同卡片含义相反，读表的人会误判。

| 类 | 含义 | 底色 / 字色 |
| --- | --- | --- |
| `.dl.up` | 上升 | `#fdecee` / `#d9484d` |
| `.dl.down` | 下降 | `#e7f8ef` / `#199c58` |
| `.dl.flat` | 持平 | `#f1f2f9` / `#6a7089` |

状态标签 `.pill` 则按好坏：`.good` `#e7f8ef`/`#199c58`、
`.warn` `#fef3e2`/`#cf8016`、`.bad` `#fdecee`/`#d9484d`。

错误提示条 `.banner`：`#fdeeee` 底 / `#c8393a` 字。

## 控件

- `.btn` 主按钮：primary 实底、圆角 9px、13px/600，投影 `0 5px 12px rgba(99,91,234,.25)`，
  hover 上浮 1px；`:disabled` 时 `opacity: .55` 并取消位移和投影
- `.tab`：常态白底 + `--muted` 字 + 极淡阴影；`.active` 换 primary 实底白字
- 筛选器 `select` / `input[type=date]`：`#fafbfe` 底、1px `--line` 描边、圆角 10px；
  focus 时边框转主色、底色转纯白；`.active` 态用 `--primary-soft` 底 + 主色字 + 500 字重，
  让「这个筛选器生效中」一眼可见
- `.chart-grain`（图表卡内的粒度下拉）：同一套的小号版本，padding `4px 9px`、12.5px

## 图表的数据表达规则

这几条不是样式偏好，是会导致读错数的硬约束。

**去重计数不能跨周期相加。** 接待人数（user_id 去重）、接待企业数
（billing_account_id 去重）这类指标，每个粒度必须由服务端各自去重一次；
「总计」显示全区间去重数（`uniqAll`），不是各周期求和。

**不构成整体的指标不堆叠。** 人数与企业数用并列柱——一个企业下可能有多个用户，
堆叠会读成没有意义的「人数 + 企业数」。

**环图中占比不足 1% 的分类合并为「其他」**，否则会被圆头压成一条看不见的线。

**不要为了图好看改数据定义。** 改分母或过滤规则时，必须在变更说明里写清口径。
