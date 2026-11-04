// 东财行情适配器：指数 / 个股批量 / 板块 / 涨跌分布 / 搜索 / 分时
import { fetchJSON, num, normSecid } from "../utils.js";

const PUSH2 = "https://push2.eastmoney.com/api/qt";
// 指数：上证 / 深成 / 创业板
export const INDEXES = [
  { secid: "1.000001", name: "上证指数" },
  { secid: "0.399001", name: "深证成指" },
  { secid: "0.399006", name: "创业板指" },
];

export const INDEX_SECIDS = INDEXES.map((i) => i.secid).join(",");

// 行情字段（fltt=2 时多为浮点）：f2最新 f3涨跌幅% f4涨跌额 f5成交量 f6成交额
// f12代码 f13市场 f14名称 f15最高 f16最低 f17今开 f18昨收
const QUOTE_FIELDS = "f2,f3,f4,f5,f6,f12,f13,f14,f15,f16,f17,f18";

function mapQuote(d) {
  const secid = `${d.f13}.${d.f12}`;
  return {
    secid,
    code: String(d.f12 || ""),
    market: String(d.f13 ?? ""),
    name: d.f14 || d.f58 || "",
    price: num(d.f2),
    chg: num(d.f4),
    pct: num(d.f3),
    volume: num(d.f5),
    amount: num(d.f6),
    high: num(d.f15),
    low: num(d.f16),
    open: num(d.f17),
    preClose: num(d.f18),
  };
}

/** 指数行情 ulist.np/get 批量 */
export async function fetchIndexes() {
  const url = `${PUSH2}/ulist.np/get?fltt=2&secids=${INDEX_SECIDS}&fields=${QUOTE_FIELDS}`;
  const json = await fetchJSON(url);
  const diff = json?.data?.diff;
  const list = Array.isArray(diff) ? diff : diff ? [diff] : [];
  return list.map(mapQuote);
}

/** 自选股批量行情 */
export async function fetchQuotes(secids) {
  if (!secids.length) return [];
  const url = `${PUSH2}/ulist.np/get?fltt=2&secids=${secids.join(",")}&fields=${QUOTE_FIELDS}`;
  const json = await fetchJSON(url);
  const diff = json?.data?.diff;
  const list = Array.isArray(diff) ? diff : diff ? [diff] : [];
  return list.map(mapQuote);
}

/**
 * 板块榜：dir = up(涨幅榜) | down(跌幅榜)，pz 条数
 * f12板块代码 f14名称 f3涨跌幅 f2点位 f128领涨股 f140领涨股代码 f141领涨市场
 */
export async function fetchSectors({ dir = "up", pz = 8 } = {}) {
  const fid = dir === "down" ? "f3" : "f3"; // 榜单按涨跌幅排序：up 需降序 po=1，down 需升序 po=0
  const po = dir === "down" ? 0 : 1;
  const fields = "f2,f3,f4,f12,f14,f128,f140,f141";
  const url = `${PUSH2}/clist/get?pn=1&pz=${pz}&po=${po}&np=1&fltt=2&invt=2&fid=${fid}&fs=m:90+t:2+f:!50&fields=${fields}`;
  const json = await fetchJSON(url);
  const diff = json?.data?.diff;
  const list = Array.isArray(diff) ? diff : diff ? [diff] : [];
  return list.map((d) => ({
    code: String(d.f12 || ""),
    name: d.f14 || "",
    pct: num(d.f3),
    price: num(d.f2),
    leader: d.f128 || "",
    leaderSecid: d.f141 != null && d.f140 ? `${d.f141}.${d.f140}` : "",
  }));
}

/**
 * 两市涨跌家数（getTopicZDFenBu 涨跌分布）
 * fenbu: [{ "-1": 406 }, ...]，key 为涨跌幅档位（-11..11），value 为家数
 */
export async function fetchBreadth() {
  const url =
    "https://push2ex.eastmoney.com/getTopicZDFenBu?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt";
  const json = await fetchJSON(url);
  const fenbu = json?.data?.fenbu || [];
  let up = 0, down = 0, flat = 0;
  for (const item of fenbu) {
    const [rawKey, count] = Object.entries(item)[0];
    const key = Number(rawKey);
    const n = num(count);
    if (key > 0) up += n;
    else if (key < 0) down += n;
    else flat += n;
  }
  return { up, down, flat, ts: Date.now() };
}

/**
 * 股票搜索 suggest：支持 代码/名称/拼音
 */
export async function searchStocks(keyword) {
  const kw = String(keyword || "").trim();
  if (!kw) return [];
  const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(
    kw
  )}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=8`;
  const json = await fetchJSON(url);
  const rows = json?.QuotationCodeTable?.Data || [];
  return rows.map((r) => ({
    secid: r.QuoteID || "",
    code: r.Code || "",
    name: r.Name || "",
    market: r.MktNum != null ? String(r.MktNum) : r.MarketType || "",
    typeName: r.SecurityTypeName || "",
    pinyin: r.PinYin || "",
  }));
}

/**
 * 分时走势 trends2：ndays=1 当日分时
 * 返回 { preClose, name, points: [{ time, price, avg, vol, amount }] }
 */
export async function fetchTrend(secid) {
  const fields1 = "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13";
  const fields2 = "f51,f52,f53,f54,f55,f56,f57,f58";
  const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${secid}&fields1=${fields1}&fields2=${fields2}&ndays=1&iscr=0`;
  const json = await fetchJSON(url, { timeout: 15000 });
  const d = json?.data;
  if (!d || !Array.isArray(d.trends)) return null;
  const points = d.trends.map((row) => {
    // "2026-11-04 09:30,open,price,high,low,vol,amount,avg"
    const [t, , price, , , vol, amount, avg] = row.split(",");
    return {
      time: (t || "").slice(11), // HH:mm
      price: num(price),
      avg: num(avg),
      vol: num(vol),
      amount: num(amount),
    };
  });
  return { name: d.name, preClose: num(d.prePrice), points };
}

/**
 * 区间日线（kline klt=101 前复权）：仅取收盘价，用于多日趋势折线。
 * @param {string} secid 如 "1.600519"
 * @param {number} days  回看自然日天数（7/40/200 等，会折算成 beg 起始日期）
 * 返回 { name, points: [{ date, close }] }
 */
export async function fetchKline(secid, days = 7) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 864e5);
  const fmt = (d) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const fields2 = "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"; // 日期,开,收,高,低,量,额,振幅,涨跌幅,涨跌额,换手
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=${fields2}&klt=101&fqt=1&beg=${fmt(start)}&end=${fmt(end)}`;
  const json = await fetchJSON(url, { timeout: 15000 });
  const d = json?.data;
  if (!d || !Array.isArray(d.klines)) return null;
  const points = d.klines.map((row) => {
    const [date, , close] = row.split(",");
    return { date, close: num(close) };
  });
  return { name: d.name, points };
}