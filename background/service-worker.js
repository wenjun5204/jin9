// Service Worker：数据中枢
// 职责：alarms 定时拉取行情+快讯 -> 增量合并 -> 写入 storage.session -> 广播给 popup
import * as emQ from "../lib/sources/em-quotes.js";
import * as emN from "../lib/sources/em-news.js";
import * as tx from "../lib/sources/tx-quotes.js";

const CACHE_KEY = "snapshot";
const WATCH_KEY = "watchlist"; // 自选股（跨会话持久）
const SETTINGS_KEY = "settings";

// 默认配置
const DEFAULTS = {
  refreshMs: 15000, // 行情刷新间隔
  newsMs: 15000, // 快讯刷新间隔
};

// 行情源降级状态
let emFailCount = 0;
// 高频定时器（SW 存活期间有效）；alarms 仅作保活心跳
let quoteTimer = null;
let newsTimer = null;

// ---------- 生命周期 ----------
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", async () => {
  try {
    await self.clients.claim();
    const settings = await getSettings();
    // alarms 创建失败不能阻断初始化（Alarm 最小周期 0.5 分钟）
    await ensureAlarms(settings).catch(() => {});
    startTimers(settings);
    // 首次激活立即拉取一次
    await Promise.allSettled([pollQuotes(), pollNews()]);
  } catch (err) {
    console.warn("[盯盘快讯] 激活流程异常: ", err?.message);
  }
});

// ---------- 定时 ----------
// MV3 限制：chrome.alarms 最小周期 30s（0.5 分），不足以支撑 5s/15s 高频刷新。
// 因此：高频拉取由 SW 存活期间的 setInterval 承担；alarms 仅作 30s 保活心跳，
// SW 被休眠后由心跳唤醒并重建定时器，保证后台持续更新。
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "heartbeat") return;
  getSettings().then((settings) => {
    startTimers(settings);
    // 唤醒后立即补拉一次，确保 popup 打开时缓存是最新的
    Promise.allSettled([pollQuotes(), pollNews()]);
  });
});

async function ensureAlarms(settings) {
  // heartbeat 固定 30s（不随 refreshMs 变化），clamp 到 alarm 允许的最小周期
  await chrome.alarms.create("heartbeat", {
    periodInMinutes: 0.5,
  });
}

function startTimers(settings) {
  stopTimers();
  const qms = Math.max(5000, Number(settings.refreshMs) || 15000);
  const nms = Math.max(5000, Number(settings.newsMs) || 15000);
  quoteTimer = setInterval(pollQuotes, qms);
  newsTimer = setInterval(pollNews, nms);
}

function stopTimers() {
  if (quoteTimer) clearInterval(quoteTimer);
  if (newsTimer) clearInterval(newsTimer);
  quoteTimer = null;
  newsTimer = null;
}

// ---------- 行情拉取 ----------

async function pollQuotes() {
  try {
    const watch = await getWatchlist();
    const results = await fetchAllQuotes(watch.secids);
    const snapshot = await getSnapshot();
    snapshot.indexes = results.indexes;
    snapshot.watch = results.watch;
    snapshot.sectors = results.sectors;
    snapshot.breadth = results.breadth;
    snapshot.quotesTs = Date.now();
    snapshot.lastError = null;
    await saveSnapshot(snapshot);
    emFailCount = 0;
    broadcast();
  } catch (err) {
    emFailCount++;
    if (emFailCount >= 2) {
      // 东财行情异常 -> 尝试腾讯兜底（仅自选股）
      try {
        const watch = await getWatchlist();
        const watchQuotes = await tx.fetchTxQuotes(watch.secids);
        const snapshot = await getSnapshot();
        snapshot.watch = watchQuotes;
        snapshot.quotesTs = Date.now();
        snapshot.lastError = "东财行情异常，自选股已切换腾讯数据源";
        await saveSnapshot(snapshot);
        broadcast();
        return;
      } catch (txErr) {
        /* 兜底失败，走下面标记错误 */
      }
    }
    markQuotesError(err);
  }
}

async function fetchAllQuotes(secids) {
  const [indexes, watch, sectors, breadth] = await Promise.all([
    emQ.fetchIndexes(),
    secids.length ? emQ.fetchQuotes(secids) : Promise.resolve([]),
    emQ.fetchSectors({ pz: 8 }),
    emQ.fetchBreadth().catch(() => ({ up: 0, down: 0, flat: 0, ts: Date.now() })),
  ]);
  return { indexes, watch, sectors, breadth };
}

function markQuotesError(err) {
  const msg = `行情获取失败: ${err?.message || err}`;
  getSnapshot().then((snap) => {
    snap.lastError = msg;
    snap.lastErrorTs = Date.now();
    return saveSnapshot(snap);
  });
}

// ---------- 快讯拉取（增量） ----------

