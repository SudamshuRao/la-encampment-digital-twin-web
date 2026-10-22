/* Tiny dependency-free SVG charts (bars, horizontal bars, line). */
(function (root) {
  "use strict";
  const RED = "#d73027", GREEN = "#1a9850", BLUE = "#2f6db5", INK = "#4a5568", GRID = "#e3e1d8";

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function pct(v, d, sign) {
    const s = (v * 100).toFixed(d == null ? 1 : d) + "%";
    return sign && v >= 0 ? "+" + s : s;
  }
  function niceTicks(lo, hi, n) {
    const span = hi - lo || 1, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag, step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const out = [];
    for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-12; t += step) out.push(Math.abs(t) < 1e-12 ? 0 : t);
    out.step = step;
    return out;
  }
  function tickDigits(step) { return step < 0.0099 ? 1 : 0; }
  function widthOf(el, fallback) { return Math.max(el.clientWidth || fallback, 300); }

  /** Vertical bars, one per item, red when >= 0 and green when < 0, sorted by caller. Hover for details. */
  function bars(el, items, opts) {
    opts = opts || {};
    const W = widthOf(el, 640), H = opts.height || 280, L = 56, R = 8, T = 10, B = 10;
    if (!items.length) { el.innerHTML = ""; return; }
    let lo = Math.min(0, ...items.map((d) => d.value)), hi = Math.max(0, ...items.map((d) => d.value));
    if (hi === lo) hi = lo + 1;
    const pad = (hi - lo) * 0.05; lo -= lo < 0 ? pad : 0; hi += pad;
    const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
    const bw = (W - L - R) / items.length;
    let g = "";
    const bt = niceTicks(lo, hi, 5), bd = tickDigits(bt.step);
    for (const t of bt) {
      g += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="${t === 0 ? "#9a9a92" : GRID}" stroke-width="1"/>`
        + `<text x="${L - 8}" y="${y(t) + 4}" text-anchor="end" font-size="12" fill="${INK}">${pct(t, bd)}</text>`;
    }
    items.forEach((d, i) => {
      const y0 = y(0), y1 = y(d.value), top = Math.min(y0, y1), h = Math.max(Math.abs(y1 - y0), 0.5);
      g += `<rect x="${L + i * bw + bw * 0.12}" y="${top}" width="${bw * 0.76}" height="${h}" fill="${d.value >= 0 ? RED : GREEN}">`
        + `<title>${esc(d.label)}: ${pct(d.value, 1, true)}</title></rect>`;
    });
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.aria || "Bar chart")}" style="width:100%;height:${H}px">${g}</svg>`;
  }

  /** Horizontal bars with labels (values are fractions, shown as %). */
  function hbars(el, items, opts) {
    opts = opts || {};
    if (!items.length) { el.innerHTML = ""; return; }
    const W = widthOf(el, 640), rowH = 34, labelW = Math.min(230, Math.round(W * 0.5)), R = 48, H = items.length * rowH + 8;
    const max = Math.max(...items.map((d) => d.value)) || 1;
    let g = "";
    items.forEach((d, i) => {
      const yy = 4 + i * rowH, w = (W - labelW - R) * (d.value / max);
      g += `<text x="${labelW - 10}" y="${yy + 22}" text-anchor="end" font-size="14" fill="#17263A">${esc(d.label)}</text>`
        + `<rect x="${labelW}" y="${yy + 6}" width="${Math.max(w, 1)}" height="${rowH - 12}" fill="${BLUE}" rx="2"><title>${esc(d.label)}: ${pct(d.value, 0)} of targeted hexes</title></rect>`
        + `<text x="${labelW + w + 8}" y="${yy + 22}" font-size="13" fill="${INK}">${pct(d.value, 0)}</text>`;
    });
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.aria || "Bar chart")}" style="width:100%;height:auto">${g}</svg>`;
  }

  /** Line of values over steps (0..n), y range hugs the data so small drops stay visible. */
  function line(el, values, opts) {
    opts = opts || {};
    const W = widthOf(el, 640), H = 240, L = 56, R = 16, T = 16, B = 30;
    let lo = Math.min(...values), hi = Math.max(...values);
    const pad = Math.max((hi - lo) * 0.25, 0.005); lo -= pad; hi += pad;
    const x = (i) => L + (W - L - R) * (values.length === 1 ? 0.5 : i / (values.length - 1));
    const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
    let g = "";
    const lt = niceTicks(lo, hi, 4), ld = lt.step < 0.0099 ? 1 : 0;
    for (const t of lt) {
      g += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="${GRID}"/>`
        + `<text x="${L - 8}" y="${y(t) + 4}" text-anchor="end" font-size="12" fill="${INK}">${pct(t, ld)}</text>`;
    }
    values.forEach((_, i) => {
      g += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="12" fill="${INK}">${i}</text>`;
    });
    g += `<polyline fill="none" stroke="#17263A" stroke-width="2.5" points="${values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}"/>`;
    values.forEach((v, i) => {
      g += `<circle cx="${x(i)}" cy="${y(v)}" r="4.5" fill="#17263A"><title>${i === 0 ? "Start" : "After step " + i}: ${pct(v, 2)}</title></circle>`;
    });
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.aria || "Vulnerability after each step")}" style="width:100%;height:auto">${g}</svg>`
      + `<div class="chart-cap">Step (0 = starting point)</div>`;
  }

  root.Charts = { bars, hbars, line, esc, pct };
})(window);
