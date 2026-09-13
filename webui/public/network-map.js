"use strict";
// 世界地图流量可视化——参考 BeeEye 项目的 WorldMap.jsx 做法：不依赖任何地图瓦片
// 服务/第三方地图 API（避免额外的网络依赖和数据泄露面），纯 WebGL2 自己画：
// 等距柱状投影（lon/lat 直接线性映射到 clip space），海岸线用本地打包的低精度
// world.geo.json（跟 BeeEye 同一份数据，同一个作者的项目之间互相借用）画成线段，
// 每个有流量的目的地画一个按流量大小/新鲜程度决定亮度的发光点。
// 原版还有"新连接触发一条动画弧线"的效果，这里先只做静态的点位展示，弧线动画
// 属于锦上添花，没做——不想为了这个再抄一遍完整的着色器动画状态机。
(function () {
  function project(lat, lon) {
    return [lon / 180, lat / 90];
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

  // buildLandSegments：跟 BeeEye 同名函数一样，把 GeoJSON 多边形的每条边拆成
  // [lat,lon, lat,lon] 线段对，用 GL_LINES 画出海岸线轮廓（不是填色的实心大陆）。
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

  class NetworkWorldMap {
    constructor(canvas) {
      this.canvas = canvas;
      this.gl = canvas.getContext("webgl2", { antialias: true, alpha: true });
      this.ok = !!this.gl;
      if (!this.ok) return;
      const gl = this.gl;
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // additive：流量重叠的地方自然更亮

      this.pointProg = makeProgram(gl, VERT_POINT, FRAG_POINT);
      this.lineProg = makeProgram(gl, VERT_LINE, FRAG_LINE);

      this.landBuf = gl.createBuffer();
      this.landCount = 0;
      this.pointBuf = gl.createBuffer();
      this.magBuf = gl.createBuffer();
      this.pointCount = 0;

      this._resize();
      window.addEventListener("resize", () => this._resize());
    }

    _resize() {
      if (!this.ok) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = this.canvas.getBoundingClientRect();
      this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
      this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
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
        this.landCount = segments.length / 2;
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.landBuf);
        gl.bufferData(gl.ARRAY_BUFFER, segments, gl.STATIC_DRAW);
        this.render();
      } catch (e) {
        // 世界地图轮廓文件加载失败不影响流量点位本身的展示，退化成"没有海岸线的散点图"
        this.landCount = 0;
      }
    }

    // pairs: [{lat, lon, bytes}], 按 bytes 归一化成 0..1 的亮度/大小
    setData(pairs) {
      if (!this.ok) return;
      const maxBytes = Math.max(1, ...pairs.map((p) => p.bytes || 0));
      const verts = [];
      const mags = [];
      for (const p of pairs) {
        if (typeof p.lat !== "number" || typeof p.lon !== "number") continue;
        verts.push(p.lat, p.lon);
        mags.push(Math.min(1, Math.log(1 + (p.bytes || 0)) / Math.log(1 + maxBytes)));
      }
      this.pointCount = mags.length;
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.magBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mags), gl.DYNAMIC_DRAW);
      this.render();
    }

    render() {
      if (!this.ok) return;
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
    }
  }

  window.NetworkWorldMap = NetworkWorldMap;
})();
