// 前端逻辑：行情 Tab + 快讯 Tab
import {
  fmtPrice, fmtPct, fmtAmount,
  debounce, nowClock, fmtTime,
} from "./lib/utils.js";
import { searchStocks, fetchTrend } from "./lib/sources/em-quotes.js";

// ---------- 全局状态 ----------
let snapshot = null; // { indexes, watch, sectors, breadth, news, ... }
let activeTab = "quotes";
let filter = "all";
let newsCount = 0; // 当前渲染快讯总数（用于判断新条目标记）

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
  startClock();
}

async function refreshNow() {
  const res = await chrome.runtime.sendMessage({ type: "REFRESH_NOW" });
  if (res?.ok) {
    snapshot = res.snapshot;
    render();
  }
}

// ---------- UI 事件绑定 ----------
function bindUI() {
  // Tab 切换
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeTab = btn.dataset.tab;
      $("#panel-quotes").classList.toggle("hidden", activeTab !== "quotes");
      $("#panel-news").classList.toggle("hidden", activeTab !== "news");
      render();
    });
  });

  // 刷新间隔
  $("#refresh-select").addEventListener("change", async (e) => {
    const ms = Number(e.target.value);
    await chrome.runtime.sendMessage({ type: "SET_SETTINGS", settings: { refreshMs: ms, newsMs: ms } });
  });

  // 板块切换
  document.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
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
  // 点击自选行 -> 分时
  $("#watch-list").addEventListener("click", (e) => {
    const del = e.target.closest(".q-del");
    if (del) { removeWatch(del.dataset.secid); return; }
    const row = e.target.closest(".quote-row");
    if (row) openTrend(row.dataset.secid, row.dataset.name);
  });
  // 快讯关联股票标签 -> 跳到行情并加入自选
  $("#news-list").addEventListener("click", (e) => {
    const tag = e.target.closest(".stock-tag");
    if (tag) addFromNews(tag.dataset.secid, tag.dataset.name);
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

// ---------- 分时 ----------
async function openTrend(secid, name) {
  $("#trend-name").textContent = name;
  $("#trend-drawer").classList.remove("hidden");
  try {
    const data = await fetchTrend(secid);
    drawTrend(data);
  } catch (err) {
    $("#trend-canvas").getContext("2d").clearRect(0, 0, 340, 150);
  }
}
function closeTrend() { $("#trend-drawer").classList.add("hidden"); }

function drawTrend(data) {
  const canvas = $("#trend-canvas");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const pts = data.points;
  if (!pts.length) return;
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

// ---------- 渲染 ----------
function render() {
  renderQuotes();
  renderNews();
  renderStatus();
}

function renderStatus() {
  $("#clock").textContent = nowClock();
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
  renderWatch();
  renderSectors();
}

function renderIndexes() {
  const rows = snapshot?.indexes || [];
  $("#index-row").innerHTML = rows
    .map((i) => {
      const cls = i.pct > 0 ? "up" : i.pct < 0 ? "down" : "flat";
      return `<div class="index-card" data-secid="${i.secid}" data-name="${i.name}">
        <div class="index-name">${i.name}</div>
        <div class="index-price ${cls}">${fmtPrice(i.price)}</div>
        <div class="index-pct ${cls}">${fmtPct(i.pct)}</div>
      </div>`;
    })
    .join("");
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
  // 榜单方向由快照的 sectors 决定；此处简化：SW 固定取涨幅榜
  const rows = snapshot?.sectors || [];
  $("#sector-list").innerHTML = rows
    .map((s) => {
      const cls = s.pct > 0 ? "up" : s.pct < 0 ? "down" : "flat";
      return `<div class="sector-row">
        <div>
          <div class="sector-name">${s.name}</div>
          <div class="sector-leader">领涨: ${s.leader || "-"}</div>
        </div>
        <div class="sector-pct ${cls}">${fmtPct(s.pct)}</div>
      </div>`;
    })
    .join("");
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

// ---------- 时钟 ----------
function startClock() {
  setInterval(() => { $("#clock").textContent = nowClock(); }, 1000);
}

init().catch((e) => {
  const b = $("#error-banner");
  b.textContent = "初始化失败: " + e.message;
  b.classList.remove("hidden");
});
