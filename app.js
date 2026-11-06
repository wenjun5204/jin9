// 前端逻辑：行情 Tab + 快讯 Tab
import {
  fmtPrice, fmtPct, fmtAmount,
  debounce, fmtTime,
} from "./lib/utils.js";
import { searchStocks, fetchTrend, fetchKline } from "./lib/sources/em-quotes.js";
import { fetchCalendarDay } from "./lib/sources/em-calendar.js";

// ---------- 全局状态 ----------
let snapshot = null; // { indexes, watch, sectorsUp, sectorsDown, breadth, news, ... }
let activeTab = "quotes";
let filter = "all";
let newsCount = 0; // 当前渲染快讯总数（用于判断新条目标记）
let trendSecid = null; // 当前分时抽屉的标的
let trendRange = "1d"; // 1d 当日分时 | 7d 近7日 | 1m 近一月 | 6m 近半年（收盘价趋势折线）
let sectorDir = "up"; // 板块榜方向：up 涨幅榜 | down 跌幅榜
let calDate = "today"; // 日历日期：yesterday | today | tomorrow
let calFilter = "all"; // 日历过滤：all | data | event
let indexOrder = []; // 指数卡片自定义排序（secid 优先级），空 = 默认顺序
let dragSecid = null; // 正在拖拽的指数卡片（拖拽中暂停指数重渲染）
let dragStartOrder = []; // 拖起时的卡片顺序（dragend 对比是否真的换了位）
const calCache = new Map(); // 日期字符串 -> { econ, events, failed, ts }（10 分钟内复用）

const $ = (sel) => document.querySelector(sel);

// ---------- 初始化 ----------
async function init() {
  bindUI();
  // 监听 SW 广播
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "DATA_UPDATE") {
      snapshot = msg.snapshot;
      render();
    }
  });
  // 主动请求一次并触发刷新
  await refreshNow();
}

async function refreshNow() {
  const res = await chrome.runtime.sendMessage({ type: "REFRESH_NOW" });
  if (res?.ok) {
    snapshot = res.snapshot;
    if (res.settings?.indexOrder) indexOrder = res.settings.indexOrder;
    render();
  }
}

// ---------- UI 事件绑定 ----------
function bindUI() {
  // Tab 切换（通用：按 data-tab 匹配对应 panel）
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeTab = btn.dataset.tab;
      document.querySelectorAll(".panel").forEach((p) => {
        p.classList.toggle("hidden", p.id !== `panel-${activeTab}`);
      });
      if (activeTab === "calendar") loadCalendar();
      render();
    });
  });

  // 刷新间隔
  $("#refresh-select").addEventListener("change", async (e) => {
    const ms = Number(e.target.value);
    await chrome.runtime.sendMessage({ type: "SET_SETTINGS", settings: { refreshMs: ms, newsMs: ms } });
  });

  // 板块榜切换（涨幅 / 跌幅，仅作用于板块 Tab 内的 seg）
  document.querySelectorAll("#panel-sectors .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#panel-sectors .seg-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      sectorDir = btn.dataset.dir;
      renderSectors(); // 用缓存数据即可（榜单数据在快照中）
    });
  });

  // 添加自选
  $("#add-watch-btn").addEventListener("click", () => {
    $("#search-box").classList.toggle("hidden");
    $("#search-input").value = "";
    $("#search-result").innerHTML = "";
    if (!$("#search-box").classList.contains("hidden")) $("#search-input").focus();
  });
  $("#search-input").addEventListener("input", debounce(onSearch, 250));

  // 分时关闭
  $("#trend-close").addEventListener("click", closeTrend);

  // 分时抽屉：周期切换（1日 / 7日 / 1月 / 半年）
  document.querySelectorAll("#trend-drawer .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#trend-drawer .seg-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      trendRange = btn.dataset.range;
      loadTrend();
    });
  });

  // 日历：日期切换（昨日/今日/明日）与类型过滤（全部/数据/事件）
  document.querySelectorAll("#panel-calendar .seg-btn[data-caldate]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll("#panel-calendar .seg-btn[data-caldate]")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      calDate = btn.dataset.caldate;
      loadCalendar();
    });
  });
  document.querySelectorAll("#panel-calendar .seg-btn[data-calfilter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll("#panel-calendar .seg-btn[data-calfilter]")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      calFilter = btn.dataset.calfilter;
      renderCalendar();
    });
  });
  // 日历事件行点击展开详情；展开区内相关快讯/搜索链接直接外跳
  $("#calendar-list").addEventListener("click", (e) => {
    const link = e.target.closest(".cal-rel, .cal-search");
    if (link) {
      if (link.dataset.url) chrome.tabs.create({ url: link.dataset.url });
      return;
    }
    const row = e.target.closest(".cal-event");
    if (row) row.classList.toggle("expanded");
  });

  // 快讯过滤器
  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      filter = btn.dataset.filter;
      renderNews();
    });
  });

  // 快讯滚动到底加载更早（当前简化：一次性展示缓存，加载历史在二期）
  $("#panel-news").addEventListener("scroll", (e) => {
    if (e.target.scrollTop + e.target.clientHeight >= e.target.scrollHeight - 20) {
      // loadMoreNews();
    }
  });

  // 点击指数卡片 -> 拉取该指数分时
  $("#index-row").addEventListener("click", (e) => {
    const card = e.target.closest(".index-card");
    if (card) openTrend(card.dataset.secid, card.dataset.name);
  });
  // 指数卡片拖拽排序
  bindIndexDrag();
  // 点击自选行 -> 分时
  $("#watch-list").addEventListener("click", (e) => {
    const del = e.target.closest(".q-del");
    if (del) { removeWatch(del.dataset.secid); return; }
    const row = e.target.closest(".quote-row");
    if (row) openTrend(row.dataset.secid, row.dataset.name);
  });
  // 快讯关联股票标签 -> 跳到行情并加入自选；条目点击展开/收起；阅读全文跳详情
  $("#news-list").addEventListener("click", (e) => {
    const tag = e.target.closest(".stock-tag");
    if (tag) { addFromNews(tag.dataset.secid, tag.dataset.name); return; }
    const link = e.target.closest(".news-link");
    if (link) {
      const url = link.dataset.url;
      if (url) chrome.tabs.create({ url });
      return;
    }
    const item = e.target.closest(".news-item");
    if (item) item.classList.toggle("expanded");
  });
}

