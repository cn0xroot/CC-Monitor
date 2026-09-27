"use strict";
// 单个会话的操作流程图（类似 IDA 的函数流程图）：自上而下，每一轮用户提问是一张
// 标题卡，下面按时间顺序串起这一轮的操作卡；派生子 agent 的调用画成右侧虚线旁支。
// 卡片是普通 DOM（方便放多行文字、高亮命令），连线是底下一层 SVG，整层用一个
// transform 做平移缩放；左下角小地图、右下角缩放按钮。不依赖任何第三方库。
//
// 数据来自 /api/session-flow（webui/lib/sessionFlow.js 组装），这里只管布局和交互。
// 文案全部通过构造参数里的 text()/toolLabel() 取，模块本身不认识 i18n 字典。
(function () {
  const CARD_W = 300;
  const CARD_H = 88;
  const PROMPT_W = 380;
  const PROMPT_H = 104;
  const GAP_Y = 28;
  const TURN_GAP = 48;
  const BRANCH_X = CARD_W / 2 + 60; // 旁支卡片的左边缘（相对主干中线）
  const MIN_K = 0.15;
  const MAX_K = 2;
  const PAD = 60;

  const STATUS_ICON = { ok: "✓", warn: "!", fail: "✗", blocked: "⛔", running: "◌", background: "↻", observed: "◉", info: "•" };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function ms(ts) {
    const v = new Date(ts).getTime();
    return Number.isNaN(v) ? null : v;
  }
  function pad2(n) {
    return String(n).padStart(2, "0");
  }
  function hms(ts) {
    const v = ms(ts);
    if (v === null) return "";
    const d = new Date(v);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }
  // hook 写的时间戳只精确到秒（Python strftime），耗时天然是整秒——不显示小数/毫秒，
  // 免得 "1.0s""0ms" 看起来像是精确测量
  function dur(msv) {
    if (msv === null || msv === undefined) return "";
    if (msv < 1000) return "<1s";
    const s = msv / 1000;
    if (s < 60) return Math.round(s) + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m${pad2(Math.round(s % 60))}s`;
    return `${Math.floor(m / 60)}h${pad2(m % 60)}m`;
  }
  function opCategory(tool) {
    if (tool === "Read" || tool === "Glob" || tool === "Grep" || tool === "LS") return "read";
    if (tool === "Write" || tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") return "write";
    if (tool === "Bash") return "bash";
    if (tool === "Agent" || tool === "Task") return "agent";
    if (tool === "WebFetch" || tool === "WebSearch") return "web";
    return "other";
  }
  const CAT_GLYPH = { read: "R", write: "W", bash: "$", agent: "A", web: "@", other: "•", observe: "◉", lifecycle: "▸" };

  class SessionFlowGraph {
    constructor(viewport, opts) {
      this.vp = viewport;
      this.opts = opts; // {text(key, vars), toolLabel(node), onNodeClick(node, turn)}
      this.flow = null;
      this.view = { x: 0, y: 0, k: 1 };
      this.collapsedTurns = new Set();
      this.expandedGroups = new Set();
      this.highlight = new Set();
      this.selectedId = null;

      this.stage = document.createElement("div");
      this.stage.className = "flow-stage";
      this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      this.svg.setAttribute("class", "flow-edges");
      this.cards = document.createElement("div");
      this.cards.className = "flow-cards";
      this.stage.appendChild(this.svg);
      this.stage.appendChild(this.cards);
      this.vp.appendChild(this.stage);

      this.mini = document.createElement("canvas");
      this.mini.className = "flow-minimap";
      this.vp.appendChild(this.mini);

      const ctl = document.createElement("div");
      ctl.className = "flow-controls";
      ctl.innerHTML = `<button type="button" data-z="in" title="+">+</button><button type="button" data-z="out" title="-">−</button><button type="button" data-z="fit" title="fit">⛶</button>`;
      ctl.addEventListener("click", (ev) => {
        const b = ev.target.closest("button");
        if (!b) return;
        const r = this.vp.getBoundingClientRect();
        if (b.dataset.z === "in") this.zoomAt(r.width / 2, r.height / 2, 1.25);
        else if (b.dataset.z === "out") this.zoomAt(r.width / 2, r.height / 2, 0.8);
        else this.fit();
      });
      this.vp.appendChild(ctl);

      this._bindPointer();
      this._bindMinimap();
      window.addEventListener("resize", () => this._applyView());
    }

    // ---------- 数据 / 布局 ----------
    setData(flow, { keepView = false } = {}) {
      const first = !this.flow || this.flow.sessionId !== flow.sessionId;
      if (first) {
        this.collapsedTurns.clear();
        this.expandedGroups.clear();
        this.highlight.clear();
        this.selectedId = null;
      }
      this.flow = flow;
      this._layout();
      this._render();
      if (first || !keepView) this.scrollToEnd();
      else this._applyView();
    }

    _layout() {
      const nodes = []; // {key, kind, x, y, w, h, data, turn}
      const edges = []; // {from, to, branch, status}
      let y = 0;
      let branchBottom = -Infinity;
      let prevMain = null;
      const flow = this.flow;
      if (!flow) {
        this.layout = { nodes, edges, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } };
        return;
      }
      for (const turn of flow.turns) {
        const pk = "t" + turn.idx;
        const pnode = { key: pk, kind: "turn", x: -PROMPT_W / 2, y, w: PROMPT_W, h: PROMPT_H, data: turn, turn };
        nodes.push(pnode);
        if (prevMain) edges.push({ from: prevMain, to: pnode, branch: false, status: "turn" });
        prevMain = pnode;
        y += PROMPT_H + GAP_Y;
        if (this.collapsedTurns.has(turn.idx)) {
          y += TURN_GAP - GAP_Y;
          continue;
        }
        const list = [];
        for (const n of turn.nodes) {
          if (n.type === "group" && this.expandedGroups.has(n.id)) list.push(...n.items);
          else list.push(n);
        }
        for (const n of list) {
          if (n.branch) {
            // 旁支放在"下一格"的高度（跟随后的主干卡片并排），连线从上一张主干卡片
            // 右侧往右下方弯过去；连续派生多个子 agent 时在旁支列里往下叠
            const by = Math.max(y, branchBottom + GAP_Y / 2);
            const bnode = { key: "n" + n.id, kind: "op", x: BRANCH_X, y: by, w: CARD_W, h: CARD_H, data: n, turn };
            nodes.push(bnode);
            edges.push({ from: prevMain, to: bnode, branch: true, status: n.status });
            branchBottom = by + CARD_H;
            continue;
          }
          const node = { key: "n" + n.id, kind: "op", x: -CARD_W / 2, y, w: CARD_W, h: CARD_H, data: n, turn };
          nodes.push(node);
          edges.push({ from: prevMain, to: node, branch: false, status: n.status });
          prevMain = node;
          y += CARD_H + GAP_Y;
        }
        y = Math.max(y, branchBottom + GAP_Y) + TURN_GAP - GAP_Y;
      }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const n of nodes) {
        x0 = Math.min(x0, n.x);
        y0 = Math.min(y0, n.y);
        x1 = Math.max(x1, n.x + n.w);
        y1 = Math.max(y1, n.y + n.h);
      }
      if (!nodes.length) {
        x0 = 0; y0 = 0; x1 = 1; y1 = 1;
      }
      this.layout = { nodes, edges, bbox: { x0, y0, x1, y1 } };
      this.byKey = new Map(nodes.map((n) => [n.key, n]));
    }

    // ---------- 渲染 ----------
    _cardHtml(n) {
      const T = this.opts.text;
      if (n.kind === "turn") {
        const t = n.data;
        const collapsed = this.collapsedTurns.has(t.idx);
        const s = t.stats || {};
        const span = t.startTs && t.endTs && t.endTs !== t.startTs ? `${hms(t.startTs)} – ${hms(t.endTs)} · ${dur(ms(t.endTs) - ms(t.startTs))}` : hms(t.startTs);
        const chips = [
          ["ok", s.ok], ["warn", s.warn], ["fail", s.fail], ["blocked", s.blocked], ["running", s.running], ["background", s.background],
        ]
          .filter(([, v]) => v)
          .map(([k, v]) => `<span class="fc-chip fc-st-${k}" title="${esc(T("flow.status." + k))}">${STATUS_ICON[k]} ${v}</span>`)
          .join("");
        const title = t.prompt
          ? esc(t.prompt.text)
          : t.sessionStart && t.sessionStart.source
            ? esc(T("flow.turn.startSource", { s: t.sessionStart.source }))
            : esc(T("flow.turn.preamble"));
        const state = t.stopped || !t.prompt ? "" :`<span class="fc-live">${esc(T("flow.turn.unfinished"))}</span>`;
        return `
          <div class="fc-head"><span class="fc-turn-no">${esc(t.prompt ? T("flow.turn.label", { n: t.idx + (this.flow.turns[0].prompt ? 1 : 0) }) : T("flow.turn.start"))}</span>${state}
            <span class="fc-time">${esc(span)}</span>
            <button type="button" class="fc-toggle" data-toggle-turn="${t.idx}" title="${esc(T(collapsed ? "flow.expand" : "flow.collapse"))}">${collapsed ? "▸" : "▾"}</button></div>
          <div class="fc-prompt">${title}</div>
          <div class="fc-foot">${chips || `<span class="fc-dim">${esc(T("flow.turn.noOps"))}</span>`}${collapsed && s.total ? `<span class="fc-dim">· ${esc(T("flow.turn.hidden", { n: s.total }))}</span>` : ""}</div>`;
      }
      const d = n.data;
      const cat = d.type === "observe" ? "observe" : d.type === "lifecycle" ? "lifecycle" : opCategory(d.tool);
      const statusText = T("flow.status." + d.status);
      const time = hms(d.startTs) + (d.durationMs !== null && d.durationMs !== undefined ? ` · ${dur(d.durationMs)}` : "");
      const title = this.opts.toolLabel(d) + (d.type === "group" ? ` ×${d.count}` : "");
      const riskDot = d.risk && d.risk !== "-" ? `<span class="fc-risk fc-risk-${esc(d.risk)}" title="${esc(T("flow.risk", { r: T("risk." + d.risk) }))}"></span>` : "";
      const groupBtn = d.type === "group" ? `<button type="button" class="fc-toggle" data-toggle-group="${esc(d.id)}" title="${esc(T("flow.expand"))}">▾</button>` : "";
      const rule = d.matchedRule ? `<span class="fc-rule" title="${esc(d.matchedRule)}">${esc(d.matchedRule)}</span>` : "";
      return `
        <div class="fc-head"><span class="fc-status fc-st-${esc(d.status)}">${STATUS_ICON[d.status] || ""} ${esc(statusText)}</span>${riskDot}
          <span class="fc-time">${esc(time)}</span>${groupBtn}</div>
        <div class="fc-title"><span class="fc-icon fc-cat-${cat}">${CAT_GLYPH[cat]}</span><span class="fc-title-text">${esc(title)}</span>${rule}</div>
        <div class="fc-sub">${d.summaryHtml || ""}</div>`;
    }

    _render() {
      const { nodes, edges, bbox } = this.layout;
      const html = [];
      for (const n of nodes) {
        const d = n.data;
        const cls = ["fc", n.kind === "turn" ? "fc-turn" : "fc-node"];
        if (n.kind !== "turn") {
          cls.push("fc-st-" + d.status);
          if (d.risk) cls.push("fc-risk-" + d.risk);
          if (d.type === "group") cls.push("fc-group");
          if (d.branch) cls.push("fc-branch");
          if (this.highlight.has(d.id)) cls.push("fc-hl");
          if (this.selectedId === d.id) cls.push("fc-sel");
        }
        html.push(`<div class="${cls.join(" ")}" data-key="${n.key}" style="left:${n.x - bbox.x0 + PAD}px;top:${n.y - bbox.y0 + PAD}px;width:${n.w}px;height:${n.h}px">${this._cardHtml(n)}</div>`);
      }
      this.cards.innerHTML = html.join("");

      const W = bbox.x1 - bbox.x0 + PAD * 2;
      const H = bbox.y1 - bbox.y0 + PAD * 2;
      this.worldW = W;
      this.worldH = H;
      this.stage.style.width = W + "px";
      this.stage.style.height = H + "px";
      this.svg.setAttribute("width", W);
      this.svg.setAttribute("height", H);
      const ox = -bbox.x0 + PAD;
      const oy = -bbox.y0 + PAD;
      const paths = [];
      for (const e of edges) {
        const a = e.from;
        const b = e.to;
        let d;
        if (e.branch) {
          const sx = a.x + a.w + ox;
          const sy = a.y + a.h / 2 + oy;
          const tx = b.x + b.w / 2 + ox;
          const ty = b.y + oy;
          d = `M${sx},${sy} C${sx + 60},${sy} ${tx},${ty - 50} ${tx},${ty}`;
        } else {
          const sx = a.x + a.w / 2 + ox;
          const sy = a.y + a.h + oy;
          const tx = b.x + b.w / 2 + ox;
          const ty = b.y + oy;
          const my = (sy + ty) / 2;
          d = `M${sx},${sy} C${sx},${my} ${tx},${my} ${tx},${ty}`;
        }
        const bad = e.status === "fail" || e.status === "blocked";
        const cls = ["fe", e.branch ? "fe-branch" : "", bad ? "fe-bad" : "", e.status === "turn" ? "fe-turn" : ""].filter(Boolean).join(" ");
        paths.push(`<path class="${cls}" d="${d}" marker-end="url(#fe-arrow${bad ? "-bad" : ""})"/>`);
      }
      this.svg.innerHTML = `<defs>
          <marker id="fe-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" class="fe-head"/></marker>
          <marker id="fe-arrow-bad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" class="fe-head fe-head-bad"/></marker>
        </defs>${paths.join("")}`;
      this._drawMinimap();
    }

    // ---------- 视图变换 ----------
    _applyView() {
      const { x, y, k } = this.view;
      this.stage.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
      this._drawMinimap();
    }

    zoomAt(sx, sy, factor) {
      const k = Math.min(MAX_K, Math.max(MIN_K, this.view.k * factor));
      const f = k / this.view.k;
      this.view.x = sx - (sx - this.view.x) * f;
      this.view.y = sy - (sy - this.view.y) * f;
      this.view.k = k;
      this._applyView();
    }

    fit() {
      const r = this.vp.getBoundingClientRect();
      if (!r.width || !this.worldW) return;
      const k = Math.min(MAX_K, Math.max(MIN_K, Math.min(r.width / this.worldW, r.height / this.worldH)));
      this.view = { k, x: (r.width - this.worldW * k) / 2, y: (r.height - this.worldH * k) / 2 };
      this._applyView();
    }

    // 把世界坐标 (wx, wy)（stage 内像素）放到视口里 (ax, ay) 比例的位置
    _centerOn(wx, wy, ax = 0.5, ay = 0.5) {
      const r = this.vp.getBoundingClientRect();
      this.view.x = r.width * ax - wx * this.view.k;
      this.view.y = r.height * ay - wy * this.view.k;
      this._applyView();
    }

    // 最新的操作在最下面：打开时默认看最后一轮
    scrollToEnd() {
      if (!this.layout || !this.layout.nodes.length) return this._applyView();
      this.view.k = 1;
      const { bbox, nodes } = this.layout;
      const lastTurn = [...nodes].reverse().find((n) => n.kind === "turn");
      const target = lastTurn || nodes[nodes.length - 1];
      this._centerOn(0 - bbox.x0 + PAD, target.y - bbox.y0 + PAD, 0.5, 0.12);
    }

    // 时间线上点了某个时间桶：高亮这段时间里的操作并定位到第一个
    focusRange(startMs, endMs) {
      if (!this.flow) return;
      this.highlight.clear();
      let firstGroupToOpen = null;
      for (const t of this.flow.turns) {
        for (const n of t.nodes) {
          const s = ms(n.startTs);
          if (s === null || s < startMs || s >= endMs) continue;
          this.highlight.add(n.id);
          if (n.type === "group") for (const it of n.items) this.highlight.add(it.id);
          if (this.collapsedTurns.has(t.idx)) this.collapsedTurns.delete(t.idx);
          if (!firstGroupToOpen && n.type === "group") firstGroupToOpen = n.id;
        }
      }
      this._layout();
      this._render();
      const hit = this.layout.nodes.find((n) => n.kind !== "turn" && this.highlight.has(n.data.id));
      if (hit) {
        const { bbox } = this.layout;
        this.view.k = 1;
        this._centerOn(0 - bbox.x0 + PAD, hit.y - bbox.y0 + PAD, 0.5, 0.25);
      }
      return !!hit;
    }

    select(id) {
      this.selectedId = id;
      this.cards.querySelectorAll(".fc-sel").forEach((el) => el.classList.remove("fc-sel"));
      const n = this.layout.nodes.find((x) => x.kind !== "turn" && x.data.id === id);
      if (n) {
        const el = this.cards.querySelector(`[data-key="${n.key}"]`);
        if (el) el.classList.add("fc-sel");
      }
    }

    // ---------- 交互 ----------
    _bindPointer() {
      let drag = null;
      this.vp.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0 || ev.target.closest(".flow-controls, .flow-minimap")) return;
        drag = { sx: ev.clientX, sy: ev.clientY, vx: this.view.x, vy: this.view.y, moved: false, target: ev.target };
      });
      window.addEventListener("pointermove", (ev) => {
        if (!drag) return;
        const dx = ev.clientX - drag.sx;
        const dy = ev.clientY - drag.sy;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
        if (!drag.moved) this.vp.classList.add("flow-dragging");
        drag.moved = true;
        this.view.x = drag.vx + dx;
        this.view.y = drag.vy + dy;
        this._applyView();
      });
      window.addEventListener("pointerup", () => {
        if (!drag) return;
        const d = drag;
        drag = null;
        this.vp.classList.remove("flow-dragging");
        if (!d.moved) this._click(d.target);
      });
      // 普通滚轮 = 平移（跟网页滚动手感一致），按住 Ctrl/⌘ 滚轮 = 以鼠标为中心缩放
      this.vp.addEventListener(
        "wheel",
        (ev) => {
          ev.preventDefault();
          if (ev.ctrlKey || ev.metaKey) {
            const r = this.vp.getBoundingClientRect();
            this.zoomAt(ev.clientX - r.left, ev.clientY - r.top, Math.exp(-ev.deltaY * 0.0015));
          } else {
            this.view.x -= ev.deltaX;
            this.view.y -= ev.deltaY;
            this._applyView();
          }
        },
        { passive: false }
      );
    }

    _click(target) {
      const tt = target.closest("[data-toggle-turn]");
      if (tt) {
        const idx = Number(tt.dataset.toggleTurn);
        if (this.collapsedTurns.has(idx)) this.collapsedTurns.delete(idx);
        else this.collapsedTurns.add(idx);
        this._relayoutKeeping(`t${idx}`);
        return;
      }
      const tg = target.closest("[data-toggle-group]");
      if (tg) {
        const id = tg.dataset.toggleGroup;
        if (this.expandedGroups.has(id)) this.expandedGroups.delete(id);
        else this.expandedGroups.add(id);
        this._relayoutKeeping("n" + id, id);
        return;
      }
      const card = target.closest(".fc");
      if (!card) return;
      const n = this.byKey.get(card.dataset.key);
      if (!n) return;
      if (n.kind === "turn") {
        this.opts.onNodeClick && this.opts.onNodeClick(null, n.data);
        return;
      }
      this.select(n.data.id);
      this.opts.onNodeClick && this.opts.onNodeClick(n.data, n.turn);
    }

    // 折叠/展开后重新布局，但让被点的那张卡在屏幕上待在原位，不要整张图跳走。
    // 展开的分组卡本身会被它的明细替换掉，这时锚到第一条明细上。
    _relayoutKeeping(key, groupId) {
      const before = this.byKey.get(key);
      const bx = before ? before.x - this.layout.bbox.x0 : 0;
      const by = before ? before.y - this.layout.bbox.y0 : 0;
      this._layout();
      this._render();
      let after = this.byKey.get(key);
      if (!after && groupId) {
        const g = this.flow.turns.flatMap((t) => t.nodes).find((n) => n.id === groupId);
        if (g && g.items.length) after = this.byKey.get("n" + g.items[0].id);
      }
      if (before && after) {
        this.view.x += (bx - (after.x - this.layout.bbox.x0)) * this.view.k;
        this.view.y += (by - (after.y - this.layout.bbox.y0)) * this.view.k;
      }
      this._applyView();
    }

    // ---------- 小地图 ----------
    _bindMinimap() {
      let down = false;
      const go = (ev) => {
        const r = this.mini.getBoundingClientRect();
        const m = this._miniMetrics;
        if (!m) return;
        const wx = (ev.clientX - r.left - m.ox) / m.s;
        const wy = (ev.clientY - r.top - m.oy) / m.s;
        this._centerOn(wx, wy);
      };
      this.mini.addEventListener("pointerdown", (ev) => {
        down = true;
        go(ev);
        ev.stopPropagation();
      });
      window.addEventListener("pointermove", (ev) => down && go(ev));
      window.addEventListener("pointerup", () => (down = false));
    }

    _drawMinimap() {
      const c = this.mini;
      const cssW = 170;
      const cssH = 150;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (c.width !== cssW * dpr) {
        c.width = cssW * dpr;
        c.height = cssH * dpr;
      }
      const ctx = c.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      if (!this.layout || !this.worldW) return;
      const s = Math.min((cssW - 10) / this.worldW, (cssH - 10) / this.worldH);
      const ox = (cssW - this.worldW * s) / 2;
      const oy = (cssH - this.worldH * s) / 2;
      this._miniMetrics = { s, ox, oy };
      const cs = getComputedStyle(document.documentElement);
      const col = (v, f) => cs.getPropertyValue(v).trim() || f;
      const colors = {
        ok: col("--green", "#22c55e"),
        warn: col("--yellow", "#eab308"),
        fail: col("--red", "#ef4444"),
        blocked: col("--red", "#ef4444"),
        running: col("--accent", "#6366f1"),
        background: col("--cyan", "#06b6d4"),
        turn: col("--accent", "#8b5cf6"),
        other: col("--text-dim", "#7a8094"),
      };
      const { bbox } = this.layout;
      for (const n of this.layout.nodes) {
        const st = n.kind === "turn" ? "turn" : n.data.status;
        ctx.fillStyle = colors[st] || colors.other;
        ctx.globalAlpha = n.kind === "turn" ? 0.9 : 0.7;
        ctx.fillRect(ox + (n.x - bbox.x0 + PAD) * s, oy + (n.y - bbox.y0 + PAD) * s, Math.max(1.5, n.w * s), Math.max(1.5, n.h * s));
      }
      ctx.globalAlpha = 1;
      const r = this.vp.getBoundingClientRect();
      const vx = -this.view.x / this.view.k;
      const vy = -this.view.y / this.view.k;
      ctx.strokeStyle = col("--text", "#e6e8ee");
      ctx.lineWidth = 1;
      ctx.strokeRect(ox + vx * s, oy + vy * s, (r.width / this.view.k) * s, (r.height / this.view.k) * s);
    }
  }

  window.SessionFlowGraph = SessionFlowGraph;
})();