async function pollNews() {
  try {
    const snapshot = await getSnapshot();
    const { list } = await emN.fetchNews({ size: 20 });
    if (!list.length) {
      await saveSnapshot(snapshot);
      broadcast();
      return;
    }
    // 增量合并：按 id 去重，新条目插到头部，上限 100 条
    const existing = snapshot.news || [];
    const seen = new Set(existing.map((n) => n.id));
    const added = list.filter((n) => !seen.has(n.id));
    snapshot.news = [...added, ...existing].slice(0, 100);
    snapshot.newsTs = Date.now();
    await saveSnapshot(snapshot);
    broadcast(added.length ? { added: added.length } : undefined);
  } catch (err) {
    // 快讯失败静默退避，不打断 UI
  }
}

// ---------- 快照读写 ----------

async function getSnapshot() {
  const { [CACHE_KEY]: snap } = await chrome.storage.session.get(CACHE_KEY);
  return (
    snap || {
      indexes: [],
      watch: [],
      sectors: [],
      breadth: { up: 0, down: 0, flat: 0 },
      news: [],
      quotesTs: 0,
      newsTs: 0,
      lastError: null,
      lastErrorTs: 0,
    }
  );
}

async function saveSnapshot(snap) {
  await chrome.storage.session.set({ [CACHE_KEY]: snap });
}

// ---------- 消息处理 ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "GET_SNAPSHOT":
        return { ok: true, snapshot: await getSnapshot(), settings: await getSettings() };
      case "REFRESH_NOW":
        // popup 打开时主动刷新一次（先清错误状态并确保定时器运行）
        {
          const snap = await getSnapshot();
          snap.lastError = null;
          snap.lastErrorTs = 0;
          await saveSnapshot(snap);
          const settings = await getSettings();
          await ensureAlarms(settings).catch(() => {});
          startTimers(settings);
        }
        await Promise.allSettled([pollQuotes(), pollNews()]);
        return { ok: true, snapshot: await getSnapshot() };
      case "GET_WATCH":
        return { ok: true, watch: await getWatchlist() };
      case "ADD_WATCH": {
        const w = await getWatchlist();
        if (!w.secids.includes(msg.secid)) {
          w.secids.push(msg.secid);
          w.names[msg.secid] = msg.name || "";
          await setWatchlist(w);
          pollQuotes(); // 加仓后立即刷新行情
        }
        return { ok: true, watch: w };
      }
      case "REMOVE_WATCH": {
        const w = await getWatchlist();
        w.secids = w.secids.filter((s) => s !== msg.secid);
        delete w.names[msg.secid];
        await setWatchlist(w);
        pollQuotes();
        return { ok: true, watch: w };
      }
      case "GET_SETTINGS":
        return { ok: true, settings: await getSettings() };
      case "SET_SETTINGS": {
        const cur = await getSettings();
        const next = { ...cur, ...msg.settings };
        await storageSet(SETTINGS_KEY, next);
        await ensureAlarms(next).catch(() => {});
        startTimers(next);
        return { ok: true, settings: next };
      }
      default:
        return { ok: false, error: "unknown type" };
    }
  })()
    .then((res) => sendResponse(res))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true; // 异步响应
});

// ---------- 自选 / 设置 ----------

/**
 * 双存储写入：优先 chrome.storage.sync（跨设备，未登录自动本地化），
 * 写入失败（配额/网络异常）自动降级 chrome.storage.local 兜底。
 */
async function storageSet(key, value) {
  try {
    await chrome.storage.sync.set({ [key]: value });
    return "sync";
  } catch (e) {
    console.warn(`[盯盘快讯] sync 写入失败(${e?.message})，降级本地存储`);
    await chrome.storage.local.set({ [key]: value });
    return "local";
  }
}

async function getWatchlist() {
  // 读取：优先 sync，其次是 local（兼容旧版本数据，读到时下次 set 自动迁入 sync）
  const fromSync = await chrome.storage.sync.get(WATCH_KEY).catch(() => ({}));
  const fromLocal = await chrome.storage.local.get(WATCH_KEY);
  const w = fromSync[WATCH_KEY] ?? fromLocal[WATCH_KEY];
  return (
    w || {
      secids: ["1.600519", "0.300750", "0.002594", "1.601318"],
      names: {
        "1.600519": "贵州茅台",
        "0.300750": "宁德时代",
        "0.002594": "比亚迪",
        "1.601318": "中国平安",
      },
    }
  );
}

async function setWatchlist(w) {
  await storageSet(WATCH_KEY, w);
}

async function getSettings() {
  // 读取：优先 sync，兼容 local 旧数据
  const fromSync = await chrome.storage.sync.get(SETTINGS_KEY).catch(() => ({}));
  const fromLocal = await chrome.storage.local.get(SETTINGS_KEY);
  const s = fromSync[SETTINGS_KEY] ?? fromLocal[SETTINGS_KEY];
  return s || DEFAULTS;
}

// ---------- 广播 ----------

async function broadcast(extra) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const snapshot = await getSnapshot();
  for (const c of clients) {
    c.postMessage({ type: "DATA_UPDATE", snapshot, ...(extra || {}), ts: Date.now() });
  }
}