// ---------- 搜索 / 自选 ----------
async function onSearch() {
  const kw = $("#search-input").value.trim();
  if (!kw) { $("#search-result").innerHTML = ""; return; }
  const items = await searchStocks(kw);
  $("#search-result").innerHTML = items
    .map(
      (i) =>
        `<div class="search-item" data-secid="${i.secid}" data-name="${i.name}">
           <span class="si-name">${i.name}</span>
           <span class="si-code">${i.code} ${i.typeName || ""}</span>
         </div>`
    )
    .join("");
  $("#search-result").querySelectorAll(".search-item").forEach((el) => {
    el.addEventListener("click", () => addWatch(el.dataset.secid, el.dataset.name));
  });
}

async function addWatch(secid, name) {
  await chrome.runtime.sendMessage({ type: "ADD_WATCH", secid, name });
  $("#search-box").classList.add("hidden");
  $("#search-result").innerHTML = "";
  await refreshNow();
}

async function removeWatch(secid) {
  await chrome.runtime.sendMessage({ type: "REMOVE_WATCH", secid });
  await refreshNow();
}

// 快讯关联股票 -> 加入自选并切到行情
async function addFromNews(secid, name) {
  await chrome.runtime.sendMessage({ type: "ADD_WATCH", secid, name });
  // 切到行情 Tab
  document.querySelector('[data-tab="quotes"]').click();
}

// ---------- 分时 / 趋势 ----------
async function openTrend(secid, name) {
  trendSecid = secid;
  trendRange = "1d"; // 打开默认当日分时
  document.querySelectorAll("#trend-drawer .seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.range === "1d")
  );
  $("#trend-name").textContent = name;
  const prev = $("#trend-drawer").classList.contains("hidden");
  $("#trend-drawer").classList.remove("hidden");
  if (prev) await loadTrend();
}

async function loadTrend() {
  if (!trendSecid) return;
  const canvas = $("#trend-canvas");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  try {
    if (trendRange === "1d") {
      const data = await fetchTrend(trendSecid);
      drawTrend(data);
    } else {
      // 自然日回看天数（含双休/节假日余量），半年 200 天约 130+ 个交易日
      const days = trendRange === "7d" ? 10 : trendRange === "1m" ? 40 : 200;
      const data = await fetchKline(trendSecid, days);
      drawLine(data, trendRange === "7d" ? "近7日" : trendRange === "1m" ? "近1月" : "近半年");
    }
  } catch (err) {
    ctx.fillStyle = "#8a93a6";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("数据加载失败", canvas.width / 2, canvas.height / 2);
    ctx.textAlign = "left";
  }
}

