// 腾讯行情兜底适配器（东财行情失败时启用）
// 接口：qt.gtimg.cn/q=sh600519,sz300750（返回 GBK 编码文本）
import { num, secidToTx } from "../utils.js";

const TX_URL = "https://qt.gtimg.cn/q=";

/** 取原始字节并解码为 GBK（腾讯返回 GBK，须显式解码避免中文乱码） */
async function fetchTextGBK(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const buf = await res.arrayBuffer();
    return new TextDecoder("gbk").decode(buf);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 批量拉取行情（腾讯），secids 形如 ["1.600519","0.300750"]
 * 返回结构对齐东财 mapQuote
 */
export async function fetchTxQuotes(secids) {
  const codes = secids.map(secidToTx).filter(Boolean);
  if (!codes.length) return [];
  const text = await fetchTextGBK(`${TX_URL}${codes.join(",")}`);
  const out = [];
  // 逐行 v_sh600519="...";
  const re = /v_(\w+)="([^"]+)";/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const varName = m[1];
    const fields = m[2].split("~");
    // 腾讯字段：0未知 1名称 2代码 3现价 4昨收 5今开 6成交量(手) 31涨跌额 32涨跌幅% 33最高 34最低
    const price = num(fields[3]);
    const preClose = num(fields[4]);
    const pct = preClose ? ((price - preClose) / preClose) * 100 : 0;
    const chg = price - preClose;
    const prefix = varName.startsWith("sh") ? "1" : varName.startsWith("sz") ? "0" : "116";
    out.push({
      secid: `${prefix}.${fields[2]}`,
      code: fields[2],
      market: prefix,
      name: fields[1],
      price,
      chg,
      pct,
      volume: num(fields[6]),
      amount: 0, // 腾讯可用字段36
      high: num(fields[33]),
      low: num(fields[34]),
      open: num(fields[5]),
      preClose,
    });
  }
  return out;
}

export function isTxAvailable() {
  return true;
}