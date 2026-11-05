// 东财财经日历适配器：国外经济数据（前值/公布值）+ 事件/数据发布时间表
// 数据源（均无需鉴权，已实测）：
//  - RPT_ECONOMICVALUE_{MKT}：各国宏观指标，含 PUBLISH_DATE 公布时间 / PRE_VALUE 前值 / VALUE 公布值
//  - RPT_CPH_FECALENDAR：财经事件 + 数据发布预告（含中国数据，仅有时间无前值/公布值）
import { fetchJSON } from "../utils.js";

const DC = "https://datacenter-web.eastmoney.com/api/data/v1/get";

// 经济数据报表的市场后缀（CH 的 PUBLISH_DATE 覆盖差，中国数据走 FECALENDAR）
const ECON_MARKETS = ["USANEW", "EURONEW", "GER", "JPAN", "BRITAIN", "CA", "AUSTRALIA"];

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function nextDateStr(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return fmtDate(new Date(y, m - 1, d + 1));
}

/** 'HH:mm'；无具体时刻（00:00）显示 '--:--' */
function timeOf(dateStr) {
  const t = String(dateStr || "").slice(11, 16);
  return t === "00:00" || !t ? "--:--" : t;
}

function byTime(a, b) {
  const na = a.time === "--:--" ? 1 : 0;
  const nb = b.time === "--:--" ? 1 : 0;
  if (na !== nb) return na - nb; // 无时刻的排最后
  return a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
}

/**
 * 国外经济数据（多市场并行，单个市场失败不阻塞）。
 * 返回 [{ time, country, name, pre, value, published }]
 */
export async function fetchEconomicValues(dateStr) {
  const filter = encodeURIComponent(
    `(PUBLISH_DATE>='${dateStr}')(PUBLISH_DATE<'${nextDateStr(dateStr)}')`
  );
  const tasks = ECON_MARKETS.map((mkt) =>
    fetchJSON(
      `${DC}?reportName=RPT_ECONOMICVALUE_${mkt}&columns=ALL&pageSize=100&sortColumns=PUBLISH_DATE&sortTypes=1&source=WEB&filter=${filter}`,
      { timeout: 10000 }
    )
  );
  const results = await Promise.allSettled(tasks);
  const rows = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const d of r.value?.result?.data || []) {
      const value = d.VALUE;
      rows.push({
        kind: "econ",
        time: timeOf(d.PUBLISH_DATE),
        country: d.COUNTRY || "",
        name: d.INDICATOR_NAME || "",
        pre: d.PRE_VALUE,
        value,
        published: value != null && value !== "",
      });
    }
  }
  return rows.sort(byTime);
}

/**
 * 财经事件 + 数据发布预告（含中国）。
 * 返回 [{ kind: 'event'|'data', time, country, name, content }]
 */
export async function fetchCalendarEvents(dateStr) {
  const filter = encodeURIComponent(
    `(START_DATE>='${dateStr}')(START_DATE<'${nextDateStr(dateStr)}')`
  );
  const json = await fetchJSON(
    `${DC}?reportName=RPT_CPH_FECALENDAR&columns=ALL&pageSize=200&sortColumns=START_DATE&sortTypes=1&filter=${filter}`,
    { timeout: 10000 }
  );
  const rows = (json?.result?.data || []).map((d) => ({
    kind: d.STD_TYPE_CODE === "2" ? "data" : "event",
    time: timeOf(d.START_DATE),
    country: d.CITY || "",
    // 去掉冗长的「(报告期:2026年10月)」后缀，避免窄列折行碎裂
    name: String(d.FE_NAME || "").replace(/[(（]报告期[:：][^)）]*[)）]/g, "").trim(),
    content: d.CONTENT || "",
  }));
  return rows.sort(byTime);
}

/**
 * 当日新股申购名单（东财新股中心 RPTA_APP_IPOAPPLY）。
 * 返回 [{ name, applyCode, price, pe, industryPe, market, topCap(万元) }]
 */
export async function fetchIpoDay(dateStr) {
  const filter = encodeURIComponent(
    `(APPLY_DATE>='${dateStr}')(APPLY_DATE<'${nextDateStr(dateStr)}')`
  );
  const json = await fetchJSON(
    `${DC}?reportName=RPTA_APP_IPOAPPLY&columns=SECURITY_NAME_ABBR,APPLY_CODE,ISSUE_PRICE,PREDICT_ISSUE_PRICE,AFTER_ISSUE_PE,PREDICT_ISSUE_PE,INDUSTRY_PE,INDUSTRY_NAME,MARKET,TOP_APPLY_MARKETCAP&pageSize=20&sortColumns=APPLY_DATE&sortTypes=1&source=WEB&client=PC&filter=${filter}`,
    { timeout: 10000 }
  );
  return (json?.result?.data || []).map((d) => ({
    name: d.SECURITY_NAME_ABBR || "",
    applyCode: String(d.APPLY_CODE || ""),
    price: d.ISSUE_PRICE ?? d.PREDICT_ISSUE_PRICE,
    pe: d.AFTER_ISSUE_PE ?? d.PREDICT_ISSUE_PE,
    industryPe: d.INDUSTRY_PE,
    market: d.MARKET || "",
    topCap: d.TOP_APPLY_MARKET_CAP ?? d.TOP_APPLY_MARKETCAP, // 顶格需配市值（万元）
  }));
}

/** 合并拉取某一天的日历：{ econ: [...], events: [...], ipo: [...] } */
export async function fetchCalendarDay(dateStr) {
  const [econ, events, ipo] = await Promise.allSettled([
    fetchEconomicValues(dateStr),
    fetchCalendarEvents(dateStr),
    fetchIpoDay(dateStr),
  ]);
  return {
    econ: econ.status === "fulfilled" ? econ.value : [],
    events: events.status === "fulfilled" ? events.value : [],
    ipo: ipo.status === "fulfilled" ? ipo.value : [],
    failed:
      econ.status !== "fulfilled" && events.status !== "fulfilled" ? "日历数据源请求失败" : null,
  };
}