function closeTrend() {
  $("#trend-drawer").classList.add("hidden");
  trendSecid = null;
}

function drawTrend(data) {
  const canvas = $("#trend-canvas");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const pts = data?.points;
  if (!pts || !pts.length) return;
  // 缩放
  const min = Math.min(...pts.map((p) => p.price), data.preClose);
  const max = Math.max(...pts.map((p) => p.price), data.preClose);
  const padL = 4, padR = 4, padT = 8, padB = 8;
  const range = max - min || 1;
  const x = (i) => padL + (i / Math.max(1, pts.length - 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - min) / range) * (H - padT - padB);
  // 昨收虚线
  ctx.strokeStyle = "#8a93a6";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(padL, y(data.preClose));
  ctx.lineTo(W - padR, y(data.preClose));
  ctx.stroke();
  ctx.setLineDash([]);
  // 价格线
  ctx.strokeStyle = "#e05252";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(x(i), y(p.price)) : ctx.lineTo(x(i), y(p.price))));
  ctx.stroke();
  // 均价线
  ctx.strokeStyle = "#e8a33c";
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(x(i), y(p.avg)) : ctx.lineTo(x(i), y(p.avg))));
  ctx.stroke();
}

/** 多日趋势折线：收盘价曲线 + 渐变填充 + 网格刻度 */
function drawLine(data, label) {
  const canvas = $("#trend-canvas");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const pts = data?.points;
  if (!pts || pts.length < 2) return;
  const closes = pts.map((p) => p.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const padL = 34, padR = 4, padT = 10, padB = 14;
  const range = max - min || 1;
  const x = (i) => padL + (i / (pts.length - 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - min) / range) * (H - padT - padB);
  // 网格 + 左轴刻度
  ctx.strokeStyle = "#232b3a";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#8a93a6";
  ctx.font = "9px sans-serif";
  for (let g = 0; g <= 4; g++) {
    const v = min + (range * g) / 4;
    const yy = y(v);
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(W - padR, yy);
    ctx.stroke();
    ctx.fillText(v.toFixed(1), 2, yy + 3);
  }
  // 涨跌主色（末收盘 vs 首收盘）
  const up = closes[closes.length - 1] >= closes[0];
  const color = up ? "#e05252" : "#2db673";
  // 渐变填充
  const grad = ctx.createLinearGradient(0, padT, 0, H - padB);
  grad.addColorStop(0, up ? "rgba(224,82,82,.28)" : "rgba(45,182,115,.28)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(x(i), y(p.close)) : ctx.lineTo(x(i), y(p.close))));
  ctx.lineTo(x(pts.length - 1), H - padB);
  ctx.lineTo(x(0), H - padB);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  // 收盘折线
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(x(i), y(p.close)) : ctx.lineTo(x(i), y(p.close))));
  ctx.stroke();
  // 首尾日期
  ctx.fillStyle = "#8a93a6";
  ctx.font = "9px sans-serif";
  ctx.fillText(`▍${label} ${pts[0].date} ~ ${pts[pts.length - 1].date}`, padL, H - 3);
}

// ---------- 指数卡片拖拽排序 ----------
function bindIndexDrag() {
  const row = $("#index-row");

  row.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".index-card");
    if (!card) return;
    dragSecid = card.dataset.secid;
    dragStartOrder = [...row.querySelectorAll(".index-card")].map((c) => c.dataset.secid);
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragSecid); // Firefox 需要
  });

  row.addEventListener("dragover", (e) => {
    if (!dragSecid) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const dragging = row.querySelector(".index-card.dragging");
    if (!dragging) return;
    // 拖到容器边缘时自动横滚，方便拖到首/尾
    const rect = row.getBoundingClientRect();
    if (e.clientX < rect.left + 30) row.scrollLeft -= 10;
    else if (e.clientX > rect.right - 30) row.scrollLeft += 10;
    // 实时换位：插入到光标最近且在其右侧的卡片之前
    const after = getDragAfterElement(row, e.clientX);
    if (!after) row.appendChild(dragging);
    else if (after !== dragging) row.insertBefore(dragging, after);
  });

  row.addEventListener("dragend", () => {
    const card = row.querySelector(".index-card.dragging");
    card?.classList.remove("dragging");
    if (dragSecid) {
      const newOrder = [...row.querySelectorAll(".index-card")].map((c) => c.dataset.secid);
      if (newOrder.join() !== dragStartOrder.join()) {
        indexOrder = newOrder;
        saveIndexOrder();
      }
    }
    dragSecid = null;
    renderIndexes(); // 按（新）顺序统一重渲染，去掉拖拽残留状态
  });
}

