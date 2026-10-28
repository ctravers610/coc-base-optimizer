/* Clash Base Optimizer — layout engine.
   Pure JS, no DOM. Runs in a Web Worker (optimize) and on the main thread (evaluate).
   Grid: 44x44 buildable tiles. Walls form a grid of rectangular compartments ("skeleton");
   building positions are optimized with simulated annealing against a defensive cost function. */
function createOptimizer() {
  'use strict';
  const G = 44;
  const CENTER = G / 2;

  function rngFactory(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // Minimum spacing (tiles, center to center) between two defenses of the same kind.
  const SPACING = {
    'air-defense': 8, 'inferno-tower': 7, 'x-bow': 6, 'scattershot': 9, 'wizard-tower': 5, 'mortar': 6,
    'hidden-tesla': 4, 'air-sweeper': 10, 'cannon': 4, 'archer-tower': 4, 'bomb-tower': 6,
    'multi-archer-tower': 6, 'ricochet-cannon': 6, 'firespitter': 8, 'spell-tower': 6, 'super-wizard-tower': 7,
    'builders-hut': 4,
  };
  const WEIGHTS = { coverage: 100, centrality: 40, depth: 30, spacing: 30, compartments: 15, splash: 15, outside: 25, sweeper: 8 };
  const DEMOTE_ORDER = ['hero', 'hut', 'support', 'storage', 'splash', 'defense', 'air', 'sweeper', 'key'];

  function priority(item, mode) {
    switch (item.role) {
      case 'th': return mode === 'war' ? 3 : mode === 'farm' ? 1 : 2;
      case 'cc': return 3;
      case 'storage': return mode === 'war' ? 0.5 : mode === 'farm' ? 2.5 : 1.5;
      case 'key': return 1.2;
      case 'air': return 1.0;
      case 'support': return 0.8;
      case 'hero': return 0.6;
      case 'sweeper': return 0.3;
      default: return 0;
    }
  }
  function dminOf(item, mode) {
    switch (item.role) {
      case 'cc': return 2;
      case 'th': return mode === 'farm' ? 1 : 2;
      case 'air': return 1;
      case 'key': return 1;
      case 'storage': return mode === 'war' ? 0 : 1;
      case 'support': return 1;
      default: return 0;
    }
  }
  function isCore(item, mode) {
    return item.role === 'th' || item.role === 'cc' || item.role === 'key' || (item.role === 'storage' && mode !== 'war');
  }

  // ---------- Wall skeleton: symmetric grid of compartments ----------
  function skeletons(needArea, wallBudget, maxBox, n4) {
    const vals = [3, 4, 5, 6, 7, 8, 9];
    function gen(n) {
      const out = [], half = Math.ceil(n / 2);
      const rec = (arr) => {
        if (arr.length === half) { out.push(arr.concat(arr.slice(0, n - half).reverse())); return; }
        for (const v of vals) rec(arr.concat(v));
      };
      rec([]);
      return out;
    }
    const byLen = {};
    for (let n = 1; n <= 5; n++) byLen[n] = gen(n);
    const cands = [];
    for (let n = 1; n <= 5; n++) for (let m = 1; m <= 5; m++) {
      for (const W of byLen[n]) {
        const sw = W.reduce((a, b) => a + b, 0), tw = sw + n + 1;
        if (tw > maxBox) continue;
        for (const H of byLen[m]) {
          const sh = H.reduce((a, b) => a + b, 0), th = sh + m + 1;
          if (th > maxBox) continue;
          const walls = tw * th - sw * sh;
          if (walls > wallBudget) continue;
          const interior = sw * sh, slack = interior / Math.max(1, needArea);
          if (slack < 1.35 || slack > 2.6) continue;
          let big = 0;
          for (const w of W) for (const h of H) if (w >= 4 && h >= 4) big++;
          if (big < n4) continue;
          const usage = walls / wallBudget;
          let score = n * m - Math.abs(slack - 1.7) * 4 - (1 - usage) * 8 - Math.abs(tw - th) * 0.3;
          for (const w of W) for (const h of H) if (w * h > 56) score -= 0.5;
          cands.push({ W, H, n, m, tw, th, walls, interior, slack, score });
        }
      }
    }
    cands.sort((a, b) => b.score - a.score);
    return cands;
  }

  function buildBox(skel) {
    const x0 = Math.floor((G - skel.tw) / 2), y0 = Math.floor((G - skel.th) / 2);
    let cells = [];
    let cy = y0 + 1;
    for (const h of skel.H) {
      let cx = x0 + 1;
      for (const w of skel.W) { cells.push({ x0: cx, y0: cy, w, h }); cx += w + 1; }
      cy += h + 1;
    }
    // splits: {k, axis: 'h'|'v', at} cuts compartment k with a wall line, spending w (or h) spare pieces
    for (const sp of skel.splits || []) {
      const c = cells[sp.k]; if (!c) continue;
      if (sp.axis === 'h') cells.splice(sp.k, 1, { x0: c.x0, y0: c.y0, w: c.w, h: sp.at }, { x0: c.x0, y0: c.y0 + sp.at + 1, w: c.w, h: c.h - sp.at - 1 });
      else cells.splice(sp.k, 1, { x0: c.x0, y0: c.y0, w: sp.at, h: c.h }, { x0: c.x0 + sp.at + 1, y0: c.y0, w: c.w - sp.at - 1, h: c.h });
    }
    const extra = (skel.extra || []).filter(([x, y]) => x >= 0 && y >= 0 && x < G && y < G);
    return { x0, y0, tw: skel.tw, th: skel.th, W: skel.W, H: skel.H, splits: skel.splits || [], cells, extra };
  }
  // Spend spare pieces on a wall line through the most central, largest compartment (an extra compartment is
  // worth more than loose pieces). Returns a new skeleton with the splits, or null when nothing fits.
  function withSplits(sk, budget) {
    const skel = { ...sk, splits: [] };
    let left = budget - sk.walls;
    const box = () => buildBox(skel);
    for (let guard = 0; guard < 6 && left >= 3; guard++) {
      const cells = box().cells;
      let best = null;
      cells.forEach((c, k) => {
        if (skel.splits.some(sp => sp.k === k)) return;           // one split per original cell is enough
        const opts = [];
        if (c.h >= 7 && c.w <= left) opts.push({ k, axis: 'h', at: Math.floor(c.h / 2), cost: c.w });
        if (c.w >= 7 && c.h <= left) opts.push({ k, axis: 'v', at: Math.floor(c.w / 2), cost: c.h });
        for (const o of opts) {
          const dc = Math.hypot(c.x0 + c.w / 2 - CENTER, c.y0 + c.h / 2 - CENTER);
          o.score = c.w * c.h - dc * 2;
          if (!best || o.score > best.score) best = o;
        }
      });
      if (!best) break;
      // index shifts as cells are spliced, so record the split against the current cell list order
      skel.splits.push({ k: best.k, axis: best.axis, at: best.at });
      left -= best.cost;
    }
    if (!skel.splits.length) return null;
    skel.walls = budget - left;
    return skel;
  }

  // ---------- Grids ----------
  function bfs(queue, dist, eight) {
    const dirs = eight ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let head = 0;
    while (head < queue.length) {
      const t = queue[head++], x = t % G, y = (t / G) | 0, d = dist[t];
      for (const [dx, dy] of dirs) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= G || ny >= G) continue;
        const nt = ny * G + nx;
        if (dist[nt] === -1) { dist[nt] = d + 1; queue.push(nt); }
      }
    }
  }

  function initGrids(st, box) {
    st.box = box;
    st.occ = new Int16Array(G * G).fill(-1);
    st.comp = new Int16Array(G * G).fill(-1);
    st.wallTiles = [];
    if (box) {
      for (let y = box.y0; y < box.y0 + box.th; y++) for (let x = box.x0; x < box.x0 + box.tw; x++) st.occ[y * G + x] = -2;
      box.cells.forEach((c, k) => {
        for (let y = c.y0; y < c.y0 + c.h; y++) for (let x = c.x0; x < c.x0 + c.w; x++) { st.occ[y * G + x] = -1; st.comp[y * G + x] = k; }
      });
      for (let y = box.y0; y < box.y0 + box.th; y++) for (let x = box.x0; x < box.x0 + box.tw; x++) if (st.occ[y * G + x] === -2) st.wallTiles.push([x, y]);
      for (const [x, y] of box.extra || []) if (st.occ[y * G + x] === -1) { st.occ[y * G + x] = -2; st.wallTiles.push([x, y]); }
    }
    st.depth = new Int16Array(G * G).fill(-1);
    const q = [];
    for (let t = 0; t < G * G; t++) if (st.comp[t] === -1 && st.occ[t] !== -2) { st.depth[t] = 0; q.push(t); }
    bfs(q, st.depth, false);
    // layer: number of wall tiles crossed to reach the outside (0-1 BFS)
    st.layer = new Int16Array(G * G).fill(-1);
    {
      const dq = new Int32Array(G * G * 2); let head = G * G, tail = G * G;
      for (let t = 0; t < G * G; t++) if (st.comp[t] === -1 && st.occ[t] !== -2) { st.layer[t] = 0; dq[tail++] = t; }
      while (head < tail) {
        const t = dq[head++], x = t % G, y = (t / G) | 0, d = st.layer[t];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= G || ny >= G) continue;
          const nt = ny * G + nx, nd = d + (st.occ[nt] === -2 ? 1 : 0);
          if (st.layer[nt] === -1 || nd < st.layer[nt]) {
            st.layer[nt] = nd;
            if (nd === d) dq[--head] = nt; else dq[tail++] = nt;
          }
        }
      }
    }
    st.wallDist = new Int16Array(G * G).fill(-1);
    if (st.wallTiles.length) {
      const q2 = [];
      for (const [x, y] of st.wallTiles) { st.wallDist[y * G + x] = 0; q2.push(y * G + x); }
      bfs(q2, st.wallDist, true);
    } else st.wallDist.fill(99);
    st.region = new Uint8Array(G * G);
    if (box) {
      for (let y = Math.max(0, box.y0 - 3); y < Math.min(G, box.y0 + box.th + 3); y++)
        for (let x = Math.max(0, box.x0 - 3); x < Math.min(G, box.x0 + box.tw + 3); x++) st.region[y * G + x] = 1;
    } else {
      for (let y = 10; y < 34; y++) for (let x = 10; x < 34; x++) st.region[y * G + x] = 1;
    }
    st.covG = new Float32Array(G * G);
    st.covA = new Float32Array(G * G);
    st.tileCost = new Float32Array(G * G);
    st.tileWv = new Float32Array(G * G);
    st.covTotal = 0;
    st.wSum = 0;
    st.frozen = true; // skip tile refresh during bulk init
  }

  function refreshTile(st, t) {
    if (st.frozen) return;
    const o = st.occ[t];
    let w, mult = 1;
    if (o >= 0) { w = 1; if (st.items[o].core) mult = 1.5; }
    else if (o === -2) w = 0.5;
    else if (st.region[t]) w = 0.35;
    else w = 0;
    let c = 0;
    if (w > 0) {
      if (st.Tg > 0) { const dg = 1 - st.covG[t] / (st.Tg * mult); if (dg > 0) c += dg * dg; }
      if (st.Ta > 0) { const da = 1 - st.covA[t] / (st.Ta * mult); if (da > 0) c += da * da; }
      c *= w;
    }
    st.covTotal += c - st.tileCost[t];
    st.wSum += w - st.tileWv[t];
    st.tileCost[t] = c;
    st.tileWv[t] = w;
  }
  function refreshAll(st) {
    st.frozen = false;
    st.covTotal = 0; st.wSum = 0;
    st.tileCost.fill(0); st.tileWv.fill(0);
    for (let t = 0; t < G * G; t++) refreshTile(st, t);
  }

  function applyCoverage(st, item, sign) {
    if (!item.isDef || item.dps <= 0 || item.range <= 0) return;
    const cx = item.x + item.w / 2, cy = item.y + item.h / 2;
    const R = item.range, r0 = item.minRange || 0;
    const g = item.target !== 'air', a = item.target !== 'ground';
    const v = sign * item.dps;
    const xmin = Math.max(0, Math.floor(cx - R - 1)), xmax = Math.min(G - 1, Math.ceil(cx + R + 1));
    const ymin = Math.max(0, Math.floor(cy - R - 1)), ymax = Math.min(G - 1, Math.ceil(cy + R + 1));
    const R2 = R * R, r02 = r0 * r0;
    for (let y = ymin; y <= ymax; y++) {
      const dy = y + 0.5 - cy;
      for (let x = xmin; x <= xmax; x++) {
        const dx = x + 0.5 - cx, d2 = dx * dx + dy * dy;
        if (d2 > R2 || d2 < r02) continue;
        const t = y * G + x;
        if (g) st.covG[t] += v;
        if (a) st.covA[t] += v;
        refreshTile(st, t);
      }
    }
  }

  function footprintFree(st, x, y, w, h, selfIdx) {
    if (x < 0 || y < 0 || x + w > G || y + h > G) return false;
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
      const o = st.occ[j * G + i];
      if (o !== -1 && o !== selfIdx) return false;
    }
    return true;
  }
  function placementOk(st, item, x, y) {
    if (item.place === 'in') {
      const k = st.comp[y * G + x];
      if (k < 0) return false;
      for (let j = y; j < y + item.h; j++) for (let i = x; i < x + item.w; i++) if (st.comp[j * G + i] !== k) return false;
      return true;
    }
    for (let j = y; j < y + item.h; j++) for (let i = x; i < x + item.w; i++) if (st.comp[j * G + i] !== -1) return false;
    return true;
  }
  function canPlace(st, item, x, y, selfIdx) {
    return footprintFree(st, x, y, item.w, item.h, selfIdx === undefined ? -9 : selfIdx) && placementOk(st, item, x, y);
  }

  function dropItem(st, i, x, y) {
    const it = st.items[i];
    it.x = x; it.y = y;
    for (let j = y; j < y + it.h; j++) for (let k = x; k < x + it.w; k++) { st.occ[j * G + k] = i; refreshTile(st, j * G + k); }
    applyCoverage(st, it, +1);
  }
  function liftItem(st, i) {
    const it = st.items[i];
    applyCoverage(st, it, -1);
    for (let j = it.y; j < it.y + it.h; j++) for (let k = it.x; k < it.x + it.w; k++) { st.occ[j * G + k] = -1; refreshTile(st, j * G + k); }
  }
  function moveItem(st, i, x, y) { liftItem(st, i); dropItem(st, i, x, y); }
  function swapItems(st, i, j) {
    const a = st.items[i], b = st.items[j];
    const ax = a.x, ay = a.y, bx = b.x, by = b.y;
    liftItem(st, i); liftItem(st, j);
    dropItem(st, i, bx, by); dropItem(st, j, ax, ay);
  }

  // ---------- Initial placement ----------
  function rank(it) {
    if (it.role === 'th') return 1000;
    if (it.role === 'cc') return 900;
    return it.w * it.h * 10 + (it.role === 'key' ? 5 : 0) + (it.role === 'air' ? 3 : 0);
  }
  function pack(st, box, items, rng) {
    const cells = box.cells.map((c, k) => ({ ...c, k, cx: c.x0 + c.w / 2, cy: c.y0 + c.h / 2, used: 0, area: c.w * c.h }));
    const dc = (c) => Math.hypot(c.cx - CENTER, c.cy - CENTER);
    const order = items.slice().sort((a, b) => rank(b) - rank(a));
    const demoted = [];
    for (const it of order) {
      const cand = cells.filter(c => c.w >= it.w && c.h >= it.h);
      const central = it.role === 'th' || it.role === 'cc' || it.role === 'key';
      cand.sort((a, b) => {
        if (central) return (dc(a) - dc(b)) || ((a.used / a.area) - (b.used / b.area));
        const fa = (a.used + it.w * it.h) / a.area, fb = (b.used + it.w * it.h) / b.area;
        return (fa - fb) || (dc(a) - dc(b));
      });
      let placed = false;
      for (const c of cand) {
        const pos = findSpot(st, it, c, rng);
        if (pos) { dropItem(st, st.items.indexOf(it), pos[0], pos[1]); c.used += it.w * it.h; placed = true; break; }
      }
      if (!placed) demoted.push(it);
    }
    return demoted;
  }
  function findSpot(st, it, c, rng) {
    const xs = c.w - it.w, ys = c.h - it.h;
    if (xs < 0 || ys < 0) return null;
    const fx = rng() < 0.5, fy = rng() < 0.5;
    for (let j = 0; j <= ys; j++) for (let i = 0; i <= xs; i++) {
      const x = c.x0 + (fx ? i : xs - i), y = c.y0 + (fy ? j : ys - j);
      if (footprintFree(st, x, y, it.w, it.h, -9)) return [x, y];
    }
    return null;
  }
  function minWallDist(st, x, y, w, h) {
    let m = 99;
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) { const d = st.wallDist[j * G + i]; if (d < m) m = d; }
    return m;
  }
  function placeOutside(st, items, rng) {
    const placed = [], failed = [];
    const hasWalls = st.wallTiles.length > 0;
    for (const it of items) {
      let best = null, bestS = Infinity;
      for (let y = 0; y <= G - it.h; y++) for (let x = 0; x <= G - it.w; x++) {
        if (!canPlace(st, it, x, y)) continue;
        let s;
        if (hasWalls) { const wd = minWallDist(st, x, y, it.w, it.h); s = Math.abs(wd - 2) * 1.5; if (wd > 4) s += (wd - 4) * 2; }
        else s = Math.hypot(x + it.w / 2 - CENTER, y + it.h / 2 - CENTER) * 0.4;
        const cx = x + it.w / 2, cy = y + it.h / 2;
        for (const p of placed) { const d = Math.hypot(p.x + p.w / 2 - cx, p.y + p.h / 2 - cy); if (d < 7) s += (7 - d) * 0.8; }
        s += rng() * 0.5;
        if (s < bestS) { bestS = s; best = [x, y]; }
      }
      if (best) { dropItem(st, st.items.indexOf(it), best[0], best[1]); placed.push(it); } else failed.push(it);
    }
    return failed;
  }

  function prepItems(spec) {
    return spec.items.map((raw, i) => ({
      ...raw, i, x: -1, y: -1,
      core: isCore(raw, spec.mode),
      pri: priority(raw, spec.mode),
      dmin: dminOf(raw, spec.mode),
    }));
  }
  function thresholds(st) {
    const gd = [], ad = [];
    for (const it of st.items) {
      if (!it.isDef || it.dps <= 0 || it.range <= 0 || it.range >= 40) continue;
      if (it.target !== 'air') gd.push(it.dps);
      if (it.target !== 'ground') ad.push(it.dps);
    }
    const med = (arr) => { if (!arr.length) return 0; arr.sort((a, b) => a - b); return arr[(arr.length / 2) | 0]; };
    st.Tg = 4 * med(gd);
    st.Ta = 4 * med(ad);
  }
  function indexItems(st) {
    st.defs = st.items.filter(i => i.isDef && i.dps > 0 && i.range > 0);
    st.classes = {};
    for (const it of st.items) if (SPACING[it.id] && it.isDef) (st.classes[it.id] = st.classes[it.id] || []).push(it);
    st.storages = st.items.filter(i => i.role === 'storage');
    st.splashers = st.items.filter(i => i.isDef && (i.splash || i.id === 'super-wizard-tower' || i.id === 'scattershot') && i.id !== 'mortar');
    st.points = st.items.filter(i => ['cannon', 'archer-tower', 'hidden-tesla'].includes(i.id));
    st.ads = st.items.filter(i => i.id === 'air-defense');
    st.sweepers = st.items.filter(i => i.id === 'air-sweeper');
    st.outs = st.items.filter(i => i.place === 'out');
    st.deep = st.items.filter(i => i.dmin > 0);
    st.th = st.items.find(i => i.role === 'th');
    st.priSum = st.items.reduce((s, i) => s + i.pri, 0) || 1;
  }

  function newState(spec, skel, rng, strict) {
    const st = { spec, mode: spec.mode, items: prepItems(spec) };
    const box = skel ? buildBox(skel) : null;
    initGrids(st, box);
    for (const it of st.items) if (!box) it.place = 'out';
    const ins = st.items.filter(i => i.place === 'in'), outs = st.items.filter(i => i.place === 'out');
    let demoted = box ? pack(st, box, ins, rng) : [];
    if (strict && demoted.length) return null;
    for (const d of demoted) d.place = 'out';
    if (box) spareWalls(st, spec);
    const failed = placeOutside(st, outs.concat(demoted), rng);
    if (failed.length) {
      if (strict) return null;
      // last resort: drop into any free spot
      for (const it of failed) {
        let done = false;
        for (let y = 0; y <= G - it.h && !done; y++) for (let x = 0; x <= G - it.w && !done; x++) {
          if (footprintFree(st, x, y, it.w, it.h, -9)) { it.place = st.comp[y * G + x] >= 0 ? 'in' : 'out'; if (placementOk(st, it, x, y)) { dropItem(st, it.i, x, y); done = true; } }
        }
        if (!done) return null;
      }
    }
    st.demoted = demoted.map(d => d.name);
    finishState(st);
    return st;
  }
  // Spare wall pieces: a second layer two tiles out from the ring (one tile gap, so it is a separate wall to
  // break) on the side nearest the Town Hall, centred on it. Recorded in box.extra so evaluate() rebuilds it.
  function spareWalls(st, spec) {
    const box = st.box; let left = spec.walls - st.wallTiles.length;
    if (!box || left <= 0) return;
    const th = st.items.find(i => i.role === 'th' && i.place === 'in');
    const cx = th ? th.x + th.w / 2 : CENTER, cy = th ? th.y + th.h / 2 : CENTER;
    const sides = [
      { d: cy - box.y0, horiz: true, y: box.y0 - 2 }, { d: box.y0 + box.th - cy, horiz: true, y: box.y0 + box.th + 1 },
      { d: cx - box.x0, horiz: false, x: box.x0 - 2 }, { d: box.x0 + box.tw - cx, horiz: false, x: box.x0 + box.tw + 1 },
    ].sort((a, b) => a.d - b.d);
    const extra = box.extra ? box.extra.slice() : [];
    for (const sd of sides) {
      if (left <= 0) break;
      const len = sd.horiz ? box.tw : box.th, start = sd.horiz ? box.x0 : box.y0, centre = sd.horiz ? cx : cy;
      const n = Math.min(left, len); let a = Math.round(centre - n / 2); a = Math.max(start, Math.min(start + len - n, a));
      for (let i = 0; i < n; i++) {
        const x = sd.horiz ? a + i : sd.x, y = sd.horiz ? sd.y : a + i;
        if (x < 0 || y < 0 || x >= G || y >= G || st.occ[y * G + x] !== -1) continue;
        st.occ[y * G + x] = -2; st.wallTiles.push([x, y]); extra.push([x, y]); left--;
      }
    }
    box.extra = extra;
  }
  function finishState(st) {
    thresholds(st);
    indexItems(st);
    st.frozen = false;
    st.covG.fill(0); st.covA.fill(0);
    st.frozen = true;
    for (const it of st.items) applyCoverage(st, it, +1);
    refreshAll(st);
  }

  // ---------- Cost ----------
  function center(it) { return [it.x + it.w / 2, it.y + it.h / 2]; }
  function dist(a, b) { return Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2); }
  function itemDepth(st, it) {
    let m = 999;
    for (let j = it.y; j < it.y + it.h; j++) for (let i = it.x; i < it.x + it.w; i++) { const d = st.layer[j * G + i]; if (d < m) m = d; }
    return m;
  }
  function otherTerms(st) {
    const mode = st.mode, items = st.items;
    // centrality
    let cen = 0;
    for (const it of items) if (it.pri > 0) cen += it.pri * Math.hypot(it.x + it.w / 2 - CENTER, it.y + it.h / 2 - CENTER) / 22;
    cen /= st.priSum;
    // depth
    let dep = 0;
    if (st.box) {
      for (const it of st.deep) { if (it.place !== 'in') { dep += 1; continue; } const d = itemDepth(st, it); if (d < it.dmin) { const v = (it.dmin - d) / it.dmin; dep += v * v; } }
      dep /= Math.max(1, st.deep.length);
    }
    // spacing
    let sp = 0, pairs = 0;
    for (const id in st.classes) {
      const list = st.classes[id], req = SPACING[id];
      for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
        pairs++;
        const d = dist(list[a], list[b]);
        if (d < req) { const v = (req - d) / req; sp += v * v; }
      }
    }
    if (mode !== 'war') {
      for (let a = 0; a < st.storages.length; a++) for (let b = a + 1; b < st.storages.length; b++) {
        pairs++;
        const d = dist(st.storages[a], st.storages[b]);
        if (d < 5) { const v = (5 - d) / 5; sp += v * v; }
      }
    }
    if (st.ads.length >= 2) {
      let cx = 0, cy = 0;
      for (const a of st.ads) { cx += a.x + a.w / 2; cy += a.y + a.h / 2; }
      cx /= st.ads.length; cy /= st.ads.length;
      const off = Math.hypot(cx - CENTER, cy - CENTER) / 22;
      sp += off * off * 4; pairs += 1;
    }
    sp /= Math.max(1, pairs);
    // compartments
    let cm = 0;
    if (st.box) {
      const n = st.box.cells.length;
      const cnt = new Array(n).fill(0), used = new Array(n).fill(0), sto = new Array(n).fill(0), ad = new Array(n).fill(0);
      for (const it of items) {
        if (it.place !== 'in') continue;
        const k = st.comp[it.y * G + it.x];
        if (k < 0) continue;
        cnt[k]++; used[k] += it.w * it.h;
        if (it.role === 'storage') sto[k]++;
        if (it.id === 'air-defense') ad[k]++;
      }
      for (let k = 0; k < n; k++) {
        const c = st.box.cells[k], fill = used[k] / (c.w * c.h);
        if (cnt[k] === 0) cm += 0.4;
        if (fill > 0.8) cm += (fill - 0.8) * 5;
        if (cnt[k] > 5) cm += (cnt[k] - 5) * 0.3;
        if (mode !== 'war' && sto[k] > 1) cm += (sto[k] - 1);
        if (ad[k] > 1) cm += (ad[k] - 1) * 0.5;
      }
      cm /= n;
    }
    // splash support
    let spl = 0, spn = 0;
    if (st.splashers.length) {
      const nearestSplash = (it) => { let m = Infinity; for (const s of st.splashers) { if (s === it) continue; const d = dist(s, it); if (d < m) m = d; } return m; };
      for (const it of st.ads) { spn++; const d = nearestSplash(it); if (d > 5) spl += Math.min(1, (d - 5) / 6); }
      if (mode !== 'war') for (const it of st.storages) { spn++; const d = nearestSplash(it); if (d > 5) spl += Math.min(1, (d - 5) / 6); }
      if (st.th) { spn++; const d = nearestSplash(st.th); if (d > 6) spl += Math.min(1, (d - 6) / 6); }
      for (const it of st.points) { spn++; const d = nearestSplash(it); if (d > 6) spl += 0.5 * Math.min(1, (d - 6) / 6); }
      spl /= Math.max(1, spn);
    }
    // outside buildings
    let out = 0;
    if (st.outs.length) {
      const hasWalls = st.wallTiles.length > 0;
      for (let a = 0; a < st.outs.length; a++) {
        const it = st.outs[a];
        if (hasWalls) { const wd = minWallDist(st, it.x, it.y, it.w, it.h); if (wd > 2) out += Math.min(1.5, (wd - 2) / 2); }
        else out += Math.min(1, Math.hypot(it.x + it.w / 2 - CENTER, it.y + it.h / 2 - CENTER) / 22);
        for (let b = a + 1; b < st.outs.length; b++) {
          const o = st.outs[b];
          if (it.x < o.x + o.w + 1 && o.x < it.x + it.w + 1 && it.y < o.y + o.h + 1 && o.y < it.y + it.h + 1) out += 0.25;
        }
      }
      out /= st.outs.length;
    }
    // sweepers: moderate distance from TH, pointing away from the center, on different sides
    let sw = 0;
    if (st.sweepers.length && st.th) {
      for (const s of st.sweepers) {
        const d = dist(s, st.th);
        if (d < 3) sw += (3 - d) / 3; else if (d > 10) sw += Math.min(1, (d - 10) / 6);
      }
      if (st.sweepers.length >= 2) {
        const [a, b] = st.sweepers;
        const ang = (it) => Math.atan2(it.y + it.h / 2 - CENTER, it.x + it.w / 2 - CENTER);
        let th = Math.abs(ang(a) - ang(b)); if (th > Math.PI) th = 2 * Math.PI - th;
        const deg = th * 180 / Math.PI;
        if (deg < 100) sw += ((100 - deg) / 100) * ((100 - deg) / 100) * 2;
      }
      sw /= st.sweepers.length;
    }
    return { centrality: cen, depth: dep, spacing: sp, compartments: cm, splash: spl, outside: out, sweeper: sw };
  }
  function totalCost(st) {
    const o = otherTerms(st);
    let c = WEIGHTS.coverage * (st.covTotal / Math.max(1, st.wSum));
    for (const k in o) c += WEIGHTS[k] * o[k];
    return c;
  }
  function breakdown(st) {
    const o = otherTerms(st);
    const parts = { coverage: { raw: st.covTotal / Math.max(1, st.wSum) } };
    parts.coverage.weighted = WEIGHTS.coverage * parts.coverage.raw;
    let total = parts.coverage.weighted;
    for (const k in o) { parts[k] = { raw: o[k], weighted: WEIGHTS[k] * o[k] }; total += parts[k].weighted; }
    return { total, parts };
  }

  // ---------- Simulated annealing ----------
  function randomSpot(st, it, rng) {
    if (it.place === 'in' && st.box) {
      for (let tries = 0; tries < 12; tries++) {
        const c = st.box.cells[(rng() * st.box.cells.length) | 0];
        if (c.w < it.w || c.h < it.h) continue;
        const x = c.x0 + ((rng() * (c.w - it.w + 1)) | 0), y = c.y0 + ((rng() * (c.h - it.h + 1)) | 0);
        if (canPlace(st, it, x, y, it.i)) return [x, y];
      }
      return null;
    }
    for (let tries = 0; tries < 12; tries++) {
      const x = (rng() * (G - it.w + 1)) | 0, y = (rng() * (G - it.h + 1)) | 0;
      if (canPlace(st, it, x, y, it.i)) return [x, y];
    }
    return null;
  }
  function snapshot(st) { return st.items.map(i => [i.x, i.y]); }
  function restore(st, pos) {
    st.frozen = true;
    for (const it of st.items) applyCoverage(st, it, -1);
    st.occ.fill(-1);
    if (st.box) for (const [x, y] of st.wallTiles) st.occ[y * G + x] = -2;
    st.items.forEach((it, k) => { it.x = pos[k][0]; it.y = pos[k][1]; for (let j = it.y; j < it.y + it.h; j++) for (let i = it.x; i < it.x + it.w; i++) st.occ[j * G + i] = k; });
    st.covG.fill(0); st.covA.fill(0);
    for (const it of st.items) applyCoverage(st, it, +1);
    refreshAll(st);
  }
  function anneal(st, iters, rng, T0mult, report, phase) {
    const items = st.items, n = items.length;
    if (n === 0 || iters <= 0) return totalCost(st);
    let cost = totalCost(st), best = cost, bestPos = snapshot(st);
    st.tried = st.tried || 0; st.accepted = st.accepted || 0; st.initialCost = st.initialCost === undefined ? cost : st.initialCost;
    const T0 = Math.max(1e-6, cost * T0mult), Tend = T0 * 0.002;
    let last = Date.now();
    for (let it = 0; it < iters; it++) {
      const T = T0 * Math.pow(Tend / T0, it / iters);
      const r = rng();
      if (r < 0.75) {
        const i = (rng() * n) | 0, a = items[i];
        let nx, ny;
        if (r < 0.6) {
          let ok = false;
          for (let k = 0; k < 4 && !ok; k++) {
            nx = a.x + ((rng() * 7) | 0) - 3; ny = a.y + ((rng() * 7) | 0) - 3;
            ok = (nx !== a.x || ny !== a.y) && canPlace(st, a, nx, ny, i);
          }
          if (!ok) continue;
        } else { const p = randomSpot(st, a, rng); if (!p) continue; nx = p[0]; ny = p[1]; }
        st.tried++;
        const ox = a.x, oy = a.y;
        moveItem(st, i, nx, ny);
        const c2 = totalCost(st), d = c2 - cost;
        if (d <= 0 || rng() < Math.exp(-d / T)) { cost = c2; st.accepted++; } else moveItem(st, i, ox, oy);
      } else {
        const i = (rng() * n) | 0, j = (rng() * n) | 0;
        if (i === j) continue;
        const a = items[i], b = items[j];
        if (a.w !== b.w || a.h !== b.h || a.place !== b.place) continue;
        st.tried++;
        swapItems(st, i, j);
        const c2 = totalCost(st), d = c2 - cost;
        if (d <= 0 || rng() < Math.exp(-d / T)) { cost = c2; st.accepted++; } else swapItems(st, i, j);
      }
      if (cost < best - 1e-9) { best = cost; bestPos = snapshot(st); }
      if (report && (it & 255) === 0) {
        const now = Date.now();
        if (now - last > 300) { last = now; report({ phase, it, iters, cost, best, positions: bestPos, skel: st.box ? { x0: st.box.x0, y0: st.box.y0, W: st.box.W, H: st.box.H, tw: st.box.tw, th: st.box.th, splits: st.box.splits, extra: st.box.extra } : null }); }
      }
    }
    restore(st, bestPos);
    return best;
  }

  // ---------- Traps ----------
  function placeTraps(st, rng) {
    const traps = st.spec.traps || [];
    const occT = st.occ.slice();
    const out = [], items = st.items;
    const defs = st.defs, groundDefs = defs.filter(i => i.target !== 'air'), airDefs = defs.filter(i => i.target !== 'ground');
    const ads = st.ads, th = st.th;
    const thComp = th && th.place === 'in' ? st.comp[th.y * G + th.x] : -1;
    const coreTargets = items.filter(i => i.role === 'th' || i.role === 'cc' || ['inferno-tower', 'eagle-artillery', 'scattershot', 'monolith', 'x-bow'].includes(i.id));
    const outs = st.outs;
    const free = (x, y, w, h) => { if (x < 0 || y < 0 || x + w > G || y + h > G) return false; for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (occT[j * G + i] !== -1) return false; return true; };
    const inside = (x, y, w, h) => { const k = st.comp[y * G + x]; if (k < 0) return false; for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (st.comp[j * G + i] !== k) return false; return true; };
    const outside = (x, y, w, h) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (st.comp[j * G + i] !== -1) return false; return true; };
    const nearest = (list, cx, cy) => { let m = Infinity; for (const i of list) { const d = Math.hypot(i.x + i.w / 2 - cx, i.y + i.h / 2 - cy); if (d < m) m = d; } return m; };
    const within = (list, cx, cy, r) => { let n = 0; for (const i of list) if (Math.hypot(i.x + i.w / 2 - cx, i.y + i.h / 2 - cy) <= r) n++; return n; };
    const neigh = (x, y, pred) => { let n = 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= G || ny >= G) continue; const o = st.occ[ny * G + nx]; if (o >= 0 && pred(items[o])) n++; } return n; };
    const hasBox = !!st.box;
    function greedy(trap, scoreFn, minSep) {
      const here = [];
      for (let c = 0; c < trap.count; c++) {
        let best = null, bs = -Infinity;
        for (let y = 0; y <= G - trap.h; y++) for (let x = 0; x <= G - trap.w; x++) {
          if (!free(x, y, trap.w, trap.h)) continue;
          let s = scoreFn(x, y, here);
          if (s === null) continue;
          if (minSep) for (const p of here) { const d = Math.hypot(p.x - x, p.y - y); if (d < minSep) s -= (minSep - d) * 2; }
          s += rng() * 0.3;
          if (s > bs) { bs = s; best = [x, y]; }
        }
        if (!best) break;
        const [x, y] = best;
        for (let j = y; j < y + trap.h; j++) for (let i = x; i < x + trap.w; i++) occT[j * G + i] = -3;
        const rec = { id: trap.id, short: trap.short, name: trap.name, target: trap.target, x, y, w: trap.w, h: trap.h, lv: trap.lv };
        out.push(rec); here.push(rec);
      }
    }
    for (const trap of traps) {
      if (!trap.count) continue;
      const w = trap.w, h = trap.h;
      switch (trap.id) {
        case 'giant-bomb':
          greedy(trap, (x, y, here) => {
            if (hasBox && !inside(x, y, w, h)) return null;
            const cx = x + 1, cy = y + 1;
            let s = within(groundDefs, cx, cy, 4.5) * 1.5;
            const nd = nearest(groundDefs, cx, cy);
            if (nd >= 1.5 && nd <= 3.5) s += 1.5;
            if (st.depth[y * G + x] >= 2) s += 1;
            if (here.length % 2 === 1) {
              const p = here[here.length - 1];
              if ((Math.abs(x - p.x) === 2 && y === p.y) || (Math.abs(y - p.y) === 2 && x === p.x)) s += 6;
              for (let k = 0; k < here.length - 1; k++) { const d = Math.hypot(here[k].x - x, here[k].y - y); if (d < 6) s -= (6 - d) * 2; }
            } else for (const p of here) { const d = Math.hypot(p.x - x, p.y - y); if (d < 6) s -= (6 - d) * 2; }
            return s;
          }, 0);
          break;
        case 'spring-trap':
          greedy(trap, (x, y) => {
            if (hasBox && !inside(x, y, w, h)) return null;
            const adj = neigh(x, y, (it) => it.isDef && it.target !== 'air');
            if (adj < 1) return null;
            let s = adj * 2;
            const occ = (xx, yy) => xx < 0 || yy < 0 || xx >= G || yy >= G || st.occ[yy * G + xx] !== -1;
            if ((occ(x - 1, y) && occ(x + 1, y)) || (occ(x, y - 1) && occ(x, y + 1))) s += 1.5;
            return s;
          }, 3);
          break;
        case 'skeleton-trap':
          greedy(trap, (x, y) => {
            if (hasBox && !inside(x, y, w, h)) return null;
            const d = nearest(coreTargets, x + 0.5, y + 0.5);
            return 3 - Math.min(3, d) * 0.5 + (st.depth[y * G + x] >= 2 ? 1 : 0);
          }, 3);
          break;
        case 'tornado-trap':
          greedy(trap, (x, y) => {
            if (hasBox && !inside(x, y, w, h)) return null;
            if (!th) return 0;
            return -nearest([th], x + 0.5, y + 0.5) + (st.comp[y * G + x] === thComp ? 5 : 0);
          }, 0);
          break;
        case 'giga-bomb':
          greedy(trap, (x, y) => {
            if (hasBox && !inside(x, y, w, h)) return null;
            const cx = x + 1, cy = y + 1;
            return (th ? -nearest([th], cx, cy) : 0) + (st.comp[y * G + x] === thComp ? 5 : 0) + within(defs, cx, cy, 5) * 0.3;
          }, 0);
          break;
        case 'seeking-air-mine':
          greedy(trap, (x, y) => {
            if (hasBox && !inside(x, y, w, h)) return null;
            const dAd = nearest(ads, x + 0.5, y + 0.5), dTh = th ? nearest([th], x + 0.5, y + 0.5) : 99;
            let s = 0;
            if (dAd >= 2 && dAd <= 5) s += 3;
            if (dTh < 6) s += 1.5;
            return s - 0.2 * Math.min(dAd, dTh);
          }, 4);
          break;
        case 'air-bomb':
          greedy(trap, (x, y) => {
            if (hasBox && !inside(x, y, w, h)) return null;
            const dA = nearest(airDefs, x + 0.5, y + 0.5);
            let s = 0;
            if (dA >= 1.5 && dA <= 4) s += 3;
            if (nearest(ads, x + 0.5, y + 0.5) < 5) s += 1;
            const dp = st.depth[y * G + x];
            if (dp >= 1 && dp <= 3) s += 1;
            return s - 0.1 * dA;
          }, 4);
          break;
        default: // bomb
          greedy(trap, (x, y) => {
            if (hasBox && !outside(x, y, w, h)) return null;
            if (!st.region[y * G + x]) return null;
            let s = neigh(x, y, (it) => it.place === 'out') * 1.5;
            const wd = st.wallDist[y * G + x];
            if (hasBox && wd >= 1 && wd <= 2) s += 1.5;
            if (nearest(groundDefs, x + 0.5, y + 0.5) < 7) s += 1;
            return s;
          }, 3);
      }
    }
    return out;
  }

  // ---------- Result ----------
  function notesFor(st, bd) {
    const notes = [];
    const items = st.items;
    // coverage holes on building tiles
    let thinG = 0, thinA = 0;
    for (let t = 0; t < G * G; t++) {
      const o = st.occ[t];
      if (o < 0) continue;
      if (st.Tg > 0 && st.covG[t] < st.Tg * 0.5) thinG++;
      if (st.Ta > 0 && st.covA[t] < st.Ta * 0.5) thinA++;
    }
    const tiles = (n) => `${n} building tile${n === 1 ? '' : 's'} ${n === 1 ? 'has' : 'have'}`;
    if (thinG > 0) notes.push({ kind: 'coverage', text: `${tiles(thinG)} thin ground coverage (less than half the target DPS reaches ${thinG === 1 ? 'it' : 'them'}).` });
    if (thinA > 0) notes.push({ kind: 'coverage', text: `${tiles(thinA)} thin air coverage.` });
    // spacing offenders
    const offenders = [];
    for (const id in st.classes) {
      const list = st.classes[id], req = SPACING[id];
      for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
        const d = dist(list[a], list[b]);
        if (d < req * 0.8) offenders.push({ sev: (req - d) / req, text: `${list[a].name} #${list[a].idx} and #${list[b].idx} are ${d.toFixed(1)} tiles apart (aim for ${req}+).` });
      }
    }
    offenders.sort((a, b) => b.sev - a.sev);
    for (const o of offenders.slice(0, 3)) notes.push({ kind: 'spacing', text: o.text });
    // depth
    if (st.box) for (const it of st.deep) {
      if (it.place !== 'in') { notes.push({ kind: 'depth', text: `${it.name} is outside the walls.` }); continue; }
      const d = itemDepth(st, it);
      if (d < it.dmin) notes.push({ kind: 'depth', text: `${it.name}${it.idx ? ' #' + it.idx : ''} has only ${d} wall layer${d === 1 ? '' : 's'} between it and the outside (want ${it.dmin}).` });
    }
    if (st.demoted && st.demoted.length) notes.push({ kind: 'walls', text: `Not enough wall space for everything: ${[...new Set(st.demoted)].join(', ')} placed outside.` });
    if (st.box) {
      const cnt = new Array(st.box.cells.length).fill(0);
      for (const it of items) if (it.place === 'in') { const k = st.comp[it.y * G + it.x]; if (k >= 0) cnt[k]++; }
      const empty = cnt.filter(c => c === 0).length;
      if (empty) notes.push({ kind: 'compartments', text: `${empty} compartment${empty > 1 ? 's are' : ' is'} empty. Empty compartments still slow ground troops, but you could shrink the wall grid to tighten the base.` });
    }
    return notes.slice(0, 8);
  }
  function result(st, traps) {
    const bd = breakdown(st);
    const items = st.items.map(it => {
      const o = { id: it.id, name: it.name, short: it.short, idx: it.idx, lv: it.lv, w: it.w, h: it.h, x: it.x, y: it.y, role: it.role, place: it.place, isDef: it.isDef, target: it.target, range: it.range, minRange: it.minRange, dps: it.dps, hp: it.hp, cat: it.cat };
      if (it.id === 'air-sweeper') o.dir = Math.atan2(it.y + it.h / 2 - CENTER, it.x + it.w / 2 - CENTER);
      return o;
    });
    return {
      skel: st.box ? { x0: st.box.x0, y0: st.box.y0, W: st.box.W, H: st.box.H, tw: st.box.tw, th: st.box.th, splits: st.box.splits, extra: st.box.extra } : null,
      cells: st.box ? st.box.cells : [],
      walls: st.wallTiles,
      wallsUsed: st.wallTiles.length,
      items, traps,
      score: bd,
      thresholds: { ground: st.Tg, air: st.Ta },
      stats: { tried: st.tried || 0, accepted: st.accepted || 0, initialCost: st.initialCost },
      covG: Array.from(st.covG), covA: Array.from(st.covA),
      notes: notesFor(st, bd),
    };
  }

  function optimize(spec, report) {
    const rng = rngFactory(spec.seed || 1);
    const items0 = prepItems(spec);
    const ins = items0.filter(i => i.place === 'in');
    const needArea = ins.reduce((s, i) => s + i.w * i.h, 0);
    const n4 = ins.filter(i => i.w >= 4 || i.h >= 4).length;
    let cands = spec.walls >= 8 && ins.length ? skeletons(needArea, spec.walls, 36, n4) : [];
    if (!cands.length && spec.walls >= 8 && ins.length) cands = skeletons(needArea, spec.walls, 40, n4);
    // Too few walls to enclose everything (low Town Halls): enclose the most important part and demote the rest.
    for (const f of [0.8, 0.65, 0.5, 0.4, 0.3]) { if (cands.length || spec.walls < 8 || !ins.length) break; cands = skeletons(Math.round(needArea * f), spec.walls, 40, Math.min(n4, 1)); }
    // Spare pieces: a split variant of each good skeleton competes with the plain one.
    const withVariants = [];
    for (const sk of cands.slice(0, 6)) { withVariants.push(sk); const v = withSplits(sk, spec.walls); if (v) withVariants.push(v); }
    cands = withVariants.concat(cands.slice(6));
    const trials = [];
    for (const sk of cands) {
      if (trials.length >= 4) break;
      const st = newState(spec, sk, rng, true);
      if (st) trials.push(st);
    }
    if (!trials.length) {
      // relax: accept demotions, or no walls at all
      for (const sk of cands.slice(0, 20)) { const st = newState(spec, sk, rng, false); if (st) { trials.push(st); break; } }
      if (!trials.length) trials.push(newState(spec, null, rng, false));
    }
    const iters = Math.max(1000, spec.iterations || 60000);
    const short = trials.length > 1 ? Math.floor(iters * 0.15) : 0;
    let bestSt = trials[0], bestC = Infinity;
    if (trials.length > 1) {
      trials.forEach((st, k) => {
        const c = anneal(st, short, rng, 0.08, report, `Trying wall layout ${k + 1} of ${trials.length}`);
        if (c < bestC) { bestC = c; bestSt = st; }
      });
    }
    anneal(bestSt, iters - short * trials.length, rng, 0.05, report, 'Refining placement');
    const traps = placeTraps(bestSt, rng);
    return result(bestSt, traps);
  }

  // Rebuild a state from a saved layout (used after manual drags) and re-score it.
  function evaluate(spec, layout, movedIdx, nx, ny) {
    const st = { spec, mode: spec.mode, items: prepItems(spec) };
    const box = layout.skel ? buildBox(layout.skel) : null;
    initGrids(st, box);
    if (!box) for (const it of st.items) it.place = 'out';
    const byKey = new Map(layout.items.map((l, k) => [k, l]));
    // Place the moved building last so an overlap it causes is reported as an overlap, not a stale layout.
    const order = st.items.map((_, k) => k).filter(k => k !== movedIdx); if (movedIdx >= 0 && movedIdx < st.items.length) order.push(movedIdx);
    for (const k of order) {
      const it = st.items[k], l = byKey.get(k);
      if (!l) return { error: 'Layout does not match the inventory. Run the optimizer again.' };
      it.place = l.place;
      let x = l.x, y = l.y;
      if (k === movedIdx) { x = nx; y = ny; }
      if (!footprintFree(st, x, y, it.w, it.h, -9)) return { error: k === movedIdx ? 'That spot overlaps another building or a wall.' : 'Layout does not match the inventory. Run the optimizer again.' };
      if (k === movedIdx) {
        if (box && it.place === 'in' && !placementOk(st, it, x, y)) {
          // allow an inside building to step outside the walls, but mark it
          if (st.comp[y * G + x] === -1 && placementOk(st, { ...it, place: 'out' }, x, y)) it.place = 'out';
          else return { error: 'A building must sit fully inside one compartment or fully outside the walls.' };
        } else if (box && it.place === 'out' && !placementOk(st, it, x, y)) {
          if (placementOk(st, { ...it, place: 'in' }, x, y)) it.place = 'in';
          else return { error: 'A building must sit fully inside one compartment or fully outside the walls.' };
        }
      }
      it.x = x; it.y = y;
      for (let j = y; j < y + it.h; j++) for (let i = x; i < x + it.w; i++) st.occ[j * G + i] = k;
    }
    st.demoted = [];
    finishState(st);
    const rng = rngFactory(spec.seed || 1);
    const traps = placeTraps(st, rng);
    return result(st, traps);
  }

  function wallsFromSkel(skel) { const st = {}; initGrids(st, buildBox(skel)); return st.wallTiles; }
  return { optimize, evaluate, wallsFromSkel, WEIGHTS, SPACING, G };
}
if (typeof window !== 'undefined') window.createOptimizer = createOptimizer;
if (typeof module !== 'undefined' && module.exports) module.exports = createOptimizer;
