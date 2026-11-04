// 通用工具：请求封装 / 数值格式化 / 市场代码处理

/** 带超时的 JSON 请求 */
export async function fetchJSON(url, { timeout = 10000, headers = {} } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { Accept: "application/json", ...headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`请求超时: ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 数字安全解析：NaN/undefined/null -> fallback */
export function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 价格格式化：按小数位 */
export function fmtPrice(v, dec = 2) {
  return num(v).toFixed(dec);
}

/** 涨跌幅格式化：带符号百分比 */
export function fmtPct(v) {
  const n = num(v);
  const s = n > 0 ? "+" : "";
  return `${s}${n.toFixed(2)}%`;
}

/** 涨跌额格式化：带符号 */
export function fmtChg(v) {
  const n = num(v);
  const s = n > 0 ? "+" : "";
  return `${s}${n.toFixed(2)}`;
}

/** 成交额格式化：万 / 亿 */
export function fmtAmount(v) {
  const n = num(v);
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(0)}万`;
  return `${n}`;
}

/** 成交量(手) -> 万手 */
export function fmtVol(v) {
  const n = num(v);
  if (n >= 1e4) return `${(n / 1e4).toFixed(2)}万手`;
  return `${n}手`;
}

/** 防抖 */
export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** 防抖带无意义参数判断可用 */
export function throttle(fn, ms) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    }
  };
}

/** 东财 secid 归一化：1.600519 / 0.399001 / 105.AAPL */
export function normSecid(secid) {
  const s = String(secid || "");
  const m = s.match(/^(\d+)\.([A-Za-z0-9]+)$/);
  return m ? { market: m[1], code: m[2] } : null;
}

/** 东财市场 1 沪 / 0 深 / 116 京? / 105 纳 / 106 纽 */
export function marketLabel(market) {
  const m = String(market);
  if (m === "1") return "SH";
  if (m === "0") return "SZ";
  if (m === "116") return "BJ";
  return m;
}

/** 基于 secid 生成腾讯代码：sh600519 / sz300750 */
export function secidToTx(secid) {
  const p = normSecid(secid);
  if (!p) return "";
  const prefix = p.market === "1" ? "sh" : p.market === "0" ? "sz" : p.market === "116" ? "bj" : "";
  return prefix + p.code;
}

/** 时间 `showTime` -> HH:mm */
export function fmtTime(s) {
  const m = String(s || "").match(/(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : "";
}

/** 当前时间 HH:mm:ss */
export function nowClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}