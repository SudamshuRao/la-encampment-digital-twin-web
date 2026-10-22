/*
 * LA Encampment Vulnerability Digital Twin -- static (no-server) version.
 * Everything below runs in the browser: SNN-2 scoring on every slider move,
 * the greedy optimizer, and population scenarios (see snn.js).
 */
(function () {
  "use strict";

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = Charts.esc, pct = Charts.pct;

  const RISK_COLORS = ["#1a9850", "#fee08b", "#d73027"];
  const DELTA_COLORS = ["#d73027", "#f7f7f7", "#1a9850"];
  const TILES = {
    light: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    dark: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  };
  const ATTRIB = "Esri, HERE, Garmin, FAO, NOAA, USGS";
  const CAPTIONS = {
    actionable: "Greedy search over feasible +1 increments only (never decreases, never exceeds the 95th-percentile observed value). Safe to present as real intervention ideas.",
    exploratory: "⚠️ Allows +1 or -1 moves. A decrease (e.g. fewer libraries) isn't a feasible intervention either — this shows what the fitted surface says minimizes vulnerability mathematically within the non-frozen set, not a real-world action list.",
    combined: "Same non-frozen variable set and both directions as Unconstrained, but every step is tagged ✅ Feasible (an increase) or ⚠️ Infeasible (a decrease), with a separate re-scored 'feasible-only' vulnerability. A shared K budget means large decreases can crowd out feasible increases.",
  };

  const state = {
    meta: null, cache: {}, res: null, data: null, model: null, H: null,
    candidates: [], sel: 0, values: null, risk: 0, pred: null,
    basemap: "light", rmin: 0, rmax: 1, optResult: null, scen: null, whyDirty: true,
    map: null, tile: null, polys: [], hexLayer: null, legend: null, renderer: null, labelFor: null,
    deltaMap: null, deltaTile: null, deltaLayer: null, deltaLegend: null, tab: "scenarios",
  };

  // ---------- helpers ----------
  const label = (f) => state.meta.labels[f] || f;
  const interLabel = (a, b) => `${label(a)} × ${label(b)}`;
  const fmtVal = (v) => (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(2));
  const raf = (() => { let p = false, fn = null; return (f) => { fn = f; if (!p) { p = true; requestAnimationFrame(() => { p = false; fn(); }); } }; })();

  function hexRgb(h) { return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); }
  function lerpColor(colors, t) {
    t = Math.min(Math.max(t, 0), 1);
    const seg = t * (colors.length - 1), i = Math.min(Math.floor(seg), colors.length - 2), f = seg - i;
    const a = hexRgb(colors[i]), b = hexRgb(colors[i + 1]);
    return "#" + a.map((v, k) => Math.round(v + (b[k] - v) * f).toString(16).padStart(2, "0")).join("");
  }
  function riskColor(r) { return lerpColor(RISK_COLORS, state.rmax <= state.rmin ? 0 : (r - state.rmin) / (state.rmax - state.rmin)); }

  function deltaHtml(delta, suffix, digits) {
    const flat = Math.abs(delta) < 0.0005;
    const cls = flat ? "flat" : delta > 0 ? "up" : "down";
    const arrow = flat ? "" : delta > 0 ? "▲ " : "▼ ";
    return `<span class="${cls}">${arrow}${flat ? "0.0%" : pct(delta, digits == null ? 1 : digits, true)}${suffix ? " " + suffix : ""}</span>`;
  }

  // ---------- data loading ----------
  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
  }
  async function loadRes(res) {
    if (!state.cache[res]) {
      const d = await getJSON(`data/${res}.json`);
      state.cache[res] = { d, model: new SNN.Model(d.model) };
    }
    return state.cache[res];
  }

  // ---------- map ----------
  function ensureMap() {
    if (state.map) return;
    state.renderer = L.canvas({ padding: 0.5 });
    state.map = L.map("map", { zoomSnap: 0.25, renderer: state.renderer, attributionControl: true });
    state.tile = L.tileLayer(TILES[state.basemap], { attribution: ATTRIB, maxZoom: 16 }).addTo(state.map);
    addFullscreen(state.map, $("#map"));
  }

  function addFullscreen(map, el) {
    const C = L.Control.extend({
      options: { position: "topright" },
      onAdd() {
        const b = L.DomUtil.create("button", "leaflet-bar fs-btn");
        b.type = "button"; b.title = "Toggle fullscreen"; b.setAttribute("aria-label", "Toggle fullscreen map"); b.textContent = "⛶";
        L.DomEvent.disableClickPropagation(b);
        b.addEventListener("click", () => {
          if (document.fullscreenElement) document.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen();
        });
        return b;
      },
    });
    new C().addTo(map);
    document.addEventListener("fullscreenchange", () => setTimeout(() => map.invalidateSize(), 150));
  }

  function legendControl(caption, lo, mid, hi, colors, fmt) {
    const C = L.Control.extend({
      options: { position: "bottomleft" },
      onAdd() {
        const d = L.DomUtil.create("div", "legend");
        d.innerHTML = `<div class="lg-ticks"><span>${fmt(lo)}</span><span>${fmt(mid)}</span><span>${fmt(hi)}</span></div>`
          + `<div class="lg-bar" style="background:linear-gradient(to right, ${colors.join(", ")})"></div>`
          + `<div class="lg-cap">${esc(caption)}</div>`;
        return d;
      },
    });
    return new C();
  }

  function hexStyle(i) {
    const sel = i === state.sel, dark = state.basemap === "dark";
    return {
      fillColor: riskColor(sel ? state.risk : state.H.risk[i]),
      color: sel ? "#00e5ff" : dark ? "#ffffff" : "#4d4d4d",
      weight: sel ? 3.5 : 0.25, fillOpacity: sel ? 0.88 : 0.72, opacity: sel ? 1 : 0.35,
    };
  }

  function tipHtml(i) {
    const H = state.H, f = state.data.features;
    const r = i === state.sel ? state.risk : H.risk[i];
    const top = H.ia[i] >= 0 ? interLabel(f[H.ia[i]], f[H.ib[i]]) : "—";
    return `<b>Hex</b> ${esc(H.gid[i])}<br><b>Predicted vulnerability</b> ${pct(r, 1)}<br><b>Top interaction</b> ${esc(top)}`;
  }

  function buildMapLayers() {
    ensureMap();
    const H = state.H, map = state.map;
    if (state.hexLayer) map.removeLayer(state.hexLayer);
    if (state.legend) map.removeControl(state.legend);
    state.polys = [];
    const group = L.featureGroup();
    for (let i = 0; i < H.gid.length; i++) {
      const ring = state.data.geom[i][0].map(([lng, lat]) => [lat, lng]);
      const poly = L.polygon(ring, Object.assign({ renderer: state.renderer, smoothFactor: 0.5 }, hexStyle(i)));
      poly.bindTooltip(() => tipHtml(i), { sticky: true, className: "hex-tip" });
      poly.on("click", () => selectHex(i));
      poly.on("mouseover", () => { if (i !== state.sel) poly.setStyle({ weight: 2.5, color: "#00e5ff", opacity: 1 }); });
      poly.on("mouseout", () => poly.setStyle(hexStyle(i)));
      state.polys.push(poly);
      group.addLayer(poly);
    }
    state.hexLayer = group.addTo(map);
    state.legend = legendControl("Predicted encampment vulnerability", state.rmin, (state.rmin + state.rmax) / 2, state.rmax,
      RISK_COLORS, (v) => v.toFixed(2)).addTo(map);
    map.invalidateSize();
    map.fitBounds(group.getBounds(), { padding: [8, 8] });
    state.polys[state.sel].bringToFront();
  }

  function restyleAll() { state.polys.forEach((p, i) => p.setStyle(hexStyle(i))); state.polys[state.sel].bringToFront(); }
  function restyleOne(i) { state.polys[i].setStyle(hexStyle(i)); }

  function setBasemap(b) {
    state.basemap = b;
    if (state.tile) state.tile.setUrl(TILES[b]);
    if (state.deltaTile) state.deltaTile.setUrl(TILES[b]);
    if (state.polys.length) restyleAll();
    if (state.scen) renderDeltaMap();
  }

  // ---------- selection / compute ----------
  function selectHex(i) {
    const prev = state.sel;
    state.sel = i;
    state.values = Float64Array.from(state.H.X[i]);
    state.optResult = null;
    buildSliders();
    recompute();
    if (state.polys.length) { if (prev !== i) restyleOne(prev); restyleOne(i); state.polys[i].bringToFront(); }
    $("#hex-search").value = state.H.gid[i];
    $("#hex-search-msg").textContent = "";
    renderOptimizer();
  }

  function recompute() {
    const p = state.model.predict(state.values);
    state.pred = p; state.risk = p.risk;
    renderHeadline();
    state.whyDirty = true;
    if (state.tab === "why") renderWhy();
    if (state.polys.length) raf(() => restyleOne(state.sel));
  }

  function renderHeadline() {
    const H = state.H, i = state.sel, p = state.pred, f = state.data.features;
    $("#hex-title").textContent = `Hex ${H.gid[i]}`;
    $("#centroid-note").textContent = "Centroid: " + (H.detected[i] ? "actual (averaged detection points)" : "reconstructed (no detections in this hex)");
    const base = H.risk[i];
    $("#m-pred").textContent = pct(p.risk, 1);
    $("#m-delta").innerHTML = deltaHtml(p.risk - base, "vs. real values");
    $("#m-base").textContent = pct(base, 1);

    let iu = 0, id = 0;
    p.inter.forEach((v, k) => { if (v > p.inter[iu]) iu = k; if (v < p.inter[id]) id = k; });
    const pairs = state.model.pairs;
    const up = $("#box-up"), down = $("#box-down");
    if (p.inter.length && p.inter[iu] > 0) {
      up.hidden = false;
      up.innerHTML = `<b>Top interaction increasing vulnerability:</b><p>${esc(interLabel(pairs[iu][0], pairs[iu][1]))}</p><p>raising vulnerability by ${pct(p.inter[iu], 1)} (contribution)</p>`;
    } else up.hidden = true;
    if (p.inter.length && p.inter[id] < 0) {
      down.hidden = false;
      down.innerHTML = `<b>Top interaction lowering vulnerability:</b><p>${esc(interLabel(pairs[id][0], pairs[id][1]))}</p><p>lowering vulnerability by ${pct(Math.abs(p.inter[id]), 1)} (contribution)</p>`;
    } else down.hidden = true;
  }

  // ---------- sliders ----------
  function buildSliders() {
    const root = $("#sliders"), m = state.meta, d = state.data, H = state.H;
    root.innerHTML = "";
    for (const group of m.groupOrder) {
      const feats = d.features.filter((f) => m.groups[f] === group && d.summary[f]);
      if (!feats.length) continue;
      const det = document.createElement("details");
      det.open = group === "Facilities / Services";
      det.innerHTML = `<summary>${esc(group)} (${feats.length})</summary><div class="slider-grid"></div>`;
      const grid = det.querySelector(".slider-grid");
      for (const f of feats) {
        const j = d.features.indexOf(f);
        let [lo, hi, mn, mx] = d.summary[f];
        if (hi <= lo) { lo = mn; hi = mx; }
        if (hi <= lo) hi = lo + 1;
        const step = Math.max((hi - lo) / 100, 0.01);
        const real = H.X[state.sel][j];
        const row = document.createElement("label");
        row.className = "slider-row";
        row.innerHTML = `<span class="lbl">${esc(label(f))}</span><output></output>`
          + `<input type="range" min="${Math.min(lo, real)}" max="${Math.max(hi, real)}" step="${step}" data-j="${j}">`;
        const input = row.querySelector("input");
        input.value = state.values[j];
        input.addEventListener("input", () => {
          state.values[j] = Number(input.value);
          row.querySelector("output").textContent = fmtVal(state.values[j]);
          raf(recompute);
        });
        grid.appendChild(row);
      }
      root.appendChild(det);
    }
    syncSliders();
  }

  function syncSliders() {
    $$("#sliders input[type=range]").forEach((inp) => {
      const j = Number(inp.dataset.j);
      inp.value = state.values[j];
      inp.parentElement.querySelector("output").textContent = fmtVal(state.values[j]);
    });
  }

  function setValues(arr) {
    state.values = Float64Array.from(arr);
    state.optResult = null;
    syncSliders();
    recompute();
    renderOptimizer();
  }

  // ---------- why this score ----------
  function topList(ranked, title) {
    const rows = ranked.map(([l, v]) => {
      const c = v >= 0 ? "#d73027" : "#1a9850", a = v >= 0 ? "▲" : "▼";
      return `<div style="color:${c}">${a} ${esc(l)}: <b>${pct(v, 1, true)}</b></div>`;
    }).join("");
    return `<p><b>${title}</b></p>${rows || '<div class="muted">None</div>'}`;
  }

  function renderWhy() {
    state.whyDirty = false;
    const d = state.data, p = state.pred, pairs = state.model.pairs;
    const main = d.features.map((f, j) => [label(f), p.main[j]]);
    const mainRanked = main.slice().sort((a, b) => b[1] - a[1]);
    $("#main-inc").innerHTML = topList(mainRanked.filter((x) => x[1] > 0).slice(0, 5), "Top 5 increasing vulnerability");
    $("#main-dec").innerHTML = topList(mainRanked.slice().reverse().filter((x) => x[1] < 0).slice(0, 5), "Top 5 decreasing vulnerability");
    Charts.bars($("#main-chart"), main.slice().sort((a, b) => a[1] - b[1]).map(([l, v]) => ({ label: l, value: v })),
      { aria: "Main-effect contributions by feature" });

    const inter = pairs.map(([a, b], k) => [interLabel(a, b), p.inter[k]]);
    const interRanked = inter.slice().sort((a, b) => b[1] - a[1]);
    $("#int-inc").innerHTML = topList(interRanked.filter((x) => x[1] > 0).slice(0, 5), "Top 5 increasing vulnerability");
    $("#int-dec").innerHTML = topList(interRanked.slice().reverse().filter((x) => x[1] < 0).slice(0, 5), "Top 5 decreasing vulnerability");
    Charts.bars($("#int-chart"), inter.slice().sort((a, b) => a[1] - b[1]).map(([l, v]) => ({ label: l, value: v })),
      { aria: "Interaction contributions by pair" });
  }

  // ---------- optimizer ----------
  function optMode() { return $("input[name=optmode]:checked").value; }

  function candidateBounds(mode) {
    const b = {}, s = state.data.summary;
    state.candidates.forEach((f) => { b[f] = mode === "actionable" ? [0, s[f][1]] : [s[f][0], s[f][1]]; });
    return b;
  }

  function runOptimizer() {
    const mode = optMode(), k = Number($("#opt-k").value);
    const res = SNN.greedyOptimize(state.model, state.values, state.candidates, candidateBounds(mode), k, mode !== "actionable");
    res.mode = mode;
    if (mode === "combined") {
      const sub = SNN.actionableSubsetRisk(state.model, state.values, res.steps, state.meta.groups, state.meta.actionableGroups);
      res.subsetRisk = sub.risk; res.subsetSteps = sub.applied;
    }
    state.optResult = res;
    renderOptimizer();
  }

  function metric(labelTxt, value, deltaTxt) {
    return `<div class="metric"><div class="m-label">${labelTxt}</div><div class="m-value">${value}</div>${deltaTxt ? `<div class="m-delta">${deltaTxt}</div>` : ""}</div>`;
  }

  function renderOptimizer() {
    $("#opt-caption").textContent = CAPTIONS[optMode()];
    const out = $("#opt-result"), r = state.optResult;
    if (!r) { out.innerHTML = ""; return; }
    if (!r.steps.length) { out.innerHTML = `<div class="info">No available move reduces vulnerability further from the current slider values.</div>`; return; }
    const g = state.meta.groups, ag = state.meta.actionableGroups, f = state.meta.labels;
    const arrow = { up: "↑", down: "↓" };
    const row = (s, withTag) => `<tr>${withTag ? `<td>${SNN.isActionableStep(s.feature, s.direction, g, ag) ? "✅ Feasible" : "⚠️ Infeasible"}</td>` : ""}`
      + `<td>${arrow[s.direction]} ${esc(f[s.feature] || s.feature)}</td><td class="num">${s.to_value.toFixed(1)}</td>`
      + `<td class="num">${pct(s.risk_after, 1)}</td><td class="num">${pct(s.risk_delta, 2, true)}</td></tr>`;
    const head = (withTag) => `<thead><tr>${withTag ? "<th>Tag</th>" : ""}<th>Intervention</th><th class="num">New value</th><th class="num">Vulnerability after</th><th class="num">Change</th></tr></thead>`;
    const combined = r.mode === "combined";
    let html = "";
    if (combined) {
      html += `<div class="metrics two-m">`
        + metric("Full optimized vulnerability", pct(r.optimized_risk, 1), deltaHtml(r.optimized_risk - r.baseline_risk))
        + metric("Feasible-only achievable", pct(r.subsetRisk, 1), deltaHtml(r.subsetRisk - r.baseline_risk, `(${r.subsetSteps.length} real action(s))`))
        + `</div>`;
    } else {
      html += `<div class="metrics two-m">` + metric("Optimized vulnerability", pct(r.optimized_risk, 1),
        deltaHtml(r.optimized_risk - r.baseline_risk, `over ${r.steps.length} step(s)`)) + `</div>`;
    }
    html += `<div class="table-wrap"><table class="steps">${head(combined)}<tbody>${r.steps.map((s) => row(s, combined)).join("")}</tbody></table></div>`;
    html += `<div id="opt-line" class="chart"></div>`;
    if (r.mode === "exploratory") html += `<p class="muted small">⚠️ May include decreases — see mode note above.</p>`;
    if (combined) html += `<div class="btn-row"><button class="btn" id="apply-all">Apply all to sliders</button><button class="btn" id="apply-feas">Apply feasible-only to sliders</button></div>`;
    else html += `<div class="btn-row"><button class="btn" id="apply-all">Apply optimized values to sliders</button></div>`;
    out.innerHTML = html;
    Charts.line($("#opt-line"), r.risk_trajectory, { aria: "Predicted vulnerability after each optimizer step" });
    $("#apply-all").addEventListener("click", () => setValues(r.optimized_features));
    const fb = $("#apply-feas");
    if (fb) fb.addEventListener("click", () => {
      const u = Array.from(state.values);
      r.subsetSteps.forEach((s) => { u[state.model.index[s.feature]] = s.to_value; });
      setValues(u);
    });
  }

  // ---------- scenarios ----------
  function runScenarios() {
    const topPct = Number($("#scen-pct").value) / 100, k = Number($("#scen-k").value);
    const n = Math.round(topPct * state.H.risk.length);
    $("#scen-status").textContent = `Optimizing ~${n} hexes…`;
    $("#btn-scen").disabled = true;
    setTimeout(() => {
      const bounds = candidateBounds("actionable");
      const t0 = performance.now();
      state.scen = SNN.runPopulation(state.model, state.H, topPct, state.candidates, bounds, k);
      $("#scen-status").textContent = `Done in ${Math.max(1, Math.round(performance.now() - t0))} ms.`;
      $("#btn-scen").disabled = false;
      renderScenarios();
    }, 30);
  }

  function renderScenarios() {
    const s = state.scen;
    $("#scen-result").hidden = !s;
    if (!s) return;
    const sm = s.summary;
    $("#sm-n").textContent = sm.n_hexes_targeted;
    $("#sm-base").textContent = pct(sm.mean_baseline_risk_targeted, 1);
    $("#sm-opt").textContent = pct(sm.mean_optimized_risk_targeted, 1);
    $("#sm-delta").innerHTML = deltaHtml(-sm.mean_reduction_targeted, "", 2);
    const items = s.usage.map((u) => ({ label: label(u.feature), value: u.pct }));
    $("#usage-empty").hidden = items.length > 0;
    Charts.hbars($("#usage-chart"), items, { aria: "Share of targeted hexes where each variable was recommended" });
    renderDeltaMap();
  }

  function renderDeltaMap() {
    const s = state.scen;
    if (!s || $("#panel-scenarios").hidden) return;
    if (!state.deltaMap) {
      state.deltaMap = L.map("delta-map", { zoomSnap: 0.25, renderer: L.canvas({ padding: 0.5 }) });
      state.deltaTile = L.tileLayer(TILES[state.basemap], { attribution: ATTRIB, maxZoom: 16 }).addTo(state.deltaMap);
      addFullscreen(state.deltaMap, $("#delta-map"));
    }
    const map = state.deltaMap;
    if (state.deltaLayer) map.removeLayer(state.deltaLayer);
    if (state.deltaLegend) map.removeControl(state.deltaLegend);
    const delta = s.delta, maxAbs = Math.max(Math.max(...delta.map(Math.abs)), 1e-6);
    const dark = state.basemap === "dark", group = L.featureGroup(), H = state.H;
    for (let i = 0; i < H.gid.length; i++) {
      const t = s.isTarget[i];
      const poly = L.polygon(state.data.geom[i][0].map(([lng, lat]) => [lat, lng]), {
        fillColor: lerpColor(DELTA_COLORS, (delta[i] + maxAbs) / (2 * maxAbs)),
        color: dark ? "#ffffff" : "#4d4d4d", weight: t ? 1.2 : 0.15, fillOpacity: t ? 0.85 : 0.35, opacity: t ? 0.6 : 0.2,
        renderer: map.options.renderer, smoothFactor: 0.5,
      });
      poly.bindTooltip(`<b>Hex</b> ${esc(H.gid[i])}<br><b>ΔVulnerability (+ = improved)</b> ${pct(delta[i], 1)}`, { sticky: true, className: "hex-tip" });
      group.addLayer(poly);
    }
    state.deltaLayer = group.addTo(map);
    state.deltaLegend = legendControl("ΔVulnerability from population optimization (bold outline = targeted hex)",
      -maxAbs, 0, maxAbs, DELTA_COLORS, (v) => v.toFixed(3)).addTo(map);
    map.invalidateSize();
    map.fitBounds(group.getBounds(), { padding: [8, 8] });
  }

  // ---------- resolution switching ----------
  async function setResolution(res) {
    $("#loading").hidden = false; $("#loading").textContent = "Loading model and map…";
    const { d, model } = await loadRes(res);
    state.res = res; state.data = d; state.model = model; state.H = d.hexes;
    state.rmin = SNN.quantile(d.hexes.risk, 0.05); state.rmax = SNN.quantile(d.hexes.risk, 0.95);
    const m = state.meta;
    state.candidates = model.features.filter((f) => m.actionableGroups.includes(m.groups[f]) && d.summary[f]);
    $("#scen-eligible").textContent = `Eligible scenario-input variables (${state.candidates.length}): ` + state.candidates.map(label).join(", ");
    $("#hex-list").innerHTML = d.hexes.gid.slice().sort().map((g) => `<option value="${esc(g)}"></option>`).join("");
    let best = 0;
    d.hexes.risk.forEach((r, i) => { if (r > d.hexes.risk[best]) best = i; });
    state.sel = best; state.scen = null; state.optResult = null; state.values = Float64Array.from(d.hexes.X[best]);
    state.pred = model.predict(state.values); state.risk = state.pred.risk;
    $("#app").hidden = false; $("#loading").hidden = true;
    buildMapLayers();
    selectHex(best);
    renderScenarios();
    if (state.deltaLayer && state.deltaMap) { state.deltaMap.removeLayer(state.deltaLayer); state.deltaLayer = null; }
    $("#scen-status").textContent = "";
  }

  // ---------- tabs ----------
  const TABS = ["scenarios", "sliders", "why", "opt"];
  function showTab(name, focus) {
    state.tab = name;
    TABS.forEach((t) => {
      const on = t === name, btn = $("#tab-" + t);
      btn.setAttribute("aria-selected", on); btn.tabIndex = on ? 0 : -1;
      $("#panel-" + t).hidden = !on;
      if (on && focus) btn.focus();
    });
    if (name === "why") renderWhy();
    if (name === "scenarios") { if (state.scen) { renderDeltaMap(); redrawCharts(); } }
    if (name === "opt") redrawCharts();
  }

  // ---------- wiring ----------
  let resizeTimer = null;
  function redrawCharts() {
    if (!state.data) return;
    if (state.tab === "why") renderWhy();
    if (state.optResult && state.optResult.steps.length) Charts.line($("#opt-line"), state.optResult.risk_trajectory, { aria: "Predicted vulnerability after each optimizer step" });
    if (state.scen) {
      const items = state.scen.usage.map((u) => ({ label: label(u.feature), value: u.pct }));
      Charts.hbars($("#usage-chart"), items, { aria: "Share of targeted hexes where each variable was recommended" });
    }
  }

  function wire() {
    window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(redrawCharts, 150); });
    const m = state.meta;
    $("#res-radios").innerHTML = m.resolutions.map((r, i) =>
      `<label><input type="radio" name="res" value="${r.key}" ${i === 0 ? "checked" : ""}> ${esc(r.label)}</label>`).join("");
    $$("input[name=res]").forEach((r) => r.addEventListener("change", () => setResolution(r.value)));
    $$("input[name=basemap]").forEach((r) => r.addEventListener("change", () => setBasemap(r.value)));

    const search = $("#hex-search");
    const go = () => {
      const v = search.value.trim().toUpperCase();
      if (!v) return;
      const i = state.H.gid.findIndex((g) => g.toUpperCase() === v);
      if (i >= 0) { selectHex(i); const c = state.polys[i].getBounds().getCenter(); state.map.panTo(c); }
      else $("#hex-search-msg").textContent = `No hex "${search.value.trim()}" at this resolution.`;
    };
    search.addEventListener("change", go);
    search.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });

    $("#btn-reset").addEventListener("click", () => setValues(state.H.X[state.sel]));
    $("#btn-opt").addEventListener("click", runOptimizer);
    $("#btn-scen").addEventListener("click", runScenarios);
    $$("input[name=optmode]").forEach((r) => r.addEventListener("change", () => { state.optResult = null; renderOptimizer(); }));
    $("#opt-k").addEventListener("input", (e) => { $("#opt-k-out").textContent = e.target.value; });
    $("#scen-k").addEventListener("input", (e) => { $("#scen-k-out").textContent = e.target.value; });
    $("#scen-pct").addEventListener("input", (e) => { $("#scen-pct-out").textContent = e.target.value; });

    TABS.forEach((t, idx) => {
      const b = $("#tab-" + t);
      b.addEventListener("click", () => showTab(t));
      b.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight") { e.preventDefault(); showTab(TABS[(idx + 1) % TABS.length], true); }
        if (e.key === "ArrowLeft") { e.preventDefault(); showTab(TABS[(idx + TABS.length - 1) % TABS.length], true); }
      });
    });
  }

  async function init() {
    try {
      state.meta = await getJSON("data/meta.json");
      wire();
      await setResolution(state.meta.resolutions[0].key);
    } catch (err) {
      console.error(err);
      $("#loading").hidden = false;
      $("#loading").textContent = "Could not load the model data. If you opened this file directly from disk, serve the folder over http (e.g. python3 -m http.server) or use the deployed site.";
    }
  }
  init();
})();