/** 光标左侧最近的非拖拽卡片（作为插入锚点） */
function getDragAfterElement(container, x) {
  const cards = [...container.querySelectorAll(".index-card:not(.dragging)")];
  let closest = null;
  let closestOffset = -Infinity;
  for (const child of cards) {
    const box = child.getBoundingClientRect();
    const offset = x - box.left - box.width / 2;
    if (offset < 0 && offset > closestOffset) {
      closestOffset = offset;
      closest = child;
    }
  }
  return closest;
}

async function saveIndexOrder() {
  try {
    const res = await chrome.runtime.sendMessage({
      type: "SET_SETTINGS",
      settings: { indexOrder },
    });
    if (res?.ok && res.settings?.indexOrder) indexOrder = res.settings.indexOrder;
  } catch (e) {
    /* 保存失败仅本次会话生效，不打断 UI */
  }
}

// ---------- 渲染 ----------
function render() {
  renderQuotes();
  renderSectors();
  renderNews();
  renderCalendar();
  renderStatus();
}

function renderStatus() {
  const dot = $("#src-dot");
  const err = snapshot?.lastError;
  dot.className = "src-dot " + (err ? (err.includes("腾讯") ? "warn" : "err") : "ok");
  dot.title = err || "数据正常（东财）";
  const banner = $("#error-banner");
  if (err) { banner.textContent = err; banner.classList.remove("hidden"); }
  else banner.classList.add("hidden");
}

function renderQuotes() {
  if (activeTab !== "quotes") return;
  renderIndexes();
  renderBreadth();
  renderMarketFlow();
  renderWatch();
}

function renderIndexes() {
  if (dragSecid) return; // 拖拽中不重渲染，避免轮询广播冲掉正在拖的 DOM
  const rows = orderedIndexes();
  $("#index-row").innerHTML = rows
    .map((i) => {
      const cls = i.pct > 0 ? "up" : i.pct < 0 ? "down" : "flat";
      // 外汇（离岸人民币）保留 4 位小数，其余 2 位
      const dec = i.price > 0 && i.price < 10 ? 4 : 2;
      return `<div class="index-card" draggable="true" data-secid="${i.secid}" data-name="${i.name}" title="点击看分时 · 可拖拽排序">
        <div class="index-name">${i.name}</div>
        <div class="index-price ${cls}">${fmtPrice(i.price, dec)}</div>
        <div class="index-pct ${cls}">${fmtPct(i.pct)}</div>
      </div>`;
    })
    .join("");
}

/** 按用户自定义顺序排指数卡片；未记录的（新增指数）追加在尾部 */
function orderedIndexes() {
  const rows = [...(snapshot?.indexes || [])];
  if (!indexOrder.length) return rows;
  const rank = new Map(indexOrder.map((s, i) => [s, i]));
  const tail = indexOrder.length;
  return rows.sort(
    (a, b) => (rank.get(a.secid) ?? tail) - (rank.get(b.secid) ?? tail)
  );
}

function renderBreadth() {
  const b = snapshot?.breadth || { up: 0, down: 0, flat: 0 };
  const total = b.up + b.down + b.flat || 1;
  const upPct = (b.up / total) * 100;
  const downPct = (b.down / total) * 100;
  const flatPct = (b.flat / total) * 100;
  $("#breadth-bar").innerHTML = `
    <div class="u" style="width:${upPct}%"></div>
    <div class="f" style="width:${flatPct}%"></div>
    <div class="d" style="width:${downPct}%"></div>`;
  $("#breadth-labels").innerHTML = `
    <span class="up">涨 ${b.up}</span>
    <span class="flat">平 ${b.flat}</span>
    <span class="down">跌 ${b.down}</span>`;
}

