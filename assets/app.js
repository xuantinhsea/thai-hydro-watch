/* Thai Hydro Watch: ThaiWater (HII) station data for the study area.
 * Copyright (c) 2026 Nguyen Xuan TINH (Ph.D.), Nippon Koei Co., Ltd. All rights reserved.
 *
 * The page shows a fixed snapshot (data/dataset.js, built by python/build_dataset.py).
 * It checks every series in the browser and draws the map, charts, overview and table;
 * nothing is fetched, so the page also works as a single file opened from disk.
 */
"use strict";
(() => {
  const HOUR = 3600e3, DAY = 86400e3;
  const FLAGS = { spikeM: 1, stuckH: 72, rainDayMm: 200, wetZeroDays: 20 };

  const $ = (s) => document.querySelector(s);
  const NS = "http://www.w3.org/2000/svg";
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n) => String(n).padStart(2, "0");
  const has = (x) => x === x; // series are Float32Arrays; missing is NaN
  const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtInt = (n) => n.toLocaleString("en-US");
  const fmtNum = (v, dec) => (has(v) && v !== null ? (+v.toFixed(dec)).toLocaleString("en-US", { maximumFractionDigits: dec }) : "–");
  const pct = (c) => `${Math.round(c * 100)}%`;

  // ---- time: all times are naive Thai clock times held as UTC milliseconds ----------
  const isoDate = (t) => new Date(t).toISOString().slice(0, 10);
  const parseStamp = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(s || "");
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : NaN;
  };
  const fmtTime = (t, daily) => {
    const d = new Date(t);
    const base = `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    return daily ? base : `${base}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  };
  const shortDate = (t) => { const d = new Date(t); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
  const csvStamp = (t) => {
    const d = new Date(t);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${d.getUTCHours()}:${pad(d.getUTCMinutes())}`;
  };

  // ---- variables and statuses -------------------------------------------------------
  const VARS = {
    wl: { label: "Water level", unit: "m MSL", mark: "line", cls: "t-w", dec: 3, step: "hourly", csv: "Water level (m MSL)", kind: "w" },
    q: { label: "Discharge", unit: "m³/s", mark: "line", cls: "t-q", dec: 2, step: "hourly", csv: "Discharge (m3/s)", kind: "w" },
    rain: { label: "Rain daily", unit: "mm/day", mark: "bar", cls: "t-r", dec: 1, step: "daily", csv: "Rainfall (mm/day)", kind: "r" },
  };
  const TYPE = { w: "Water level", q: "Water level + discharge", r: "Rain gauge" };
  const STATUS = {
    check: { label: "Check", desc: "spikes, stuck values or extreme totals", rank: 0 },
    sparse: { label: "Sparse", desc: "under 50% of readings", rank: 1 },
    gaps: { label: "Gaps", desc: "50–90% of readings", rank: 2 },
    ok: { label: "OK", desc: "90% or more, nothing flagged", rank: 3 },
    pending: { label: "Pending", desc: "not downloaded yet", rank: 4 },
  };
  const ICON = {
    ok: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle class="i-ok" cx="6" cy="6" r="6"/><path class="i-mark" d="M3.4 6.2l1.8 1.8 3.4-3.6"/></svg>',
    gaps: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle class="i-gaps-ring" cx="6" cy="6" r="5"/><path class="i-gaps" d="M6 1a5 5 0 0 1 0 10z"/></svg>',
    sparse: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle class="i-sparse-ring" cx="6" cy="6" r="4.6"/></svg>',
    check: '<svg viewBox="0 0 12 12" aria-hidden="true"><path class="i-check" d="M6 .6l5.6 10.2H.4z"/><path class="i-mark" d="M6 4.4v2.8M6 9.1v.1"/></svg>',
    pending: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle class="i-pending" cx="6" cy="6" r="4.6"/></svg>',
  };
  const chip = (status, extra = "") => `<span class="chip">${ICON[status]}${STATUS[status].label}${extra ? ` · ${extra}` : ""}</span>`;

  // ---- app state ---------------------------------------------------------------------
  const state = { v: "wl", status: "all", color: "type", q: "", sel: null };
  const app = { aoi: null, proj: null, stations: [], byKey: new Map(), series: { wl: null, q: null, rain: null } };
  const series = (v) => app.series[v];
  const rowOf = (v, k) => (app.series[v] ? app.series[v].rows.get(k) || null : null);
  const statusOf = (v, k) => { const r = rowOf(v, k); return r ? r.status : "pending"; };
  const typeOf = (s) => (s.kind === "r" ? "r" : rowOf("q", s.k) ? "q" : "w");
  const inVar = (s, v) => (v === "q" ? s.kind === "w" && !!rowOf("q", s.k) : s.kind === VARS[v].kind);
  const label = (s) => (s.code && !s.name.includes(s.code) ? `${s.code} ${s.name}` : s.name || s.code || s.id);
  const newSeries = (t0, step, n) => ({ t0, step, n: Math.max(1, n), rows: new Map() });
  const timeAt = (v, i) => series(v).t0 + i * series(v).step * 60000;

  // ---- checks -------------------------------------------------------------------------
  function rollingMedian(vals, width, minCount) {
    const n = vals.length, half = width >> 1, out = new Float32Array(n).fill(NaN), buf = [];
    for (let i = 0; i < n; i++) {
      buf.length = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) if (has(vals[j])) buf.push(vals[j]);
      if (buf.length >= minCount) {
        buf.sort((a, b) => a - b);
        const m = buf.length >> 1;
        out[i] = buf.length % 2 ? buf[m] : (buf[m - 1] + buf[m]) / 2;
      }
    }
    return out;
  }
  function longestRun(vals) {
    let best = 0, run = 0;
    for (let i = 0; i < vals.length; i++) {
      if (!has(vals[i])) { run = 0; continue; }
      run = i > 0 && vals[i] === vals[i - 1] ? run + 1 : 1;
      if (run > best) best = run;
    }
    return best;
  }
  function summarise(v, vals, extraNotes = []) {
    const n = vals.length, ser = series(v);
    let count = 0, min = Infinity, max = -Infinity, sum = 0;
    for (let i = 0; i < n; i++) {
      const x = vals[i];
      if (!has(x)) continue;
      count++; sum += x;
      if (x < min) min = x;
      if (x > max) max = x;
    }
    const notes = [...extraNotes], spikes = [];
    if (count) {
      if (v === "wl" || v === "q") {
        const med = rollingMedian(vals, 7, 3);
        for (let i = 0; i < n; i++) {
          if (!has(vals[i]) || !has(med[i])) continue;
          const limit = v === "wl" ? FLAGS.spikeM : Math.max(0.5 * Math.abs(med[i]), 10);
          if (Math.abs(vals[i] - med[i]) > limit) spikes.push(i);
        }
        if (spikes.length) notes.push(`${spikes.length} possible spike${spikes.length > 1 ? "s" : ""}`);
      }
      if (v === "wl" && count >= 200) {
        const run = longestRun(vals);
        if (run >= FLAGS.stuckH) notes.push(`same value for ${run} h`);
      }
      if (v === "rain") {
        let wetDays = 0, wetSum = 0, heavy = 0;
        for (let i = 0; i < n; i++) {
          if (!has(vals[i])) continue;
          const month = new Date(ser.t0 + i * DAY).getUTCMonth() + 1;
          if (month >= 5 && month <= 10) { wetDays++; wetSum += vals[i]; }
          if (vals[i] >= FLAGS.rainDayMm) heavy++;
        }
        if (wetDays >= FLAGS.wetZeroDays && wetSum === 0) notes.push(`all zeros over ${wetDays} wet-season days`);
        if (heavy) notes.push(`${heavy} day${heavy > 1 ? "s" : ""} ≥ ${FLAGS.rainDayMm} mm`);
      }
    }
    const sorted = Float32Array.from(vals.filter(has)).sort();
    const q = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] : NaN);
    const c = count / n;
    const status = notes.length ? "check" : c < 0.5 ? "sparse" : c < 0.9 ? "gaps" : "ok";
    return { v: vals, c, count, min: count ? min : NaN, max: count ? max : NaN, lo: q(0.01), hi: q(0.99), sum, spikes, notes, status };
  }

  // ---- AOI and projection ---------------------------------------------------------------
  function polygonsOf(geojson) {
    const polys = [];
    const visit = (g) => {
      if (!g) return;
      if (Array.isArray(g)) g.forEach(visit);
      else if (g.type === "FeatureCollection") g.features.forEach((f) => visit(f.geometry));
      else if (g.type === "Feature") visit(g.geometry);
      else if (g.type === "GeometryCollection") g.geometries.forEach(visit);
      else if (g.type === "Polygon") polys.push(g.coordinates);
      else if (g.type === "MultiPolygon") g.coordinates.forEach((p) => polys.push(p));
    };
    visit(geojson);
    return polys;
  }
  function boundsOf(polys) {
    const b = { w: Infinity, s: Infinity, e: -Infinity, n: -Infinity };
    polys.forEach((p) => p[0].forEach(([x, y]) => {
      if (x < b.w) b.w = x; if (x > b.e) b.e = x; if (y < b.s) b.s = y; if (y > b.n) b.n = y;
    }));
    return b;
  }
  function inRing(ring, x, y) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function inAOI(lon, lat) {
    const { polys, bounds: b } = app.aoi;
    if (lon < b.w || lon > b.e || lat < b.s || lat > b.n) return false;
    return polys.some((p) => inRing(p[0], lon, lat) && !p.slice(1).some((hole) => inRing(hole, lon, lat)));
  }
  function makeProjection(b) {
    const margin = Math.max(0.15, 0.04 * Math.max(b.e - b.w, b.n - b.s));
    const west = b.w - margin, east = b.e + margin, south = b.s - margin, north = b.n + margin;
    const cos = Math.cos(((south + north) / 2) * (Math.PI / 180)), k = 100;
    return {
      west, east, south, north,
      w: (east - west) * cos * k, h: (north - south) * k,
      xy: (lon, lat) => [(lon - west) * cos * k, (north - lat) * k],
    };
  }
  function pathOf(geom, P) {
    if (!geom) return "";
    const ring = (pts, close) => "M" + pts.map(([x, y]) => P.xy(x, y).map((v) => v.toFixed(2)).join(",")).join("L") + (close ? "Z" : "");
    switch (geom.type) {
      case "Polygon": return geom.coordinates.map((r) => ring(r, true)).join("");
      case "MultiPolygon": return geom.coordinates.map((p) => p.map((r) => ring(r, true)).join("")).join("");
      case "LineString": return ring(geom.coordinates, false);
      case "MultiLineString": return geom.coordinates.map((l) => ring(l, false)).join("");
      case "GeometryCollection": return geom.geometries.map((g) => pathOf(g, P)).join("");
      default: return "";
    }
  }

  // ---- map ------------------------------------------------------------------------------
  const svg = $("#map"), mapBox = $("#map-box"), mapTip = $("#map-tip");
  const world = document.createElementNS(NS, "g");
  svg.appendChild(world);
  const view = { k: 1, tx: 0, ty: 0 };
  let dots = [], labels = [];

  function buildBase() {
    const P = app.proj, B = window.BASEMAP;
    svg.setAttribute("viewBox", `0 0 ${P.w.toFixed(1)} ${P.h.toFixed(1)}`);
    const inView = (lon, lat) => lon > P.west && lon < P.east && lat > P.south && lat < P.north;
    const riverLabels = [];
    B.rivers.features.forEach((f) => {
      if (!f.properties.name || f.geometry.type !== "LineString") return;
      const c = f.geometry.coordinates, mid = c[Math.floor(c.length / 2)];
      if (inView(mid[0], mid[1])) riverLabels.push({ name: f.properties.name, xy: P.xy(mid[0], mid[1]) });
    });
    world.innerHTML =
      `<rect x="-5000" y="-5000" width="${P.w + 10000}" height="${P.h + 10000}" fill="transparent"/>` +
      `<path class="neigh" d="${pathOf(B.neighbours, P)}"/>` +
      `<path class="thai" d="${pathOf(B.thailand, P)}"/>` +
      `<path class="aoi" d="${pathOf({ type: "MultiPolygon", coordinates: app.aoi.polys }, P)}"/>` +
      B.rivers.features.map((f) => `<path class="river" d="${pathOf(f.geometry, P)}"/>`).join("") +
      `<g id="pts-r"></g><g id="pts-w"></g><g id="labels">` +
      B.places.filter((p) => inView(p.lon, p.lat)).map((p) => {
        const [x, y] = P.xy(p.lon, p.lat);
        return `<circle class="place-dot" data-r="2.2" cx="${x}" cy="${y}"/><text class="place" data-fs="11.5" data-dx="5" x="${x}" y="${y}">${esc(p.name)}</text>`;
      }).join("") +
      riverLabels.map((r) => `<text class="river-label" data-fs="11" data-dx="4" x="${r.xy[0]}" y="${r.xy[1]}">${esc(r.name)}</text>`).join("") +
      `</g><circle id="sel-ring" r="0" cx="-99" cy="-99"/>`;
    labels = [...world.querySelectorAll("#labels [data-fs], #labels [data-r]")];
    dots = [];
    view.k = 1; view.tx = 0; view.ty = 0;
  }
  function buildDots() {
    const ptsR = world.querySelector("#pts-r"), ptsW = world.querySelector("#pts-w");
    ptsR.textContent = ""; ptsW.textContent = "";
    dots = app.stations.map((s) => {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", s.x.toFixed(2)); c.setAttribute("cy", s.y.toFixed(2));
      (s.kind === "r" ? ptsR : ptsW).appendChild(c);
      return { s, el: c, r: s.kind === "r" ? 2.8 : 4.2 };
    });
    applyZoom(); updateMap();
  }
  function unitPx() {
    const r = svg.getBoundingClientRect();
    return app.proj ? Math.min(r.width / app.proj.w, r.height / app.proj.h) || 1 : 1;
  }
  function applyZoom() {
    world.setAttribute("transform", `translate(${view.tx} ${view.ty}) scale(${view.k})`);
    const u = 1 / (view.k * unitPx());
    dots.forEach((d) => d.el.setAttribute("r", (d.r * u).toFixed(4)));
    labels.forEach((el) => {
      if (el.dataset.fs) {
        el.setAttribute("font-size", (el.dataset.fs * u).toFixed(4));
        el.setAttribute("dx", (el.dataset.dx * u).toFixed(4));
        el.setAttribute("dy", (4 * u).toFixed(4));
        el.style.strokeWidth = `${3 * u}px`;
      } else el.setAttribute("r", (el.dataset.r * u).toFixed(4));
    });
    const ring = world.querySelector("#sel-ring");
    if (ring) ring.setAttribute("r", (9 * u).toFixed(4));
  }
  function dotClass(d) {
    const s = d.s, cls = ["pt"], member = inVar(s, state.v), st = member ? statusOf(state.v, s.k) : null;
    if (state.color === "type") {
      cls.push(`t-${typeOf(s)}`);
      const rr = rowOf("rain", s.k);
      if (s.kind === "r" && rr && rr.count === 0) cls.push("hollow");
    } else cls.push(member ? `s-${st}` : "dim");
    if (member && state.status !== "all" && st !== state.status) cls.push("faded");
    return cls.join(" ");
  }
  function updateMap() {
    dots.forEach((d) => d.el.setAttribute("class", dotClass(d)));
    const s = state.sel && app.byKey.get(state.sel), ring = world.querySelector("#sel-ring");
    if (!ring) return;
    if (s) { ring.setAttribute("cx", s.x); ring.setAttribute("cy", s.y); } else ring.setAttribute("cx", -99);
  }
  function renderMapLegend() {
    const el = $("#map-legend");
    if (state.color === "type") {
      const n = { w: 0, q: 0, r: 0, empty: 0 };
      app.stations.forEach((s) => {
        n[typeOf(s)]++;
        const rr = rowOf("rain", s.k);
        if (s.kind === "r" && rr && rr.count === 0) n.empty++;
      });
      el.innerHTML =
        `<span><i class="key bg-w"></i>Water level · ${fmtInt(n.w)}</span>` +
        `<span><i class="key bg-q"></i>Water level + discharge · ${fmtInt(n.q)}</span>` +
        `<span><i class="key small bg-r"></i>Rain gauge · ${fmtInt(n.r - n.empty)}</span>` +
        (n.empty ? `<span><i class="key small hollow"></i>Rain gauge, no data · ${fmtInt(n.empty)}</span>` : "");
    } else {
      el.innerHTML = ["check", "sparse", "gaps", "ok"].map((s) => `<span><i class="key bg-${s}"></i>${STATUS[s].label}</span>`).join("") +
        `<span><i class="key bg-dim"></i>Not ${VARS[state.v].label.toLowerCase()}</span>`;
    }
  }
  const toView = (e) => { const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); };
  function nearest(e, maxPx = 14) {
    const p = toView(e), wx = (p.x - view.tx) / view.k, wy = (p.y - view.ty) / view.k, scale = view.k * unitPx();
    let best = null, bestD = Infinity;
    for (const d of dots) {
      if (d.el.classList.contains("faded")) continue;
      const dd = Math.hypot(d.s.x - wx, d.s.y - wy) * scale - (d.s.kind === "r" ? 0 : 2);
      if (dd < bestD) { bestD = dd; best = d; }
    }
    return bestD <= maxPx ? best : null;
  }
  function zoomAt(p, factor) {
    const k = Math.min(80, Math.max(1, view.k * factor)), f = k / view.k;
    view.tx = p.x - (p.x - view.tx) * f; view.ty = p.y - (p.y - view.ty) * f; view.k = k;
    if (k === 1) { view.tx = 0; view.ty = 0; }
    applyZoom();
  }
  svg.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(toView(e), Math.exp(-e.deltaY * 0.0016)); }, { passive: false });
  const centre = () => ({ x: app.proj.w / 2, y: app.proj.h / 2 });
  $("#z-in").addEventListener("click", () => zoomAt(centre(), 1.6));
  $("#z-out").addEventListener("click", () => zoomAt(centre(), 1 / 1.6));
  $("#z-reset").addEventListener("click", () => { view.k = 1; view.tx = 0; view.ty = 0; applyZoom(); });
  let drag = null;
  svg.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, moved: false };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", (e) => {
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) > 3) { drag.moved = true; svg.classList.add("dragging"); mapTip.hidden = true; }
      if (drag.moved) { const u = unitPx(); view.tx = drag.tx + dx / u; view.ty = drag.ty + dy / u; applyZoom(); }
      return;
    }
    const hit = nearest(e);
    if (!hit) { mapTip.hidden = true; return; }
    showMapTip(hit.s, e);
  });
  svg.addEventListener("pointerup", (e) => {
    const wasDrag = drag && drag.moved;
    drag = null; svg.classList.remove("dragging");
    if (!wasDrag) { const hit = nearest(e); if (hit) select(hit.s.k, "map"); }
  });
  svg.addEventListener("pointerleave", () => { if (!drag) mapTip.hidden = true; });

  const varsOf = (s) => (s.kind === "r" ? ["rain"] : rowOf("q", s.k) ? ["wl", "q"] : ["wl"]);
  function statusLine(v, k) {
    const r = rowOf(v, k);
    return r ? chip(r.status, pct(r.c)) : chip("pending");
  }
  function showMapTip(s, e) {
    mapTip.innerHTML = `<b>${esc(label(s))}</b><div class="t-sub">${TYPE[typeOf(s)]} · ${esc(s.agency)} · ${esc(s.prov)}</div>` +
      varsOf(s).filter((v) => app.series[v]).map((v) => `<div class="t-row">${VARS[v].label} ${statusLine(v, s.k)}</div>`).join("");
    mapTip.hidden = false;
    const box = mapBox.getBoundingClientRect();
    let x = e.clientX - box.left + 14, y = e.clientY - box.top + 14;
    if (x + mapTip.offsetWidth > box.width - 8) x = e.clientX - box.left - mapTip.offsetWidth - 14;
    if (y + mapTip.offsetHeight > box.height - 8) y = e.clientY - box.top - mapTip.offsetHeight - 14;
    mapTip.style.left = `${Math.max(4, x)}px`; mapTip.style.top = `${Math.max(4, y)}px`;
  }

  // ---- charts -------------------------------------------------------------------------
  function dayTicks(v) {
    const ser = series(v), days = (ser.n * ser.step) / 1440, out = [];
    for (let i = 0; i < ser.n; i++) {
      const t = ser.t0 + i * ser.step * 60000, d = new Date(t), h = d.getUTCHours(), dd = d.getUTCDate();
      if (d.getUTCMinutes()) continue;
      if (days <= 3) { if (h % 6 === 0) out.push({ i, label: h === 0 ? shortDate(t) : `${pad(h)}:00` }); continue; }
      if (h) continue;
      if (days <= 10 || (days <= 45 && [1, 8, 15, 22].includes(dd)) || (days <= 120 && (dd === 1 || dd === 15))) out.push({ i, label: shortDate(t) });
      else if (days > 120 && dd === 1) out.push({ i, label: `${MON[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}` });
    }
    return out;
  }
  function niceStep(span, count) {
    const raw = span / count, mag = 10 ** Math.floor(Math.log10(raw)), err = raw / mag;
    return (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
  }
  function chart(el, v, key) {
    const row = rowOf(v, key), ser = series(v), m = VARS[v];
    if (!ser || !row) { el.innerHTML = `<p class="empty">Loading ${m.label.toLowerCase()}…</p>`; return; }
    if (!row.count) { el.innerHTML = `<p class="empty">No ${m.label.toLowerCase()} readings in this period.${row.notes.length ? ` ${esc(row.notes.join("; "))}.` : ""}</p>`; return; }
    const W = Math.max(280, el.clientWidth), H = m.mark === "bar" ? 210 : 196;
    const mg = { l: 50, r: m.mark === "bar" ? 12 : 58, t: 14, b: 24 };
    const pw = W - mg.l - mg.r, ph = H - mg.t - mg.b, n = ser.n, vals = row.v;
    let lo = row.min, hi = row.max;
    if (v !== "wl") lo = Math.min(0, lo);
    if (hi - lo < 1e-9) { hi += 1; lo -= v === "wl" ? 1 : 0; }
    const step = niceStep(hi - lo, 4);
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const dec = Math.max(0, -Math.floor(Math.log10(step)));
    const band = pw / n;
    const x = m.mark === "bar" ? (i) => mg.l + (i + 0.5) * band : (i) => mg.l + (n > 1 ? (i * pw) / (n - 1) : pw / 2);
    const y = (val) => mg.t + ph - ((val - lo) / (hi - lo)) * ph;
    const half = n > 1 ? pw / (n - 1) / 2 : pw / 2;
    const parts = [];
    let i0 = null;
    for (let i = 0; i <= n; i++) {
      const missing = i < n && !has(vals[i]);
      if (missing && i0 === null) i0 = i;
      if (!missing && i0 !== null) {
        const a = m.mark === "bar" ? mg.l + i0 * band : Math.max(mg.l, x(i0) - half);
        const b = m.mark === "bar" ? mg.l + i * band : Math.min(mg.l + pw, x(i - 1) + half);
        parts.push(`<rect class="c-gap" x="${a.toFixed(1)}" y="${mg.t}" width="${Math.max(1, b - a).toFixed(1)}" height="${ph}"/>`);
        i0 = null;
      }
    }
    for (let t = lo; t <= hi + step * 1e-6; t += step) {
      const yy = y(t).toFixed(1);
      if (Math.abs(t - lo) > step * 1e-6) parts.push(`<line class="c-grid" x1="${mg.l}" x2="${mg.l + pw}" y1="${yy}" y2="${yy}"/>`);
      parts.push(`<text class="c-tick" x="${mg.l - 8}" y="${(+yy + 4).toFixed(1)}" text-anchor="end">${fmtNum(+t.toFixed(10), dec)}</text>`);
    }
    parts.push(`<line class="c-base" x1="${mg.l}" x2="${mg.l + pw}" y1="${mg.t + ph}" y2="${mg.t + ph}"/>`);
    dayTicks(v).forEach(({ i, label: l }) => {
      const xx = (m.mark === "bar" ? mg.l + i * band : x(i)).toFixed(1);
      parts.push(`<line class="c-base" x1="${xx}" x2="${xx}" y1="${mg.t + ph}" y2="${mg.t + ph + 4}"/>`);
      parts.push(`<text class="c-tick" x="${xx}" y="${H - 4}" text-anchor="middle">${l}</text>`);
    });
    if (m.mark === "line") {
      let d = "", pen = false;
      for (let i = 0; i < n; i++) {
        const val = vals[i];
        if (!has(val)) { pen = false; continue; }
        d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(val).toFixed(1)}`;
        if (!pen && (i === n - 1 || !has(vals[i + 1]))) d += "h0.1";
        pen = true;
      }
      parts.push(`<path class="c-line ${m.cls}" d="${d}"/>`);
      row.spikes.forEach((i) => parts.push(`<circle class="c-spike" cx="${x(i).toFixed(1)}" cy="${y(vals[i]).toFixed(1)}" r="4"/>`));
      let last = n - 1;
      while (last >= 0 && !has(vals[last])) last--;
      if (last >= 0) {
        parts.push(`<circle class="c-dot ${m.cls}" cx="${x(last).toFixed(1)}" cy="${y(vals[last]).toFixed(1)}" r="4"/>`);
        parts.push(`<text class="c-label" x="${(x(last) + 8).toFixed(1)}" y="${(y(vals[last]) + 4).toFixed(1)}">${fmtNum(vals[last], m.dec)}</text>`);
      }
    } else {
      const bw = Math.max(1, Math.min(24, band - 2));
      let maxI = -1;
      for (let i = 0; i < n; i++) {
        const val = vals[i];
        if (!has(val) || val <= 0) continue;
        if (maxI < 0 || val > vals[maxI]) maxI = i;
        const cx = x(i), top = y(val), base = mg.t + ph, r = Math.min(4, bw / 2, base - top);
        const l = (cx - bw / 2).toFixed(1), rgt = (cx + bw / 2).toFixed(1);
        parts.push(`<path class="c-bar ${m.cls}" d="M${l},${base}V${(top + r).toFixed(1)}Q${l},${top.toFixed(1)} ${(cx - bw / 2 + r).toFixed(1)},${top.toFixed(1)}H${(cx + bw / 2 - r).toFixed(1)}Q${rgt},${top.toFixed(1)} ${rgt},${(top + r).toFixed(1)}V${base}Z"/>`);
      }
      if (maxI >= 0) parts.push(`<text class="c-label" x="${x(maxI).toFixed(1)}" y="${(y(vals[maxI]) - 5).toFixed(1)}" text-anchor="middle">${fmtNum(vals[maxI], 1)}</text>`);
    }
    parts.push(`<g class="cross" visibility="hidden"><line class="c-cross" y1="${mg.t}" y2="${mg.t + ph}"/><circle class="c-dot ${m.cls}" r="4"/></g>`);
    parts.push(`<rect x="${mg.l}" y="${mg.t}" width="${pw}" height="${ph}" fill="transparent"/>`);
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(m.label)} for ${esc(label(app.byKey.get(key)))}">${parts.join("")}</svg><div class="tip" hidden></div>`;
    el.tabIndex = 0;

    const sv = el.querySelector("svg"), cross = sv.querySelector(".cross"), tip = el.querySelector(".tip");
    const spikeSet = new Set(row.spikes), daily = ser.step === 1440;
    let cur = null;
    const show = (i) => {
      cur = Math.max(0, Math.min(n - 1, i));
      const val = vals[cur], xx = x(cur), dot = cross.querySelector("circle"), line = cross.querySelector("line");
      cross.setAttribute("visibility", "visible");
      line.setAttribute("x1", xx); line.setAttribute("x2", xx);
      if (!has(val)) dot.setAttribute("visibility", "hidden");
      else { dot.setAttribute("visibility", "visible"); dot.setAttribute("cx", xx); dot.setAttribute("cy", y(val)); }
      tip.innerHTML = `<div class="t-sub">${fmtTime(ser.t0 + cur * ser.step * 60000, daily)}</div>` +
        (has(val) ? `<b>${fmtNum(val, m.dec)}</b> ${m.unit}` : "<b>No reading</b>") +
        (spikeSet.has(cur) ? `<div class="t-row">${chip("check", "possible spike")}</div>` : "");
      tip.hidden = false;
      const px = (xx / W) * el.clientWidth;
      let left = px + 12;
      if (left + tip.offsetWidth > el.clientWidth) left = px - tip.offsetWidth - 12;
      tip.style.left = `${Math.max(0, left)}px`; tip.style.top = "4px";
    };
    const hide = () => { cross.setAttribute("visibility", "hidden"); tip.hidden = true; };
    const idxAt = (e) => {
      const r = sv.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W;
      return m.mark === "bar" ? Math.floor((px - mg.l) / band) : Math.round(((px - mg.l) / pw) * (n - 1));
    };
    sv.addEventListener("pointermove", (e) => show(idxAt(e)));
    sv.addEventListener("pointerleave", hide);
    el.onfocus = () => { let last = n - 1; while (last > 0 && !has(vals[last])) last--; show(cur ?? last); };
    el.onblur = hide;
    el.onkeydown = (e) => {
      const jump = e.shiftKey && !daily ? 24 : 1;
      const keys = { ArrowLeft: (cur ?? 0) - jump, ArrowRight: (cur ?? 0) + jump, Home: 0, End: n - 1 };
      if (e.key in keys) { show(keys[e.key]); e.preventDefault(); }
    };
  }

  function renderDetail() {
    const el = $("#detail"), s = state.sel && app.byKey.get(state.sel);
    if (!s) {
      el.innerHTML = `<p class="empty">${app.stations.length ? "No station matches. Clear the search or pick another status." : "Loading the station lists…"}</p>`;
      return;
    }
    const vars = varsOf(s);
    const chips = vars.filter((v) => app.series[v]).map((v) => {
      const r = rowOf(v, s.k);
      return r ? chip(r.status, `${VARS[v].label.toLowerCase()} ${pct(r.c)}`) : chip("pending", VARS[v].label.toLowerCase());
    }).join("");
    const notes = vars.flatMap((v) => (rowOf(v, s.k) ? rowOf(v, s.k).notes.map((t) => `${VARS[v].label}: ${t}`) : []));
    const t = typeOf(s);
    el.innerHTML = `
      <div>
        <span class="eyebrow"><i class="key ${t === "r" ? "small bg-r" : `bg-${t}`}"></i>${TYPE[t]} · ${esc(s.agency)}</span>
        <h2>${s.code && !s.name.includes(s.code) ? `<span class="mono">${esc(s.code)}</span>` : ""}${esc(s.name || s.code)}</h2>
        <p class="meta">${esc(s.prov)}${s.basin ? ` · ${esc(s.basin)}` : ""} · ${s.lat.toFixed(4)}, ${s.lon.toFixed(4)} · ThaiWater id ${esc(s.id)}</p>
        <div class="chips">${chips}</div>
        ${notes.length ? `<p class="meta" style="margin-top:8px">${notes.map(esc).join(" · ")}</p>` : ""}
      </div>
      ${vars.map((v) => {
        const r = rowOf(v, s.k);
        return `<div class="chart-block">
          <div class="chart-title">
            <h3>${VARS[v].label} <span class="unit">${VARS[v].unit}, ${VARS[v].step}</span></h3>
            <span class="tools">
              <span class="mini-legend"><span><i class="swatch-gap"></i>No reading</span>${r && r.spikes.length ? `<span><i class="key bg-check"></i>Possible spike</span>` : ""}</span>
              <button type="button" class="btn small" data-save="${v}" ${r && r.count ? "" : "disabled"}>Save CSV</button>
            </span>
          </div>
          <div class="chart" id="chart-${v}"></div>
        </div>`;
      }).join("")}`;
    vars.forEach((v) => chart($(`#chart-${v}`), v, s.k));
  }
  $("#detail").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-save]");
    if (b && state.sel) saveStation(b.dataset.save, state.sel);
  });

  // ---- heatmap ----------------------------------------------------------------------------
  const heat = $("#heat"), heatScroll = $("#heat-scroll"), heatTip = $("#heat-tip");
  const GUTTER = 10;
  let heatRows = [], heatRowH = 2;
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const rgb = (hex) => { const h = hex.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
  const RAIN_CLASSES = [
    { max: 0, stop: 0, label: "0" }, { max: 10, stop: 1, label: "Light 0.1–10" }, { max: 35, stop: 2, label: "Moderate 10.1–35" },
    { max: 90, stop: 4, label: "Heavy 35.1–90" }, { max: Infinity, stop: 5, label: "Very heavy > 90" },
  ];
  const byLatDesc = (a, b) => app.byKey.get(b).lat - app.byKey.get(a).lat;

  function renderHeatLegend() {
    const v = state.v, m = VARS[v], rain = m.kind === "r";
    if (rain) {
      $("#heat-legend").innerHTML = RAIN_CLASSES.map((c) => `<span><i class="sq" style="background:var(--seq${c.stop + 1})"></i>${c.label}</span>`).join("") +
        `<span><i class="sq blank"></i>No reading</span>`;
      $("#heat-note").textContent = "One row per gauge, north at the top, one column per day. Classes follow the Thai Meteorological Department's daily rainfall scale (mm/day). Hover for values, click a row to open the gauge.";
    } else {
      $("#heat-legend").innerHTML = `<span>Station's low</span><i class="ramp"></i><span>high</span><span><i class="sq blank"></i>No reading</span>`;
      $("#heat-note").textContent = `One row per station, north at the top, one column per hour. Each row is scaled to that station's own ${m.label.toLowerCase()} range, so a sudden dark or pale streak is a jump worth a look. Hover for values, click a row to open the station.`;
    }
    $("#heat-title").textContent = `Every ${rain ? "gauge" : "station"} over time · ${m.label}`;
  }
  function renderHeat() {
    const v = state.v, ser = series(v), width = heatScroll.clientWidth, plotW = Math.max(100, width - GUTTER);
    heatRows = ser ? keysFor(v).sort(byLatDesc) : [];
    heatRowH = Math.max(2, Math.min(16, Math.floor(560 / Math.max(1, heatRows.length))));
    const H = Math.max(heatRowH, heatRows.length * heatRowH), dpr = window.devicePixelRatio || 1;
    heat.width = Math.round(width * dpr); heat.height = Math.round(H * dpr);
    heat.style.width = `${width}px`; heat.style.height = `${H}px`;
    const ctx = heat.getContext("2d");
    ctx.clearRect(0, 0, heat.width, heat.height);
    $("#heat-axis").innerHTML = ser ? dayTicks(v).map(({ i, label: l }) =>
      `<span class="${i === 0 ? "first" : ""}" style="left:${(GUTTER + (i / ser.n) * plotW).toFixed(1)}px">${l}</span>`).join("") : "";
    if (!heatRows.length) return;
    const n = ser.n, stops = [1, 2, 3, 4, 5, 6].map((i) => rgb(css(`--seq${i}`)));
    const img = new ImageData(n, heatRows.length);
    const put = (p, c) => { img.data[p] = c[0]; img.data[p + 1] = c[1]; img.data[p + 2] = c[2]; img.data[p + 3] = 255; };
    heatRows.forEach((k, r) => {
      const row = rowOf(v, k);
      if (!row) return;
      const vals = row.v, lo = has(row.lo) ? row.lo : 0, span = (has(row.hi) ? row.hi : 1) - lo || 1;
      for (let i = 0; i < n; i++) {
        const val = vals[i];
        if (!has(val)) continue;
        const p = (r * n + i) * 4;
        if (VARS[v].kind === "r") { put(p, stops[RAIN_CLASSES.find((c) => val <= c.max).stop]); continue; }
        const t = Math.max(0, Math.min(1, (val - lo) / span)) * 5, j = Math.min(4, Math.floor(t)), f = t - j, a = stops[j], b = stops[j + 1];
        put(p, [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
      }
    });
    const off = document.createElement("canvas");
    off.width = n; off.height = heatRows.length;
    off.getContext("2d").putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, GUTTER * dpr, 0, plotW * dpr, H * dpr);
    const selIdx = heatRows.indexOf(state.sel);
    if (selIdx >= 0) {
      const yy = (selIdx * heatRowH + heatRowH / 2) * dpr;
      ctx.fillStyle = css("--fg");
      ctx.beginPath(); ctx.moveTo(dpr, yy - 5 * dpr); ctx.lineTo(8 * dpr, yy); ctx.lineTo(dpr, yy + 5 * dpr); ctx.closePath(); ctx.fill();
    }
  }
  const heatHit = (e) => {
    const ser = series(state.v);
    if (!ser) return null;
    const r = heat.getBoundingClientRect(), row = Math.floor((e.clientY - r.top) / heatRowH);
    const i = Math.floor(((e.clientX - r.left - GUTTER) / (r.width - GUTTER)) * ser.n);
    return row < 0 || row >= heatRows.length || i < 0 || i >= ser.n ? null : { k: heatRows[row], i };
  };
  heat.addEventListener("pointermove", (e) => {
    const h = heatHit(e);
    if (!h) { heatTip.hidden = true; return; }
    const s = app.byKey.get(h.k), row = rowOf(state.v, h.k), m = VARS[state.v], val = row ? row.v[h.i] : NaN;
    heatTip.innerHTML = `<b>${esc(label(s))}</b><div class="t-sub">${esc(s.prov)} · ${fmtTime(timeAt(state.v, h.i), state.v === "rain")}</div>` +
      `<div>${!row ? "Pending" : has(val) ? `<b>${fmtNum(val, m.dec)}</b> ${m.unit}` : "No reading"}</div>`;
    heatTip.hidden = false;
    const box = heatScroll.getBoundingClientRect();
    let x = e.clientX - box.left + 14;
    if (x + heatTip.offsetWidth > box.width - 4) x = e.clientX - box.left - heatTip.offsetWidth - 14;
    heatTip.style.left = `${Math.max(4, x)}px`;
    heatTip.style.top = `${e.clientY - box.top + heatScroll.scrollTop + 14}px`;
  });
  heat.addEventListener("pointerleave", () => { heatTip.hidden = true; });
  heat.addEventListener("click", (e) => { const h = heatHit(e); if (h) select(h.k, "heat"); });

  // ---- filters, table --------------------------------------------------------------------
  const matchesSearch = (s) => {
    if (!state.q) return true;
    const hay = `${s.code} ${s.name} ${s.prov} ${s.agency} ${s.id} ${s.basin}`.toLowerCase();
    return state.q.split(/\s+/).every((w) => hay.includes(w));
  };
  const keysFor = (v, { status = state.status, search = true } = {}) =>
    app.stations.filter((s) => inVar(s, v) && (status === "all" || statusOf(v, s.k) === status) && (!search || matchesSearch(s))).map((s) => s.k);
  function sortedForTable() {
    const v = state.v;
    return keysFor(v).sort((a, b) => {
      const ra = rowOf(v, a), rb = rowOf(v, b);
      return STATUS[statusOf(v, a)].rank - STATUS[statusOf(v, b)].rank || (ra ? ra.c : 1) - (rb ? rb.c : 1) ||
        app.byKey.get(a).code.localeCompare(app.byKey.get(b).code);
    });
  }
  function renderFilters() {
    $("#f-var").innerHTML = Object.entries(VARS).map(([k, m]) =>
      `<button type="button" data-v="${k}" aria-pressed="${state.v === k}">${m.label}<span class="count">${fmtInt(keysFor(k, { status: "all", search: false }).length)}</span></button>`).join("");
    const all = keysFor(state.v, { status: "all", search: false }), tally = { check: 0, sparse: 0, gaps: 0, ok: 0, pending: 0 };
    all.forEach((k) => tally[statusOf(state.v, k)]++);
    $("#f-status").innerHTML =
      `<button type="button" data-s="all" aria-pressed="${state.status === "all"}">All<span class="count">${fmtInt(all.length)}</span></button>` +
      ["check", "sparse", "gaps", "ok", "pending"].filter((s) => s !== "pending" || tally.pending || state.status === "pending").map((s) =>
        `<button type="button" data-s="${s}" aria-pressed="${state.status === s}" title="${STATUS[s].desc}">${ICON[s]}${STATUS[s].label}<span class="count">${fmtInt(tally[s])}</span></button>`).join("");
    $("#f-color").innerHTML = [["type", "Station type"], ["check", "Data check"]].map(([k, l]) =>
      `<button type="button" data-c="${k}" aria-pressed="${state.color === k}">${l}</button>`).join("");
    const saveBtn = $("#save-wide");
    saveBtn.querySelector("span").textContent = `Save ${VARS[state.v].label.toLowerCase()} CSV`;
    saveBtn.disabled = !all.some((k) => { const r = rowOf(state.v, k); return r && r.count; });
    $("#save-stations").disabled = !app.stations.length;
  }
  $("#f-var").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state.v = b.dataset.v;
    const sel = state.sel && app.byKey.get(state.sel);
    if (!sel || !inVar(sel, state.v)) state.sel = sortedForTable()[0] || state.sel;
    renderAll();
  });
  $("#f-status").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) { state.status = b.dataset.s; renderAll(); }
  });
  $("#f-color").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) { state.color = b.dataset.c; renderFilters(); updateMap(); renderMapLegend(); }
  });
  let searchTimer;
  $("#f-search").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.q = e.target.value.trim().toLowerCase(); renderHeat(); renderTable(); }, 150);
  });

  const tbody = $("#t-body");
  function renderTable() {
    const v = state.v, m = VARS[v], keys = sortedForTable(), rain = m.kind === "r";
    $("#table-title").textContent = `Station list · ${m.label}`;
    $("#table-note").textContent = `${fmtInt(keys.length)} ${rain ? "gauges" : "stations"}, flagged first. Click a row to open it.`;
    $("#t-head").innerHTML = `<tr><th>Status</th><th>Code</th><th>Name</th><th>Agency</th><th>Province</th><th class="num">Complete</th>` +
      `<th class="num">Min</th><th class="num">Max</th>${rain ? '<th class="num">Total</th>' : ""}<th>Notes</th></tr>`;
    tbody.innerHTML = keys.map((k) => {
      const s = app.byKey.get(k), r = rowOf(v, k);
      return `<tr data-k="${k}" tabindex="0" aria-selected="${k === state.sel}"><td>${chip(r ? r.status : "pending")}</td>` +
        `<td class="mono">${esc(s.code || s.id)}</td><td class="name">${esc(s.name)}</td><td>${esc(s.agency)}</td><td>${esc(s.prov)}</td>` +
        `<td class="num">${r ? pct(r.c) : "–"}</td><td class="num">${r ? fmtNum(r.min, m.dec) : "–"}</td><td class="num">${r ? fmtNum(r.max, m.dec) : "–"}</td>` +
        `${rain ? `<td class="num">${r && r.count ? fmtNum(r.sum, 1) : "–"}</td>` : ""}<td class="notes">${r ? esc(r.notes.join("; ")) : ""}</td></tr>`;
    }).join("") || `<tr><td colspan="10" class="empty">${app.stations.length ? "No station matches. Clear the search or pick another status." : "Loading the station lists…"}</td></tr>`;
  }
  tbody.addEventListener("click", (e) => { const tr = e.target.closest("tr[data-k]"); if (tr) select(tr.dataset.k, "table"); });
  tbody.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const tr = e.target.closest("tr[data-k]");
    if (tr) { e.preventDefault(); select(tr.dataset.k, "table"); }
  });
  function markTableSelection(scroll) {
    tbody.querySelectorAll('tr[aria-selected="true"]').forEach((tr) => tr.setAttribute("aria-selected", "false"));
    const tr = state.sel && tbody.querySelector(`tr[data-k="${state.sel}"]`);
    if (!tr) return;
    tr.setAttribute("aria-selected", "true");
    if (scroll) { const box = $("#table-scroll"); box.scrollTop = tr.offsetTop - box.clientHeight / 2; }
  }

  // ---- selection and render loop -----------------------------------------------------------
  function select(k, from) {
    const s = app.byKey.get(k);
    if (!s) return;
    state.sel = k;
    const prev = state.v;
    if (s.kind === "r" && VARS[state.v].kind !== "r") state.v = "rain";
    else if (s.kind === "w" && (VARS[state.v].kind !== "w" || (state.v === "q" && !rowOf("q", k)))) state.v = "wl";
    if (state.v !== prev) {
      renderAll(); markTableSelection(true);
      return;
    }
    updateMap(); renderDetail(); renderHeat(); markTableSelection(from !== "table");
  }
  function renderSubtitle() {
    const nW = app.stations.filter((s) => s.kind === "w").length, nR = app.stations.length - nW, ser = series("wl");
    $("#subtitle").textContent = `${fmtInt(nW)} water level stations (${fmtInt(series("q").rows.size)} also measure discharge) and ` +
      `${fmtInt(nR)} rain gauges inside the study area, from the ThaiWater network of the Hydro-Informatics Institute (HII). ` +
      `Period ${fmtTime(ser.t0, false)} to ${fmtTime(ser.t0 + (ser.n - 1) * HOUR, false)}, Thai time (UTC+7).`;
  }
  function renderAll() {
    renderSubtitle(); renderFilters(); renderMapLegend(); updateMap(); renderDetail(); renderHeatLegend(); renderHeat(); renderTable(); markTableSelection(false);
  }

  // ---- CSV export -------------------------------------------------------------------------
  const csvCell = (x) => (/[",\r\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x);
  const toCSV = (rows) => "﻿" + rows.map((r) => r.map((x) => csvCell(String(x))).join(",")).join("\r\n") + "\r\n";
  const valueCell = (x, dec) => (has(x) ? String(+x.toFixed(dec)) : "");
  const safe = (t) => String(t).replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
  function download(text, name) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
  }
  function saveWide() {
    const v = state.v, ser = series(v), m = VARS[v];
    const keys = sortedForTable().filter((k) => { const r = rowOf(v, k); return r && r.count; });
    if (!ser || !keys.length) return;
    const sts = keys.map((k) => app.byKey.get(k)), cols = keys.map((k) => rowOf(v, k).v);
    let last = ser.n - 1;
    while (last > 0 && !cols.some((c) => has(c[last]))) last--;
    const rows = [
      [String(keys.length), ...keys.map(() => "")],
      ["Station name", ...sts.map(label)],
      ["Variables", ...sts.map(() => m.csv)],
      ["lat", ...sts.map((s) => s.lat.toFixed(5))],
      ["lon", ...sts.map((s) => s.lon.toFixed(5))],
    ];
    for (let i = 0; i <= last; i++) rows.push([csvStamp(ser.t0 + i * ser.step * 60000), ...cols.map((c) => valueCell(c[i], m.dec))]);
    download(toCSV(rows), `thai-hydro-watch_${v}_${isoDate(ser.t0)}_${isoDate(ser.t0 + last * ser.step * 60000)}.csv`);
  }
  function saveStations() {
    const vars = Object.keys(VARS).filter((v) => series(v));
    const head = ["id", "code", "name", "agency", "province", "basin", "lat", "lon", "type"];
    vars.forEach((v) => head.push(`${v}_status`, `${v}_complete_pct`, `${v}_min`, `${v}_max`, `${v}_notes`));
    const rows = [head, ...app.stations.map((s) => {
      const out = [s.id, s.code, s.name, s.agency, s.prov, s.basin, s.lat.toFixed(5), s.lon.toFixed(5), TYPE[typeOf(s)]];
      vars.forEach((v) => {
        const r = inVar(s, v) || (v === "q" && s.kind === "w") ? rowOf(v, s.k) : null;
        if (!r) { out.push("", "", "", "", ""); return; }
        out.push(STATUS[r.status].label, Math.round(r.c * 100), valueCell(r.min, VARS[v].dec), valueCell(r.max, VARS[v].dec), r.notes.join("; "));
      });
      return out;
    })];
    download(toCSV(rows), `thai-hydro-watch_stations_${safe(app.aoi.name)}.csv`);
  }
  function saveStation(v, k) {
    const s = app.byKey.get(k), r = rowOf(v, k), ser = series(v), m = VARS[v];
    if (!s || !r || !ser) return;
    const rows = [["datetime", m.csv]];
    for (let i = 0; i < ser.n; i++) rows.push([csvStamp(ser.t0 + i * ser.step * 60000), valueCell(r.v[i], m.dec)]);
    download(toCSV(rows), `thai-hydro-watch_${v}_${safe(s.code || s.id)}_${isoDate(ser.t0)}.csv`);
  }
  $("#save-wide").addEventListener("click", saveWide);
  $("#save-stations").addEventListener("click", saveStations);

  // ---- the built-in area of interest (data/aoi.js) -------------------------------------------
  function setAOI(aoi) {
    const polys = polygonsOf(aoi.geojson);
    app.aoi = { name: aoi.name, geojson: aoi.geojson, polys, bounds: boundsOf(polys) };
    app.proj = makeProjection(app.aoi.bounds);
    buildBase();
    applyZoom();
  }

  // ---- start ----------------------------------------------------------------------------------
  function loadDataset(D) {
    app.stations = D.stations.map(([id, kind, code, name, agency, prov, basin, lat, lon]) => {
      const [x, y] = app.proj.xy(lon, lat);
      return { id, kind, k: kind + id, code, name, agency, prov, basin, lat, lon, x, y };
    });
    app.byKey = new Map(app.stations.map((s) => [s.k, s]));
    for (const v of ["wl", "q", "rain"]) {
      const src = D.series[v], ser = (app.series[v] = newSeries(parseStamp(src.t0), src.step, src.n));
      for (const [k, vals] of Object.entries(src.values)) ser.rows.set(k, summarise(v, Float32Array.from(vals, (x) => (x === null ? NaN : x))));
    }
    // A station with no readings at all still gets a row, so it shows as Sparse at 0%.
    app.stations.forEach((s) => {
      const ser = series(s.kind === "r" ? "rain" : "wl");
      if (!ser.rows.has(s.k)) ser.rows.set(s.k, summarise(s.kind === "r" ? "rain" : "wl", new Float32Array(ser.n).fill(NaN)));
    });
    const first = app.stations.find((s) => s.code === "C.2" && s.kind === "w") || app.stations.find((s) => s.kind === "w") || app.stations[0];
    state.sel = first ? first.k : null;
    const dl = $("#downloaded");
    if (dl) dl.textContent = fmtTime(parseStamp(D.downloaded), true);
    buildDots();
  }
  setAOI(window.DEFAULT_AOI);
  loadDataset(window.DATASET);
  renderAll();


  let raf = 0, lastW = 0;
  const onResize = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { applyZoom(); renderDetail(); renderHeat(); }); };
  if ("ResizeObserver" in window) {
    new ResizeObserver((entries) => {
      const w = Math.round(entries[0].contentRect.width);
      if (w !== lastW) { lastW = w; onResize(); }
    }).observe(document.body);
    new ResizeObserver(() => applyZoom()).observe(mapBox);
  } else window.addEventListener("resize", onResize);
  const rerenderTheme = () => requestAnimationFrame(renderHeat);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", rerenderTheme);
  new MutationObserver(rerenderTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
})();
