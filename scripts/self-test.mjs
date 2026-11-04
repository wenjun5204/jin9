// 临时自测脚本：在 Node 中直接调用各数据源适配器，验证解析逻辑
import * as emQ from "../lib/sources/em-quotes.js";
import * as emN from "../lib/sources/em-news.js";
import * as tx from "../lib/sources/tx-quotes.js";

function ok(label, val) {
  console.log(`✅ ${label}:`, JSON.stringify(val).slice(0, 200));
}
function bad(label, err) {
  console.log(`❌ ${label}:`, err?.message || err);
}

const results = await Promise.allSettled([
  emQ.fetchIndexes().then((r) => ok("指数", r)),
  emQ.fetchQuotes(["1.600519", "0.300750"]).then((r) => ok("自选行情", r)),
  emQ.fetchSectors({ dir: "up", pz: 3 }).then((r) => ok("板块", r)),
  emQ.fetchBreadth().then((r) => ok("涨跌家数", r)),
  emQ.searchStocks("茅台").then((r) => ok("搜索", r)),
  emQ.fetchTrend("1.600519").then((r) => ok("分时", r && { name: r.name, n: r.points.length })),
  emN.fetchNews({ size: 3 }).then((r) => ok("快讯", r.list.map((n) => n.title))),
  tx.fetchTxQuotes(["1.600519"]).then((r) => ok("腾讯兜底", r)),
]);

for (const r of results) {
  if (r.status === "rejected") bad("某调用", r.reason);
}
console.log("自测完成");