/** 盘中资金面：两市成交额 + 涨停/炸板/跌停家数（北向实时净流入已停止披露） */
function renderMarketFlow() {
  const el = $("#market-flow");
  const f = snapshot?.marketFlow;
  if (!f || !f.turnover) {
    el.innerHTML = "&nbsp;";
    return;
  }
  // 亿元 -> 万亿缩写（不足万亿显示亿）
  const t = f.turnover;
  const turnover = t >= 1e12 ? `${(t / 1e12).toFixed(2)}万亿` : fmtAmount(t);
  el.innerHTML = `
    <span>两市成交 <b>${turnover}</b></span>
    <span><i class="up">涨停 ${f.limitUp}</i> · 炸板 ${f.broken} · <i class="down">跌停 ${f.limitDown}</i></span>`;
}

function renderWatch() {
  const rows = snapshot?.watch || [];
  const names = snapshot?.watchNames || {};
  $("#watch-list").innerHTML = rows.length
    ? rows
        .map((q) => {
          const cls = q.pct > 0 ? "up" : q.pct < 0 ? "down" : "flat";
          const nm = q.name || names[q.secid] || q.code;
          return `<div class="quote-row" data-secid="${q.secid}" data-name="${nm}">
            <div class="q-main">
              <div class="q-name">${nm}</div>
              <div class="q-sub">${q.code} · ${fmtAmount(q.amount)}</div>
            </div>
            <div class="q-price">
              <div class="num ${cls}">${fmtPrice(q.price)}</div>
              <div class="pct ${cls}">${fmtPct(q.pct)}</div>
            </div>
            <button class="q-del" data-secid="${q.secid}" title="删除">✕</button>
          </div>`;
        })
        .join("")
    : '<div style="color:var(--text-dim);padding:12px;text-align:center">暂无自选，点击右上角＋添加</div>';
}

function renderSectors() {
  if (activeTab !== "sectors") return;
  const rows = (sectorDir === "down" ? snapshot?.sectorsDown : snapshot?.sectorsUp) || [];
  const leaderLabel = sectorDir === "down" ? "领跌" : "领涨";
  $("#sector-list").innerHTML = rows.length
    ? rows
        .map((s) => {
          const cls = s.pct > 0 ? "up" : s.pct < 0 ? "down" : "flat";
          return `<div class="sector-row">
            <div>
              <div class="sector-name">${s.name}</div>
              <div class="sector-leader">${leaderLabel}: ${s.leader || "-"}</div>
            </div>
            <div class="sector-pct ${cls}">${fmtPct(s.pct)}</div>
          </div>`;
        })
        .join("")
    : '<div style="color:var(--text-dim);padding:12px;text-align:center">暂无板块数据</div>';
}

// ---------- 财经日历 ----------

