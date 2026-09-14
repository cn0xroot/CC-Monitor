"use strict";
// 世界地图流量可视化——参考 BeeEye 项目的 WorldMap.jsx 做法（同一个作者的项目之间互相
// 借用，见 https://github.com/cn0xroot/BeeEye/blob/main/BeeEye-web/src/components/WorldMap.jsx）：
// 不依赖任何地图瓦片服务/第三方地图 API（避免额外的网络依赖和数据泄露面），纯 WebGL2
// 自己画：等距柱状投影（lon/lat 直接线性映射到 clip space），海岸线用本地打包的低精度
// world.geo.json 画成线段，每个有流量的目的地画一个按流量大小/新鲜程度决定亮度的
// 发光点，加一条从"本机（示意位置）"到目的地、带跑动光点的弧线，方向跟着这条连接
// 上传/下载哪个字节数更多走（上传为主往外跑，下载为主往回跑，不知道方向的默认往外）。
// WebGL2 不可用时（老浏览器、这台机器本身没有 GPU 加速、或者某些沙箱/远程会话）
// 退化成 Canvas 2D 画同一套内容——地图不会因为拿不到 WebGL2 就整个消失。
(function () {
  function project(lat, lon) {
    return [lon / 180, lat / 90];
  }

  // "本机" 在这张图上没有真实地理位置可言（这是运行 Claude Code 的这台机器，不是
  // 网络流量真正经过的公网出口，我们也没有另外发请求去问"我的公网 IP 在哪"——那样
  // 等于把用户的真实位置又发给了第三方，违背这整个项目"不额外发请求给第三方"的
  // 原则）。固定钉在 (0, 0)（南大西洋几内亚湾外海，俗称"Null Island"）——choose 这个
  // 点纯粹是因为它明显不可能是任何人的真实位置，不会被误认成"这就是你的位置"。
  const ANCHOR = { lat: 0, lon: 0 };
  const ARC_DURATION = 2.2; // 秒，光点跑完一趟弧线的时间，超过这个时间的弧线整条消失
  const MAX_ARCS = 60; // 弧线数量上限，避免开着页面挂一整天堆积成一团乱线

  // arc2d：从 a 到 b 的二次贝塞尔曲线，往两点连线中点偏纬度方向鼓一点（有大圆航线的
  // 弧度感），每个顶点带一个 0..1 的 t（沿弧线的位置），返回展平的
  // [lat,lon,t, lat,lon,t, ...]，跟 BeeEye 的同名函数完全一致。
  function arc2d(aLat, aLon, bLat, bLon, steps = 40) {
    const out = [];
    const midLat = (aLat + bLat) / 2 + Math.min(40, Math.abs(aLon - bLon) * 0.25);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const lat = (1 - t) * (1 - t) * aLat + 2 * (1 - t) * t * midLat + t * t * bLat;
      const lon = (1 - t) * (1 - t) * aLon + 2 * (1 - t) * t * ((aLon + bLon) / 2) + t * t * bLon;
      out.push(lat, lon, t);
    }
    return out;
  }

  // 给定 arc2d() 产出的 [lat,lon,t, ...] 数据和一个 0..1 的头部进度，插值出头部当前
  // 应该在的 (lat, lon)——画头部光点用，不是给 GPU 的，纯 JS 算。
  function arcHeadLatLon(data, head) {
    const n = data.length / 3;
    const clamped = Math.max(0, Math.min(1, head));
    const idx = clamped * (n - 1);
    const i0 = Math.floor(idx);
    const i1 = Math.min(n - 1, i0 + 1);
    const frac = idx - i0;
    const lat = data[i0 * 3] + (data[i1 * 3] - data[i0 * 3]) * frac;
    const lon = data[i0 * 3 + 1] + (data[i1 * 3 + 1] - data[i0 * 3 + 1]) * frac;
    return [lat, lon];
  }

  // 等距柱状投影天生是 2:1（经度跨 360°、纬度跨 180°），画布不一定正好是 2:1，
  // 所以要在 clip space 里按画布实际宽高比再缩放一次，让经纬度的像素密度一致，
  // 多出来的部分用留白（letterbox/pillarbox）而不是拉伸填满。
  const VERT_POINT = `#version 300 es
layout(location=0) in vec2 a_ll;
layout(location=1) in float a_mag;
uniform float u_size;
uniform vec2 u_scale;
out float v_mag;
void main() {
  vec2 p = vec2(a_ll.y / 180.0, a_ll.x / 90.0) * u_scale;
  gl_Position = vec4(p, 0.0, 1.0);
  gl_PointSize = u_size * (0.6 + a_mag * 1.8);
  v_mag = a_mag;
}`;

  const FRAG_POINT = `#version 300 es
precision highp float;
in float v_mag;
uniform vec3 u_col;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d) * 2.0;
  float core = smoothstep(1.0, 0.0, r);
  float glow = pow(core, 2.2);
  float a = glow * (0.35 + v_mag * 0.65);
  outColor = vec4(u_col * (0.6 + glow * 0.8), a);
}`;

  const VERT_LINE = `#version 300 es
layout(location=0) in vec2 a_ll;
uniform vec2 u_scale;
void main() {
  vec2 p = vec2(a_ll.y / 180.0, a_ll.x / 90.0) * u_scale;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

  const FRAG_LINE = `#version 300 es
precision highp float;
uniform vec3 u_col;
uniform float u_alpha;
out vec4 outColor;
void main() { outColor = vec4(u_col, u_alpha); }`;

  // 弧线专用的一对着色器——跟上面 VERT_LINE/FRAG_LINE 的区别是每个顶点带一个沿弧线
  // 位置的 t，片元着色器里拿 t 跟当前动画头位置 u_head 比距离，离得近就亮，实现
  // "光点沿弧线跑"的效果；本体弧线本身也画一条很淡的底线，不是光点跑过去之后
  // 什么都不剩。
  const VERT_ARC = `#version 300 es
layout(location=0) in vec2 a_ll;
layout(location=1) in float a_t;
uniform vec2 u_scale;
out float v_t;
void main() {
  vec2 p = vec2(a_ll.y / 180.0, a_ll.x / 90.0) * u_scale;
  gl_Position = vec4(p, 0.0, 1.0);
  v_t = a_t;
}`;

  const FRAG_ARC = `#version 300 es
precision highp float;
in float v_t;
uniform float u_head;
uniform vec3 u_col;
out vec4 outColor;
void main() {
  float base = 0.16;
  float d = abs(v_t - u_head);
  float pulse = smoothstep(0.12, 0.0, d);
  float a = base + pulse * 0.9;
  outColor = vec4(u_col, a * (0.4 + v_t * 0.4));
}`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(log || "shader compile failed");
    }
    return s;
  }
  function makeProgram(gl, vsSrc, fsSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error(log || "program link failed");
    }
    return p;
  }

  // buildLandSegments：把 GeoJSON 多边形的每条边拆成 [lat,lon, lat,lon] 线段对，
  // 用 GL_LINES（或 2D 路径下逐段 moveTo/lineTo）画出海岸线轮廓（不是填色的实心大陆）。
  function buildLandSegments(geojson) {
    const out = [];
    const addRing = (ring) => {
      for (let i = 0; i < ring.length; i++) {
        const [lon0, lat0] = ring[i];
        const [lon1, lat1] = ring[(i + 1) % ring.length];
        out.push(lat0, lon0, lat1, lon1);
      }
    };
    for (const f of geojson.features || []) {
      const g = f.geometry;
      if (!g) continue;
      if (g.type === "Polygon") {
        for (const ring of g.coordinates) addRing(ring);
      } else if (g.type === "MultiPolygon") {
        for (const poly of g.coordinates) for (const ring of poly) addRing(ring);
      }
    }
    return new Float32Array(out);
  }

  // 一条连接该往哪个方向跑光点：上传字节数更多就是"本机往外发"（本机→目的地），
  // 下载字节数更多就是"从目的地往回拉"（目的地→本机）；两边都是 0（推断出来的目标，
  // 没有真实字节数可言）或者打平，默认往外——跟 BeeEye 处理"方向未知"时的兜底一致。
  function arcDirection(p) {
    const tx = p.txBytes || 0;
    const rx = p.rxBytes || 0;
    return rx > tx
      ? arc2d(p.lat, p.lon, ANCHOR.lat, ANCHOR.lon)
      : arc2d(ANCHOR.lat, ANCHOR.lon, p.lat, p.lon);
  }

  class NetworkWorldMap {
    constructor(canvas) {
      this.canvas = canvas;
      this.arcs = []; // {born, data: Float32Array}
      const gl = canvas.getContext("webgl2", { antialias: true, alpha: true });
      if (gl) {
        this._initGL(gl);
      } else {
        this._init2D();
      }
      this._resize();
      window.addEventListener("resize", () => this._resize());
      this._startLoop();
    }

    _initGL(gl) {
      this.mode = "gl2";
      this.ok = true;
      this.gl = gl;
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // additive：流量重叠的地方自然更亮

      this.pointProg = makeProgram(gl, VERT_POINT, FRAG_POINT);
      this.lineProg = makeProgram(gl, VERT_LINE, FRAG_LINE);
      this.arcProg = makeProgram(gl, VERT_ARC, FRAG_ARC);

      this.landBuf = gl.createBuffer();
      this.landCount = 0;
      this.pointBuf = gl.createBuffer();
      this.magBuf = gl.createBuffer();
      this.pointCount = 0;
      // 推断出来的目标（命令文本解析+DNS，见 audit.js 的 commandNetworkHosts()）跟系统层
      // 探针实测到的真实流量分开一套缓冲区/一次 drawArrays，用不同颜色画——不能跟真实
      // 流量用同一种橙色，那样地图上完全看不出哪些点是"推断的、不保证真的连通"。
      this.pointBufInferred = gl.createBuffer();
      this.magBufInferred = gl.createBuffer();
      this.pointCountInferred = 0;
      this.arcBuf = gl.createBuffer();
      // 光点头部——只给弧线本身调透明度（原来的做法）太弱，一条 1px 细线在加法混合下
      // 肉眼基本看不出哪里更亮；改成额外在头部位置单独画一个跟目的地发光点同一套
      // pointProg/FRAG_POINT 着色器的小圆点，视觉上才是真的"一个光点在跑"，不是"线
      // 某处稍微亮一点"。
      this.arcHeadBuf = gl.createBuffer();
    }

    _init2D() {
      this.mode = "2d";
      this.ctx = this.canvas.getContext("2d");
      this.ok = !!this.ctx;
      this.land2d = null; // Float32Array [lat,lon,lat,lon,...]，跟 GL 路径同一份数据
      this.pointsReal = [];
      this.pointsInferred = [];
    }

    _resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      if (this.mode === "gl2") this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      const canvasAspect = this.canvas.width / this.canvas.height;
      const dataAspect = 2; // 经度 360° / 纬度 180°
      this.scale = canvasAspect > dataAspect ? [dataAspect / canvasAspect, 1] : [1, canvasAspect / dataAspect];
      this.render();
    }

    async loadLand(url) {
      if (!this.ok) return;
      try {
        const res = await fetch(url);
        const geojson = await res.json();
        const segments = buildLandSegments(geojson);
        if (this.mode === "gl2") {
          this.landCount = segments.length / 2;
          const gl = this.gl;
          gl.bindBuffer(gl.ARRAY_BUFFER, this.landBuf);
          gl.bufferData(gl.ARRAY_BUFFER, segments, gl.STATIC_DRAW);
        } else {
          this.land2d = segments;
        }
        this.render();
      } catch (e) {
        // 世界地图轮廓文件加载失败不影响流量点位本身的展示，退化成"没有海岸线的散点图"
        this.landCount = 0;
        this.land2d = null;
      }
    }

    // pairs: [{lat, lon, bytes, txBytes, rxBytes, inferred}]，按 bytes 归一化成 0..1
    // 的亮度/大小；inferred:true 的点单独处理，好画成不同颜色。每次调用（对应一次
    // 10 秒的轮询）都给当前列表里的每个目的地补一条新弧线——不是只在"第一次看到这个
    // 目的地"时补，这样只要还有流量持续发生，地图就会一直有光点在跑，不会看一眼之后
    // 就完全静止下来。
    setData(pairs) {
      if (!this.ok) return;
      const maxBytes = Math.max(1, ...pairs.map((p) => p.bytes || 0));
      const build = (list) =>
        list
          .filter((p) => typeof p.lat === "number" && typeof p.lon === "number")
          .map((p) => ({ lat: p.lat, lon: p.lon, mag: Math.min(1, Math.log(1 + (p.bytes || 0)) / Math.log(1 + maxBytes)) }));
      const real = build(pairs.filter((p) => !p.inferred));
      const inferred = build(pairs.filter((p) => p.inferred));

      const now = performance.now() / 1000;
      for (const p of pairs) {
        if (typeof p.lat !== "number" || typeof p.lon !== "number") continue;
        this.arcs.push({ born: now, data: new Float32Array(arcDirection(p)) });
      }
      if (this.arcs.length > MAX_ARCS) this.arcs.splice(0, this.arcs.length - MAX_ARCS);

      if (this.mode === "gl2") {
        const gl = this.gl;
        this.pointCount = real.length;
        this.pointCountInferred = inferred.length;
        const flat = (list) => {
          const verts = new Float32Array(list.length * 2);
          const mags = new Float32Array(list.length);
          list.forEach((p, i) => {
            verts[i * 2] = p.lat;
            verts[i * 2 + 1] = p.lon;
            mags[i] = p.mag;
          });
          return { verts, mags };
        };
        const realFlat = flat(real);
        const inferredFlat = flat(inferred);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuf);
        gl.bufferData(gl.ARRAY_BUFFER, realFlat.verts, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.magBuf);
        gl.bufferData(gl.ARRAY_BUFFER, realFlat.mags, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBufInferred);
        gl.bufferData(gl.ARRAY_BUFFER, inferredFlat.verts, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.magBufInferred);
        gl.bufferData(gl.ARRAY_BUFFER, inferredFlat.mags, gl.DYNAMIC_DRAW);
      } else {
        this.pointsReal = real;
        this.pointsInferred = inferred;
      }
      this.render();
    }

    // 持续跑的动画循环——只有这样弧线上的光点才能"动起来"：setData()/resize() 之类
    // 触发的单次 render() 只是让新数据立刻能看见，光点跑动本身得每一帧都重新算一次
    // u_head/头部位置。页面整个生命周期内常驻（这个组件不像 React 那样会被卸载），
    // 用法上跟这个文件里其它 setInterval 轮询是一个道理——不用手动停。
    _startLoop() {
      if (!this.ok) return;
      const loop = () => {
        const now = performance.now() / 1000;
        this.arcs = this.arcs.filter((a) => now - a.born < ARC_DURATION);
        this.render();
        this._rafId = requestAnimationFrame(loop);
      };
      this._rafId = requestAnimationFrame(loop);
    }

    render() {
      if (this.mode === "gl2") this._renderGL();
      else if (this.mode === "2d") this._render2D();
    }

    _renderGL() {
      const gl = this.gl;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      const scale = this.scale || [1, 1];

      if (this.landCount > 0) {
        gl.useProgram(this.lineProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.landBuf);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.uniform2f(gl.getUniformLocation(this.lineProg, "u_scale"), scale[0], scale[1]);
        gl.uniform3f(gl.getUniformLocation(this.lineProg, "u_col"), 0.35, 0.55, 0.75);
        gl.uniform1f(gl.getUniformLocation(this.lineProg, "u_alpha"), 0.55);
        gl.drawArrays(gl.LINES, 0, this.landCount);
      }

      // 弧线——每条弧线的顶点数据都不一样（不同的起止点），逐条上传+画，条数本来就
      // 封顶在 MAX_ARCS，开销可以接受。这条线本身只是淡淡的引导线，真正"看起来在跑"
      // 的是下面单独画的头部光点——只给线本身调透明度（早期版本的做法）在 1px 细线 +
      // 加法混合下肉眼基本分不出哪段更亮，实测截图确认过這一点。
      const headPoints = [];
      if (this.arcs.length > 0) {
        gl.useProgram(this.arcProg);
        gl.uniform2f(gl.getUniformLocation(this.arcProg, "u_scale"), scale[0], scale[1]);
        gl.uniform3f(gl.getUniformLocation(this.arcProg, "u_col"), 0.45, 0.85, 1.0);
        const now = performance.now() / 1000;
        for (const a of this.arcs) {
          const head = (now - a.born) / ARC_DURATION;
          gl.bindBuffer(gl.ARRAY_BUFFER, this.arcBuf);
          gl.bufferData(gl.ARRAY_BUFFER, a.data, gl.DYNAMIC_DRAW);
          gl.enableVertexAttribArray(0);
          gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
          gl.enableVertexAttribArray(1);
          gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
          gl.uniform1f(gl.getUniformLocation(this.arcProg, "u_head"), head);
          gl.drawArrays(gl.LINE_STRIP, 0, a.data.length / 3);
          headPoints.push(arcHeadLatLon(a.data, head));
        }
      }

      // 头部光点——复用目的地发光点同一套 pointProg/FRAG_POINT 着色器（柔和的径向
      // 光晕），批量一次 drawArrays 画完所有还活着的弧线的头部，不是每条弧线单独一次
      // draw call。mag 固定给一个比较亮的值（0.75），不跟目的地的流量大小挂钩——
      // 这个点表示的是"光点跑到哪了"，不是"这个目的地流量有多大"，两件事不一样。
      if (headPoints.length > 0) {
        const verts = new Float32Array(headPoints.length * 2);
        headPoints.forEach(([lat, lon], i) => {
          verts[i * 2] = lat;
          verts[i * 2 + 1] = lon;
        });
        gl.useProgram(this.pointProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.arcHeadBuf);
        gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        // mag 是常量，不需要真的开一条 buffer——vertexAttrib1f 给禁用的属性数组供一个
        // 常量值，省一次 bufferData。
        gl.disableVertexAttribArray(1);
        gl.vertexAttrib1f(1, 0.75);
        gl.uniform2f(gl.getUniformLocation(this.pointProg, "u_scale"), scale[0], scale[1]);
        gl.uniform1f(gl.getUniformLocation(this.pointProg, "u_size"), 14 * (window.devicePixelRatio || 1));
        gl.uniform3f(gl.getUniformLocation(this.pointProg, "u_col"), 0.45, 0.85, 1.0);
        gl.drawArrays(gl.POINTS, 0, headPoints.length);
      }

      if (this.pointCount > 0) {
        gl.useProgram(this.pointProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuf);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.magBuf);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
        gl.uniform2f(gl.getUniformLocation(this.pointProg, "u_scale"), scale[0], scale[1]);
        gl.uniform1f(gl.getUniformLocation(this.pointProg, "u_size"), 26 * (window.devicePixelRatio || 1));
        gl.uniform3f(gl.getUniformLocation(this.pointProg, "u_col"), 0.95, 0.55, 0.25);
        gl.drawArrays(gl.POINTS, 0, this.pointCount);
      }

      // 推断出来的目标（命令文本解析，不是探针实测）单独一次 drawArrays，颜色换成
      // 跟表格里 .dd-badge-inferred 徽章同一个琥珀色系，视觉上跟真实流量的橙色区分开，
      // 不会让人误以为地图上每个点都是探针确认过的连接。
      if (this.pointCountInferred > 0) {
        gl.useProgram(this.pointProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBufInferred);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.magBufInferred);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
        gl.uniform2f(gl.getUniformLocation(this.pointProg, "u_scale"), scale[0], scale[1]);
        gl.uniform1f(gl.getUniformLocation(this.pointProg, "u_size"), 26 * (window.devicePixelRatio || 1));
        gl.uniform3f(gl.getUniformLocation(this.pointProg, "u_col"), 1.0, 0.83, 0.47);
        gl.drawArrays(gl.POINTS, 0, this.pointCountInferred);
      }
    }

    // Canvas 2D 兜底路径——WebGL2 不可用时画同一套内容（网格线拿掉了，海岸线+弧线+
    // 光点齐全），用 globalCompositeOperation='lighter' 模拟 GL 那边的加法混合
    // （重叠的地方自然更亮）。挂着 requestAnimationFrame，跟 GL 路径一样持续动画。
    _render2D() {
      const ctx = this.ctx;
      const w = this.canvas.width;
      const h = this.canvas.height;
      if (w <= 0 || h <= 0) return; // 还没布局好（首次绘制/resize 中间态），clientWidth 可能读到 0
      const scale = this.scale || [1, 1];
      // 跟 GL 路径同一套投影+letterbox 缩放，只是最后再从 clip space [-1,1] 换算成像素。
      const toPx = (lat, lon) => {
        const cx = (lon / 180) * scale[0];
        const cy = (lat / 90) * scale[1];
        return [((cx + 1) / 2) * w, ((1 - cy) / 2) * h];
      };

      ctx.clearRect(0, 0, w, h);

      if (this.land2d && this.land2d.length > 0) {
        ctx.strokeStyle = "rgba(89, 140, 191, 0.55)";
        ctx.lineWidth = Math.max(1, window.devicePixelRatio || 1);
        ctx.beginPath();
        for (let i = 0; i < this.land2d.length; i += 4) {
          const [x0, y0] = toPx(this.land2d[i], this.land2d[i + 1]);
          const [x1, y1] = toPx(this.land2d[i + 2], this.land2d[i + 3]);
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
        }
        ctx.stroke();
      }

      ctx.globalCompositeOperation = "lighter";

      const now = performance.now() / 1000;
      for (const a of this.arcs) {
        const n = a.data.length / 3;
        if (n <= 0) continue;
        const head = (now - a.born) / ARC_DURATION;
        ctx.strokeStyle = "rgba(115, 217, 255, 1)";
        ctx.lineWidth = Math.max(1, 1.4 * (window.devicePixelRatio || 1));
        ctx.globalAlpha = 0.3;
        ctx.beginPath();
        for (let k = 0; k < n; k++) {
          const [x, y] = toPx(a.data[k * 3], a.data[k * 3 + 1]);
          k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
        const hi = Math.max(0, Math.min(n - 1, Math.round(head * (n - 1))));
        const [hx, hy] = toPx(a.data[hi * 3], a.data[hi * 3 + 1]);
        const rad = 7 * (window.devicePixelRatio || 1);
        const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, rad);
        g.addColorStop(0, "rgba(115, 217, 255, 0.95)");
        g.addColorStop(1, "rgba(115, 217, 255, 0)");
        ctx.globalAlpha = 1;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(hx, hy, rad, 0, Math.PI * 2);
        ctx.fill();
      }

      const drawPoints = (list, colorCss) => {
        for (const p of list) {
          const [x, y] = toPx(p.lat, p.lon);
          const rad = (10 + p.mag * 18) * (window.devicePixelRatio || 1);
          const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
          g.addColorStop(0, colorCss);
          g.addColorStop(1, "rgba(0,0,0,0)");
          ctx.globalAlpha = 0.35 + p.mag * 0.5;
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x, y, rad, 0, Math.PI * 2);
          ctx.fill();
        }
      };
      drawPoints(this.pointsReal, "rgba(242, 140, 64, 1)");
      // 推断出来的目标换成跟 .dd-badge-inferred 徽章同一个琥珀色系，跟 GL 路径的
      // u_col (1.0, 0.83, 0.47) 保持一致，两条渲染路径视觉效果对得上。
      drawPoints(this.pointsInferred, "rgba(255, 212, 120, 1)");

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
  }

  window.NetworkWorldMap = NetworkWorldMap;
})();
