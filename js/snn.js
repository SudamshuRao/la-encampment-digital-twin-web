/*
 * SNN-2 inference, greedy optimizer and population scenarios -- a line-for-line
 * JavaScript port of scripts/snn2_inference.py, optimizer2.py and scenarios.py.
 * Runs unchanged in the browser (window.SNN) and in Node (module.exports), which
 * is how it is checked against the Python implementation.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SNN = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function sigmoid(z) {
    if (z > 30) z = 30; else if (z < -30) z = -30;
    return 1 / (1 + Math.exp(-z));
  }

  class Model {
    constructor(art) {
      this.features = art.base_features;
      this.pairs = art.interaction_pairs;
      this.pairNames = this.pairs.map(([a, b]) => `${a}__x__${b}`);
      this.mean = Float64Array.from(art.scaler_base_mean);
      this.scale = Float64Array.from(art.scaler_base_scale);
      this.mainNets = art.main_nets.map((n) => ({
        centers: Float64Array.from(n.centers), width: n.width, coef: Float64Array.from(n.coef),
      }));
      this.pairNets = art.pair_nets.map((n) => ({
        cj: Float64Array.from(n.cj), ck: Float64Array.from(n.ck),
        width: n.width, coef: Float64Array.from(n.coef),
      }));
      this.index = {};
      this.features.forEach((f, i) => { this.index[f] = i; });
      this.pairIdx = this.pairs.map(([a, b]) => [this.index[a], this.index[b]]);
    }

    _main(j, s) {
      const net = this.mainNets[j], c = net.centers, w = net.width, coef = net.coef;
      let t = coef[0];
      for (let i = 0; i < c.length; i++) { const d = s - c[i]; t += coef[i + 1] * Math.exp(-w * d * d); }
      return t;
    }

    _pair(p, sj, sk) {
      const net = this.pairNets[p], cj = net.cj, ck = net.ck, w = net.width, coef = net.coef;
      let t = coef[0];
      for (let i = 0; i < cj.length; i++) {
        const dj = sj - cj[i], dk = sk - ck[i];
        t += coef[i + 1] * (Math.exp(-w * dj * dj) * Math.exp(-w * dk * dk));
      }
      return t;
    }

    /** Fast path: x is an array aligned to model.features. Returns risk only. */
    risk(x) {
      const n = this.features.length, std = new Float64Array(n);
      for (let j = 0; j < n; j++) std[j] = (x[j] - this.mean[j]) / this.scale[j];
      let total = 0;
      for (let j = 0; j < n; j++) total += this._main(j, std[j]);
      for (let p = 0; p < this.pairIdx.length; p++) {
        total += this._pair(p, std[this.pairIdx[p][0]], std[this.pairIdx[p][1]]);
      }
      return sigmoid(total);
    }

    /** Full path: returns {risk, main:[...per feature], inter:[...per pair]}. */
    predict(x) {
      const n = this.features.length, std = new Float64Array(n);
      for (let j = 0; j < n; j++) std[j] = (x[j] - this.mean[j]) / this.scale[j];
      const main = new Array(n);
      let total = 0;
      for (let j = 0; j < n; j++) { main[j] = this._main(j, std[j]); total += main[j]; }
      const inter = new Array(this.pairIdx.length);
      for (let p = 0; p < this.pairIdx.length; p++) {
        inter[p] = this._pair(p, std[this.pairIdx[p][0]], std[this.pairIdx[p][1]]);
        total += inter[p];
      }
      return { risk: sigmoid(total), main, inter };
    }
  }

  /**
   * Greedy optimizer (port of optimizer2.greedy_optimize_snn2).
   * values: array aligned to model.features. candidates: feature names, in
   * model order. bounds: {feature: [lo, hi]}.
   */
  function greedyOptimize(model, values, candidates, bounds, k, allowDecrease, stepSize) {
    k = k == null ? 5 : k;
    stepSize = stepSize == null ? 1.0 : stepSize;
    const vals = Array.from(values);
    const baseline = model.risk(vals);
    const trajectory = [baseline];
    const steps = [];
    const cand = candidates.map((f) => ({ f, i: model.index[f], lo: bounds[f][0], hi: bounds[f][1] }));

    for (let it = 0; it < k; it++) {
      let best = null, bestVal = null, bestRisk = trajectory[trajectory.length - 1], bestDir = null;
      for (const c of cand) {
        const cur = vals[c.i];
        const trials = [["up", cur + stepSize, c.hi, "hi"]];
        if (allowDecrease) trials.push(["down", cur - stepSize, c.lo, "lo"]);
        for (const [dir, nv, limit, kind] of trials) {
          if (kind === "hi" && nv > limit) continue;
          if (kind === "lo" && nv < limit) continue;
          vals[c.i] = nv;
          const r = model.risk(vals);
          vals[c.i] = cur;
          if (r < bestRisk) { bestRisk = r; best = c; bestVal = nv; bestDir = dir; }
        }
      }
      if (best === null) break;
      const old = vals[best.i];
      vals[best.i] = bestVal;
      const before = trajectory[trajectory.length - 1];
      steps.push({
        feature: best.f, direction: bestDir, from_value: old, to_value: bestVal,
        risk_before: before, risk_after: bestRisk, risk_delta: bestRisk - before,
      });
      trajectory.push(bestRisk);
    }
    return {
      baseline_risk: baseline, optimized_risk: trajectory[trajectory.length - 1],
      optimized_features: vals, steps, risk_trajectory: trajectory,
    };
  }

  function isActionableStep(feature, direction, groups, actionableGroups) {
    return actionableGroups.indexOf(groups[feature]) !== -1 && direction === "up";
  }

  /** Port of optimizer2.actionable_subset_risk_l2. */
  function actionableSubsetRisk(model, baseValues, steps, groups, actionableGroups) {
    const vals = Array.from(baseValues);
    const applied = [];
    for (const s of steps) {
      if (isActionableStep(s.feature, s.direction, groups, actionableGroups)) {
        vals[model.index[s.feature]] = s.to_value;
        applied.push(s);
      }
    }
    return { risk: model.risk(vals), applied };
  }

  /** numpy/pandas 'linear' quantile. */
  function quantile(arr, q) {
    const s = Array.from(arr).sort((a, b) => a - b);
    const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }

  /**
   * Port of scenarios.run_population_optimization (feasible-only, increase
   * moves). hexes: {risk:[...], X:[[...]...]}. Returns per-hex deltas plus the
   * summary and variable-usage tables.
   */
  function runPopulation(model, hexes, topPct, candidates, bounds, k, onProgress) {
    const n = hexes.risk.length;
    const thresh = quantile(hexes.risk, 1 - topPct);
    const isTarget = hexes.risk.map((r) => r >= thresh);
    const delta = new Float64Array(n);
    const usage = {};
    candidates.forEach((f) => { usage[f] = 0; });
    let nT = 0, sumBase = 0, sumOpt = 0, sumDelta = 0;
    for (let h = 0; h < n; h++) {
      if (!isTarget[h]) continue;
      const res = greedyOptimize(model, hexes.X[h], candidates, bounds, k, false);
      for (const s of res.steps) usage[s.feature] += 1;
      delta[h] = res.baseline_risk - res.optimized_risk;
      nT += 1; sumBase += res.baseline_risk; sumOpt += res.optimized_risk; sumDelta += delta[h];
    }
    const summary = {
      n_hexes_targeted: nT,
      mean_baseline_risk_targeted: nT ? sumBase / nT : 0,
      mean_optimized_risk_targeted: nT ? sumOpt / nT : 0,
      mean_reduction_targeted: nT ? sumDelta / nT : 0,
    };
    const nTar = Math.max(nT, 1);
    const usageRows = Object.keys(usage)
      .filter((f) => usage[f] > 0)
      .map((f) => ({ feature: f, times: usage[f], pct: usage[f] / nTar }))
      .sort((a, b) => b.times - a.times);
    return { delta, isTarget, summary, usage: usageRows };
  }

  return { Model, sigmoid, greedyOptimize, isActionableStep, actionableSubsetRisk, quantile, runPopulation };
});