/** calDate(yesterday/today/tomorrow) -> 'yyyy-MM-dd' */
function calDateStr() {
  const d = new Date();
  if (calDate === "yesterday") d.setDate(d.getDate() - 1);
  else if (calDate === "tomorrow") d.setDate(d.getDate() + 1);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function loadCalendar() {
  const key = calDateStr();
  const cached = calCache.get(key);
  const fresh = cached && Date.now() - cached.ts < 10 * 60 * 1000;
  if (!fresh) {
    $("#calendar-list").innerHTML = '<div class="cal-empty">加载中…</div>';
    try {
      const day = await fetchCalendarDay(key);
      calCache.set(key, { ...day, ts: Date.now() });
    } catch (err) {
      $("#calendar-list").innerHTML = `<div class="cal-empty">日历加载失败: ${err?.message || err}</div>`;
      return;
    }
  }
  renderCalendar();
}

function renderCalendar() {
  if (activeTab !== "calendar") return;
  const day = calCache.get(calDateStr());
  if (!day) return;
  // 汇总行：国外经济数据 + 日历事件（含中国数据预告），按时间排序
  const econRows = calFilter === "event" ? [] : day.econ;
  const evtRows = day.events.filter((e) =>
    calFilter === "data" ? e.kind === "data" : calFilter === "event" ? e.kind === "event" : true
  );
  const rows = [...econRows, ...evtRows].sort((a, b) => {
    const na = a.time === "--:--" ? 1 : 0;
    const nb = b.time === "--:--" ? 1 : 0;
    if (na !== nb) return na - nb;
    return a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
  });
  if (!rows.length) {
    $("#calendar-list").innerHTML =
      `<div class="cal-empty">${day.failed || "当日暂无财经日历条目"}</div>`;
    return;
  }
  // 统计行：说明「带值数据」与「发布预告」的数量（预告类无前值/公布值字段）
  const dataCount = day.events.filter((e) => e.kind === "data").length;
  const pubCount = day.econ.filter((e) => e.published).length;
  const label = { yesterday: "昨日", today: "今日", tomorrow: "明日" }[calDate] || "";
  const countLine = `<div class="cal-count">${label} · 带值数据 ${day.econ.length} 条（已公布 ${pubCount}）· 发布预告 ${dataCount} 条</div>`;
  // 打新申购名单（随日期切换；无申购则隐藏区块）
  const ipo = day.ipo || [];
  const ipoBlock = $("#ipo-block");
  if (calFilter !== "event" && ipo.length) {
    ipoBlock.classList.remove("hidden");
    $("#ipo-count").textContent = `${label}可申购 ${ipo.length} 只`;
    $("#ipo-list").innerHTML = ipo.map(renderIpoRow).join("");
  } else {
    ipoBlock.classList.add("hidden");
  }
  $("#calendar-list").innerHTML = countLine + rows.map(renderCalRow).join("");
}

/** 打新行：名称/申购代码/板块 + 发行价/PE对比/顶格市值 */
function renderIpoRow(r) {
  const price = r.price != null ? `${fmtCalValue(r.price)}元` : "发行价待定";
  const pe =
    r.pe != null
      ? r.industryPe != null
        ? `PE ${r.pe} / 行业 ${r.industryPe}`
        : `PE ${r.pe}`
      : "";
  const cap = r.topCap != null ? `顶格需配 ${Math.round(Number(r.topCap))}万` : "";
  const sub = [`申购 ${r.applyCode || "--"}`, r.market, cap].filter(Boolean).join(" · ");
  return `<div class="ipo-row">
    <div class="ipo-main">
      <div class="ipo-name">${escapeHtml(r.name)}</div>
      <div class="ipo-sub">${escapeHtml(sub)}</div>
    </div>
    <div class="cal-values">
      <div class="ipo-price">${price}</div>
      ${pe ? `<div class="ipo-pe">${pe}</div>` : ""}
    </div>
  </div>`;
}

function renderCalRow(r) {
  const country = r.country
    ? `<span class="cal-country">${escapeHtml(r.country)}</span>`
    : "";
  if (r.kind === "econ") {
    const val = r.published ? fmtCalValue(r.value) : "待公布";
    return `<div class="cal-row">
      <span class="cal-time">${r.time}</span>
      ${country}
      <div class="cal-main"><div class="cal-name">${escapeHtml(r.name)}</div></div>
      <div class="cal-values">
        <div class="cal-val${r.published ? " pub" : ""}">${val}</div>
        <div class="cal-pre">前值 ${r.pre != null ? fmtCalValue(r.pre) : "--"}</div>
      </div>
    </div>`;
  }
  if (r.kind === "data") {
    // 发布预告：东财源仅有时间+名称，无前值/公布值，右侧给「预告」标记避免误读为空数据
    return `<div class="cal-row cal-event">
      <span class="cal-time">${r.time}</span>
      ${country}
      <div class="cal-main">
        <div class="cal-name">${escapeHtml(r.name)}</div>
        ${renderCalDetail(r)}
      </div>
      <div class="cal-values"><div class="cal-val tag">预告</div><span class="cal-chev">▸</span></div>
    </div>`;
  }
  return `<div class="cal-row cal-event">
    <span class="cal-time">${r.time}</span>
    ${country}
    <div class="cal-main">
      <div class="cal-name">${escapeHtml(r.name)}</div>
      ${renderCalDetail(r)}
    </div>
    <div class="cal-values"><span class="cal-chev">▸</span></div>
  </div>`;
}

/** 事件展开区：自带详情 + 相关快讯（缓存内关键词匹配）+ 站内搜索兜底 */
function renderCalDetail(r) {
  const bits = [];
  if (r.content) bits.push(escapeHtml(r.content));
  const related = findRelatedNews(r.name);
  if (related.length) {
    bits.push(
      '<div class="cal-rel-head">相关快讯</div>' +
        related
          .map(
            (n) =>
              `<div class="cal-rel" data-url="${n.url || ""}"><span class="cal-rel-time">${fmtTime(n.showTime)}</span>${escapeHtml(n.title)}</div>`
          )
          .join("")
    );
  }
  const searchUrl = `https://so.eastmoney.com/news/s?keyword=${encodeURIComponent(r.name)}`;
  bits.push(`<a class="cal-search" data-url="${searchUrl}">搜索相关新闻 ↗</a>`);
  return `<div class="cal-summary">${bits.join("")}</div>`;
}

/** 从事件名提取匹配关键词：剥掉尾部行为短语取实体名，再从头衔后提取人名 */
const CAL_TAIL_RE =
  /(?:发表讲话|发表声明|讲话|答记者问|问答环节|主持一场活动[^，。]*|举行例行新闻发布会|举行新闻发布会|新闻发布会|发布会|公布利率决议|议息会议|利率决议|公布财报|财报|会议纪要|介绍当前外交政策相关议题)[，。]*$/;
const CAL_ROLE_RE = /(?:总统|主席|行长|总裁|管委|执委|首席经济学家|发言人|外长|财长)/;
function calKeywords(name) {
  const raw = String(name || "");
  const out = new Set();
  const entity = raw.replace(CAL_TAIL_RE, "").trim();
  if (entity.length >= 2 && entity !== raw) out.add(entity);
  const m = raw.match(CAL_ROLE_RE);
  if (m) {
    const person = raw.slice(raw.indexOf(m[0]) + m[0].length).replace(CAL_TAIL_RE, "").trim();
    if (person.length >= 2) out.add(person);
  }
  return [...out];
}

/** 在缓存的 7×24 快讯里按关键词找相关条目（最多 3 条） */
function findRelatedNews(name) {
  const kws = calKeywords(name);
  const news = snapshot?.news || [];
  if (!kws.length || !news.length) return [];
  return news.filter((n) => kws.some((k) => (n.title || "").includes(k))).slice(0, 3);
}

/** 日历数值：超大数缩写（亿/万），其余原样 */
function fmtCalValue(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (Math.abs(n) >= 1e6) return fmtAmount(n);
  return String(v);
}

/** 简单 HTML 转义（日历名称/摘要来自外部数据源） */
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// ---------- 快讯渲染 ----------
function renderNews() {
  if (activeTab !== "news") return;
  const items = (snapshot?.news || []).filter((n) => matchFilter(n));
  const count = items.length;
  // 检测到新增（仅当列表向上增长），弹出"新消息"胶囊
  if (count > newsCount && newsCount > 0) {
    const badges = $("#new-badge");
    badges.innerHTML = `<button>⬇ 有 ${count - newsCount} 条新消息</button>`;
    badges.classList.remove("hidden");
    badges.querySelector("button").onclick = () => {
      $("#panel-news").scrollTop = 0;
      badges.classList.add("hidden");
    };
  }
  newsCount = count;
  $("#news-list").innerHTML = items
    .map((n, idx) => renderNewsItem(n, idx === 0))
    .join("");
  $("#news-end").classList.toggle("hidden", items.length >= 100);
}

function renderNewsItem(n, isFirst) {
  const imp = n.color > 0;
  const stocks = (n.stocks || [])
    .map((s) => `<span class="stock-tag" data-secid="${s.secid}" data-name="${s.code}">${s.code}</span>`)
    .join("");
  const newCls = isFirst ? " new" : "";
  return `<div class="news-item${imp ? " imp" : ""}${newCls}" data-id="${n.id}">
    <div class="news-meta">
      <span>${fmtTime(n.showTime)}</span>
      ${imp ? '<span class="imp-tag">★ 重要</span>' : ""}
      <span>评论 ${n.comments || 0}</span>
    </div>
    <div class="news-title">${n.title}</div>
    ${n.summary ? `<div class="news-summary">${n.summary}</div>` : ""}
    ${stocks ? `<div class="news-stocks">${stocks}</div>` : ""}
    ${n.url ? `<div class="news-foot"><a class="news-link" data-url="${n.url}">阅读全文 ↗</a></div>` : ""}
  </div>`;
}

function matchFilter(item) {
  switch (filter) {
    case "important":
      return item.color > 0;
    case "a":
      return item.stocks.some((s) => ["0", "1", "116"].includes(s.secid.split(".")[0]));
    case "board":
      return item.stocks.some((s) => s.isBoard);
    default:
      return true;
  }
}

init().catch((e) => {
  const b = $("#error-banner");
  b.textContent = "初始化失败: " + e.message;
  b.classList.remove("hidden");
});
