# 财经日历 Tab（对标 jin10 补齐看家功能）

## Context

对标金十数据找差距，用户选定补「财经日历」。规划期已实测锁定数据源（均无鉴权/无 Referer 限制，裸 curl 可用）：

1. **国外经济数据**（jin10 式「前值/公布值/公布时间」）：
   `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_ECONOMICVALUE_{MKT}&columns=ALL&sortColumns=PUBLISH_DATE&sortTypes=1&source=WEB&filter=(PUBLISH_DATE>='{date}')(PUBLISH_DATE<'{date+1}')`
   市场后缀：`USANEW`(美)/`EURONEW`(欧元区)/`GER`(德)/`JPAN`(日)/`BRITAIN`(英)/`CA`(加)/`AUSTRALIA`(澳)。字段：`PUBLISH_DATE`、`INDICATOR_NAME`、`COUNTRY`、`PRE_VALUE`(前值)、`VALUE`(公布值，null=未公布)。
   注意：`CH`(中国)报表 PUBLISH_DATE 覆盖差（实测一周窗口仅 1 条且串数据），中国数据改走日历接口。
2. **事件 + 中国数据发布时间表**：
   `...reportName=RPT_CPH_FECALENDAR&columns=ALL&sortColumns=START_DATE&sortTypes=1&filter=(START_DATE>='{date}')(START_DATE<'{date+1}')`
   字段：`START_DATE`、`FE_NAME`、`CITY`(国家)、`FE_TYPE`(经济数据/事件/会议)、`CONTENT`(摘要，事件类才有)、`STD_TYPE_CODE`('2'=经济数据，其余为事件类)。
3. jin10 自家接口不可用（`datacenter-api.jin10.com` 502、`cdn-rili.jin10.com` NXDOMAIN），放弃。
4. **预期值**：东财两表均无该字段，v1 不做（如实告知用户）。

架构决策：日历数据**按需拉取**（popup 打开日历 Tab 时直接 fetch，走 host permission），不进 SW 15s 轮询链路——日历是低频数据，不值得常驻轮询。

## 改动

### 1. [manifest.json](manifest.json)
`host_permissions` 增加 `"https://datacenter-web.eastmoney.com/*"`。

### 2. lib/sources/em-calendar.js（新建）
复用 [lib/utils.js](lib/utils.js) 的 `fetchJSON`。
- `fetchEconomicValues(dateStr)`：7 市场 `Promise.allSettled` 并行，map 行 → `{ time: 'HH:mm'（PUBLISH_DATE 截取，00:00 显示为 '--:--'）, country, name, pre, value, published: value != null }`；
- `fetchCalendarEvents(dateStr)`：单请求，map 行 → `{ time, name, city, type: FE_TYPE, content: CONTENT || '' }`；
- `fetchCalendarDay(dateStr)`：合并两者，返回 `{ econ, events }`。

### 3. [app.html](app.html)
- 顶栏第 4 个 Tab：`<button class="tab" data-tab="calendar">日历</button>`（行情 / 板块 / 快讯 / 日历）；
- 新 `<main id="panel-calendar" class="panel hidden">`：日期 seg（昨日 / 今日 / 明日，`data-caldate`）+ 类型 seg（全部 / 数据 / 事件，`data-calfilter`）+ `#calendar-list`。

### 4. [app.js](app.js)
- 状态：`calDate = "today"`、`calFilter = "all"`、`calCache = new Map()`（key 为日期字符串，避免切日期反复拉）；
- Tab 切换已是通用逻辑（`panel-{activeTab}`），无需改；在 Tab 切换处理里对 `calendar` 增加触发 `loadCalendar()`（无缓存或数据过期 >10 分钟时 fetch，先渲染 loading 占位）；
- `loadCalendar()`：把 `today/tomorrow/yesterday` 折算为 `yyyy-MM-dd`，调 `fetchCalendarDay`，写入缓存后 `renderCalendar()`；
- `renderCalendar()`（守卫 `activeTab === "calendar"`）：
  - 数据行：时间 + 国家标签 + 指标名 + `前值 → 公布值`；已公布用 `var(--accent)` 高亮公布值，未公布灰色显示「待公布」；前值大数（≥1e4）用现有 `fmtAmount` 缩写；
  - 事件行：复用快讯 `news-item` 的展开模式（点击 toggle 展开 `CONTENT` 摘要）；
  - `render()` 分派队列追加 `renderCalendar()`；
- 日期/类型 seg 绑定参照板块 Tab 的作用域写法（`#panel-calendar .seg-btn`，注意与日期 seg、类型 seg 用 `data-caldate` / `data-calfilter` 区分，避免互相污染 active）。

### 5. [styles.css](styles.css)
新增 `.cal-row` / `.cal-time` / `.cal-country`（小圆角标签，复用 `.stock-tag` 范式）/ `.cal-value` 样式；行高与 hover 沿用 `.sector-row` 范式。面板滚动布局（`.panel` flex）自动生效，无需结构改动。

## 不改动的部分

- SW 轮询链路、`updateSnapshot` 串行队列、快讯/行情/板块全部逻辑不动；
- 不新增 permissions（无 notifications 等需求）。

## 验证

1. `node --check app.js lib/sources/em-calendar.js`；
2. 数据源回归（已验证命令，实施后再跑一遍确认字段映射）：
   `curl -s "https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_ECONOMICVALUE_USANEW&columns=ALL&pageSize=5&sortColumns=PUBLISH_DATE&sortTypes=1&source=WEB&filter=(PUBLISH_DATE>='今日日期')..."`
3. chrome://extensions 重载扩展，打开 popup：
   - 日历 Tab 出现，今日列表含国外经济数据（前值/公布值，未公布标「待公布」）与事件（点击展开摘要）；
   - 昨日/明日切换重新拉取并正确渲染（明日全是待公布）；
   - 全部/数据/事件过滤生效；
   - 其余三个 Tab 行为不变；无网络时日历 Tab 显示错误占位，不影响其他 Tab。
