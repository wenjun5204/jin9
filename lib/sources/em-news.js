// 东财 7×24 快讯适配器：增量游标 + 分页 + 重要性
// 参考接口：np-listapi.eastmoney.com/comm/web/getFastNewsList
import { fetchJSON, num } from "../utils.js";

const NEWS_URL =
  "https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102";

/**
 * 拉取一页快讯。
 * @param {object} opts
 *   opts.after  string  增量游标 realSort（返回该时间之后的更新，新到旧）
 *   opts.before string  向前分页游标 sortEnd（返回更早历史，新到旧）
 *   opts.size   number
 */
export async function fetchNews({ after = "", before = "", size = 20 } = {}) {
  let url = `${NEWS_URL}&pageSize=${size}&req_trace=1`;
  // sortEnd 必须始终携带（接口要求，可为空串）；sortAfter 按需携带
  url += `&sortEnd=${encodeURIComponent(before)}`;
  if (after) url += `&sortAfter=${encodeURIComponent(after)}`;
  const json = await fetchJSON(url, { timeout: 12000 });
  const list = json?.data?.fastNewsList || [];
  const mapped = list.map((n) => ({
    id: String(n.code || `${n.realSort}`),
    title: n.title || "",
    summary: n.summary || "",
    // 原文详情页（东财资讯，已实测可访问）
    url: n.code ? `https://finance.eastmoney.com/a/${n.code}.html` : "",
    showTime: n.showTime || "",
    // titleColor 重要性（东财 7x24：多数为 0；color 用于分级）
    color: num(n.titleColor),
    realSort: String(n.realSort || ""),
    sortEnd: String(n.sortEnd || ""),
    stocks: (n.stockList || []).map((s) => {
      // 形如 "105.SMCI" / "0.002667" / "1.601229" / "90.BK1617"
      const p = normSecidStr(s);
      return { secid: p.secid, code: p.code, isBoard: p.isBoard };
    }),
    share: num(n.share),
    comments: num(n.pinglun_Num),
  }));
  return { list: mapped, sortEnd: json?.data?.sortEnd || "" };
}

function normSecidStr(raw) {
  const s = String(raw || "");
  const m = s.match(/^(\d+)\.([A-Za-z0-9]+)$/);
  if (!m) return { secid: s, code: s, isBoard: false };
  const market = m[1];
  const isBoard = market === "90" || market === "80";
  return { secid: s, code: m[2], isBoard };
}

/** 重要性等级：0 普通 / 1 次重要 / 2 重要 */
export function importanceOf(item) {
  return item.color > 0 ? 2 : 0;
}

/** 快讯过滤器预置 */
export const NEWS_FILTERS = [
  { id: "all", label: "全部" },
  { id: "important", label: "重要" }, // color>0
  { id: "a", label: "A股" }, // 含 A 股个股关联（market 0/1/116）
  { id: "board", label: "板块" }, // 含板块关联
];

/** 判断某条快讯是否命中过滤器 */
export function matchFilter(item, filterId) {
  switch (filterId) {
    case "important":
      return importanceOf(item) > 0;
    case "a":
      return item.stocks.some((s) => ["0", "1", "116"].includes(s.secid.split(".")[0]));
    case "board":
      return item.stocks.some((s) => s.isBoard);
    default:
      return true;
  }
}