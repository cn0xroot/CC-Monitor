"use strict";
// 多 session 事件时间线：每个 session 一条泳道，横轴是共享的时间窗口，纵轴按最近
// 活跃排列会话。每个时间桶画一根从底部往上长的柱子，颜色按桶内"最差风险"上色
// （桶里只要有一条 high 就整根染红，不管另外 199 条是不是 info——风险不能被平均掉），
// 柱子高度按这个桶的事件数相对"这条泳道自己最忙的桶"归一化，让安静的会话和吵闹的
// 会话在同一张图里都能看出"忙不忙"的相对起伏，而不是安静的那条永远看起来是空的。
// decision=blocked 的桶额外画一个不随事件数变化的高亮描边——不能让"1 个被拦截的
// 操作"淹没在"这个桶还有很多别的事件"里。
//
// 画布本身不认 CSS 变量（fillStyle 不会展开 var(--x)，这个项目在别处已经踩过同样的
// 坑，见 app.js 的 vitalColor() 那段注释）——颜色每次 render() 都从
// getComputedStyle(document.documentElement) 现读，这样切主题之后下一次 render()
// 自动跟着换，不用额外监听主题切换事件。跟 network-map.js 一样，是个不依赖任何
// 第三方库、自己管生命周期的 vanilla 模块，靠 setData()/render() 跟外面通信。
(function () {
  const LANE_HEIGHT = 30;
  const LABEL_WIDTH = 200;
  const AXIS_HEIGHT = 22;
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  // 刻度间隔按窗口长度挑，保证一屏大约 6~12 个刻度
  function tickStepFor(rangeMs) {
    if (rangeMs <= HOUR) return 10 * MIN;
    if (rangeMs <= 6 * HOUR) return HOUR;
    if (rangeMs <= DAY) return 3 * HOUR;
    return DAY;
  }

  // 刻度按本地时间对齐（整点/整 3 小时/零点），不是按 epoch 取整——否则非整点
  // 时区（+05:30 之类）的刻度会落在奇怪的分钟上。
  function firstTick(startMs, stepMs) {
    const d = new Date(startMs);
    if (stepMs >= DAY) {
      d.setHours(0, 0, 0, 0);
    } else if (stepMs >= HOUR) {
      d.setMinutes(0, 0, 0);
      d.setHours(d.getHours() - (d.getHours() % (stepMs / HOUR)));
    } else {
      d.setSeconds(0, 0);
      d.setMinutes(d.getMinutes() - (d.getMinutes() % (stepMs / MIN)));
    }
    let t = d.getTime();
    while (t < startMs) t += stepMs;
    return t;
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function tickLabel(ms, stepMs) {
    const d = new Date(ms);
    if (stepMs >= DAY) return `${d.getMonth() + 1}/${d.getDate()}`;
    const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    // 跨零点的那个刻度带上日期，不然 24h 窗口里两个 "03:00" 分不清是哪天
    return d.getHours() === 0 && d.getMinutes() === 0 ? `${d.getMonth() + 1}/${d.getDate()}` : hm;
  }

  function readColor(varName, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    return v || fallback;
  }

  function riskColors() {
    return {
      high: readColor("--red", "#ef4444"),
      medium: readColor("--yellow", "#eab308"),
      low: readColor("--green", "#22c55e"),
      info: readColor("--cyan", "#06b6d4"),
      blocked: readColor("--red", "#ef4444"),
      dim: readColor("--text-dim", "#7a8094"),
      border: readColor("--border", "#2a3040"),
      text: readColor("--text", "#e6e8ee"),
    };
  }

  function worstRisk(b) {
    if (b.nHigh > 0) return "high";
    if (b.nMedium > 0) return "medium";
    if (b.nLow > 0) return "low";
    return "info";
  }

  function folderNameLocal(cwd) {
    if (!cwd) return "";
    const parts = String(cwd).replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || cwd;
  }

  function truncateLocal(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
    return t + "…";
  }

  function escapeHtmlLocal(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  class SessionTimeline {
    constructor(canvas, tooltipEl) {
      this.canvas = canvas;
      this.tooltipEl = tooltipEl;
      this.ctx = canvas.getContext("2d");
      this.data = null; // {rangeMinutes, bucketMs, now, lanes}
      this.onLaneClick = null; // (sessionId) => void，由 app.js 挂上去跳到 Logs 页
      // (lane, bucket|null, bucketMs) => html；由 app.js 提供带翻译的版本，这里只留个兜底
      this.tooltipHtml = null;
      this._resize();
      window.addEventListener("resize", () => this._resize());
      canvas.addEventListener("mousemove", (ev) => this._onMouseMove(ev));
      canvas.addEventListener("mouseleave", () => this._hideTooltip());
      canvas.addEventListener("click", (ev) => this._onClick(ev));
    }

    setData(data) {
      this.data = data;
      this._resize();
    }

    _resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const laneCount = this.data ? this.data.lanes.length : 0;
      const rect = this.canvas.parentElement.getBoundingClientRect();
      // 页面切走时（.view 是 display:none）量出来宽度是 0——这时候要是照样改 canvas.width，
      // 位图会缩成 1px 宽再被 CSS 拉伸，切回来之前看到的就是一片只有横线的空图。
      // 隐藏时直接跳过，等下一次可见时的 setData()/resize 再量。
      if (rect.width === 0) return;
      const cssHeight = AXIS_HEIGHT + Math.max(1, laneCount) * LANE_HEIGHT;
      this.canvas.style.height = cssHeight + "px";
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(cssHeight * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      this.dpr = dpr;
      this.render();
    }

    // 精确算法跟 render() 里把桶摆到 x 坐标上的公式必须完全对称，否则会出现
    // "鼠标指哪儿、提示框却说另一个时间"的错位——两处都以"离现在几个桶"为准，
    // 不用绝对索引，这样窗口切换（1h/6h/24h/7d）时公式不用跟着改。
    _hitTest(ev) {
      const box = this.canvas.getBoundingClientRect();
      const x = ev.clientX - box.left;
      const y = ev.clientY - box.top;
      const laneIndex = Math.floor((y - AXIS_HEIGHT) / LANE_HEIGHT);
      if (!this.data || laneIndex < 0 || laneIndex >= this.data.lanes.length) return null;
      const lane = this.data.lanes[laneIndex];
      if (x < LABEL_WIDTH) return { lane, bucket: null };
      const { bucketMs, rangeMinutes, now } = this.data;
      const bucketCount = Math.max(1, Math.round((rangeMinutes * 60 * 1000) / bucketMs));
      const plotW = Math.max(1, box.width - LABEL_WIDTH);
      const bucketW = plotW / bucketCount;
      const slot = Math.floor((x - LABEL_WIDTH) / bucketW);
      const bucketIndexFromNow = bucketCount - 1 - slot;
      const alignedNow = Math.floor(now / bucketMs) * bucketMs;
      const startMs = alignedNow - bucketIndexFromNow * bucketMs;
      const bucket = lane.buckets.find((b) => b.startMs === startMs) || null;
      return { lane, bucket };
    }

    _onMouseMove(ev) {
      const hit = this._hitTest(ev);
      if (!hit) {
        this._hideTooltip();
        return;
      }
      this._showTooltip(ev, hit);
    }

    _onClick(ev) {
      const hit = this._hitTest(ev);
      if (!hit || !this.onLaneClick) return;
      const range = hit.bucket ? { startMs: hit.bucket.startMs, endMs: hit.bucket.startMs + this.data.bucketMs } : null;
      this.onLaneClick(hit.lane.sessionId, range);
    }

    _showTooltip(ev, hit) {
      if (!this.tooltipEl) return;
      const { lane, bucket } = hit;
      if (this.tooltipHtml) {
        this.tooltipEl.innerHTML = this.tooltipHtml(lane, bucket, this.data.bucketMs);
      } else {
        const parts = [`<div class="tt-title">${escapeHtmlLocal(folderNameLocal(lane.cwd) || lane.sessionId)}</div>`];
        if (bucket) parts.push(`<div>${bucket.n} events${bucket.nBlocked ? `, ${bucket.nBlocked} blocked` : ""}</div>`);
        else parts.push(`<div>${lane.eventCount} events total</div>`);
        this.tooltipEl.innerHTML = parts.join("");
      }
      this.tooltipEl.hidden = false;
      const left = Math.min(ev.clientX + 14, window.innerWidth - 260);
      this.tooltipEl.style.left = Math.max(4, left) + "px";
      this.tooltipEl.style.top = ev.clientY + 14 + "px";
    }

    _hideTooltip() {
      if (this.tooltipEl) this.tooltipEl.hidden = true;
    }

    render() {
      const ctx = this.ctx;
      const dpr = this.dpr || 1;
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cssW = this.canvas.width / dpr;
      const cssH = this.canvas.height / dpr;
      ctx.clearRect(0, 0, cssW, cssH);
      if (!this.data || !this.data.lanes.length) {
        ctx.restore();
        return;
      }

      const colors = riskColors();
      const { lanes, bucketMs, rangeMinutes, now } = this.data;
      const bucketCount = Math.max(1, Math.round((rangeMinutes * 60 * 1000) / bucketMs));
      const plotX0 = LABEL_WIDTH;
      const plotW = Math.max(1, cssW - LABEL_WIDTH);
      const bucketW = plotW / bucketCount;
      const alignedNow = Math.floor(now / bucketMs) * bucketMs;

      ctx.font = "11px -apple-system, system-ui, sans-serif";
      ctx.textBaseline = "middle";

      // 时间轴：顶部刻度文字 + 贯穿所有泳道的淡竖线。时间 → x 的映射跟下面画柱子
      // 用的"离现在几个桶"公式是同一个坐标系（窗口右端 = 当前桶的结束时刻）。
      const rangeMs = bucketCount * bucketMs;
      const windowStart = alignedNow + bucketMs - rangeMs;
      const xOf = (ms) => plotX0 + ((ms - windowStart) / rangeMs) * plotW;
      const stepMs = tickStepFor(rangeMs);
      ctx.fillStyle = colors.dim;
      ctx.textAlign = "center";
      for (let tMs = firstTick(windowStart, stepMs); tMs <= windowStart + rangeMs; tMs += stepMs) {
        const x = Math.round(xOf(tMs)) + 0.5;
        ctx.strokeStyle = colors.border;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.moveTo(x, AXIS_HEIGHT - 4);
        ctx.lineTo(x, cssH);
        ctx.stroke();
        ctx.globalAlpha = 1;
        const label = tickLabel(tMs, stepMs);
        const halfW = ctx.measureText(label).width / 2;
        if (x - halfW >= plotX0 && x + halfW <= cssW) ctx.fillText(label, x, AXIS_HEIGHT / 2);
      }
      ctx.textAlign = "left";
      ctx.strokeStyle = colors.border;
      ctx.beginPath();
      ctx.moveTo(0, AXIS_HEIGHT - 0.5);
      ctx.lineTo(cssW, AXIS_HEIGHT - 0.5);
      ctx.moveTo(plotX0 - 0.5, 0);
      ctx.lineTo(plotX0 - 0.5, cssH);
      ctx.stroke();

      lanes.forEach((lane, laneIndex) => {
        const y0 = AXIS_HEIGHT + laneIndex * LANE_HEIGHT;

        // 🛑/⚠ 跟 app.js 的 sessionLabel()/#log-session-filter 用的是同一套视觉约定：
        // 有真的被拦截过的操作用 🛑，只是疑似绕过 hook（没有拦截，但也不正常）用 ⚠。
        const flag = lane.blockedCount > 0 ? " \u{1F6D1}" : lane.bypassCount > 0 ? " ⚠" : "";
        const folder = folderNameLocal(lane.cwd);
        const idPart = lane.sessionId.slice(0, 8);
        const main = truncateLocal(ctx, (folder || idPart) + flag, LABEL_WIDTH - 80);
        ctx.fillStyle = colors.text;
        ctx.fillText(main, 6, y0 + LANE_HEIGHT / 2);
        if (folder) {
          ctx.fillStyle = colors.dim;
          ctx.fillText(" · " + idPart, 6 + ctx.measureText(main).width, y0 + LANE_HEIGHT / 2);
        }

        ctx.strokeStyle = colors.border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y0 + LANE_HEIGHT - 0.5);
        ctx.lineTo(cssW, y0 + LANE_HEIGHT - 0.5);
        ctx.stroke();

        const laneMaxN = lane.buckets.reduce((m, b) => Math.max(m, b.n), 1);
        for (const b of lane.buckets) {
          const bucketIndexFromNow = Math.round((alignedNow - b.startMs) / bucketMs);
          if (bucketIndexFromNow < 0 || bucketIndexFromNow >= bucketCount) continue; // 窗口外的桶（理论上不该有，防御性跳过）
          const bx = plotX0 + (bucketCount - 1 - bucketIndexFromNow) * bucketW;
          const heightFrac = Math.max(0.14, Math.min(1, b.n / laneMaxN));
          const barH = Math.max(3, heightFrac * (LANE_HEIGHT - 6));
          ctx.fillStyle = colors[worstRisk(b)];
          ctx.fillRect(bx + 1, y0 + LANE_HEIGHT - 3 - barH, Math.max(1, bucketW - 2), barH);
          if (b.nBlocked > 0) {
            ctx.strokeStyle = colors.blocked;
            ctx.lineWidth = 1.5;
            ctx.strokeRect(bx + 0.5, y0 + 1.5, Math.max(1, bucketW - 1), LANE_HEIGHT - 3);
          }
        }
      });
      ctx.restore();
    }
  }

  window.SessionTimeline = SessionTimeline;
})();
