// Dependency-free hybrid vectorizer (runs in a worker, no CDN, no WASM).
// 1) error-driven palette growth (variance splitting + k-means) until a PSNR target is met,
// 2) luminance-ranked STACKED layers (layer k = every pixel with rank >= k) so no seams/gaps,
// 3) exact pixel-edge boundary tracing with holes, 4) RDP + corner-aware quadratic smoothing.

const BITS = 6, SHIFT = 8 - BITS, NB = 1 << (BITS * 3);

function buildPalette(data, N, opaque, maxColors, targetPsnr, report) {
  const cnt = new Float64Array(NB), sr = new Float64Array(NB), sg = new Float64Array(NB), sb = new Float64Array(NB), sq = new Float64Array(NB);
  const binOf = new Int32Array(N).fill(-1);
  let total = 0;
  for (let i = 0; i < N; i++) {
    if (!opaque[i]) continue;
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const k = ((r >> SHIFT) << (2 * BITS)) | ((g >> SHIFT) << BITS) | (b >> SHIFT);
    binOf[i] = k; cnt[k]++; sr[k] += r; sg[k] += g; sb[k] += b; sq[k] += r * r + g * g + b * b; total++;
  }
  const ids = []; for (let k = 0; k < NB; k++) if (cnt[k]) ids.push(k);
  const mr = new Float64Array(NB), mg = new Float64Array(NB), mb = new Float64Array(NB);
  for (const k of ids) { mr[k] = sr[k] / cnt[k]; mg[k] = sg[k] / cnt[k]; mb[k] = sb[k] / cnt[k]; }
  const makeBox = (list) => {
    let n = 0, R = 0, G = 0, B = 0, Q = 0;
    for (const k of list) { n += cnt[k]; R += sr[k]; G += sg[k]; B += sb[k]; Q += sq[k]; }
    return { list, n, sse: Math.max(0, Q - (R * R + G * G + B * B) / n), mean: [R / n, G / n, B / n] };
  };
  const boxes = [makeBox(ids)];
  let sseSum = boxes[0].sse;
  const target = total * 3 * (255 * 255) / Math.pow(10, targetPsnr / 10);
  while (boxes.length < maxColors && sseSum > target) {
    let bi = -1, best = 0;
    for (let i = 0; i < boxes.length; i++) if (boxes[i].list.length > 1 && boxes[i].sse > best) { best = boxes[i].sse; bi = i; }
    if (bi < 0) break;
    const bx = boxes[bi];
    let vr = 0, vg = 0, vb = 0;
    for (const k of bx.list) { vr += cnt[k] * (mr[k] - bx.mean[0]) ** 2; vg += cnt[k] * (mg[k] - bx.mean[1]) ** 2; vb += cnt[k] * (mb[k] - bx.mean[2]) ** 2; }
    const arr = vr >= vg && vr >= vb ? mr : vg >= vb ? mg : mb, m = arr === mr ? bx.mean[0] : arr === mg ? bx.mean[1] : bx.mean[2];
    let lo = [], hi = [];
    for (const k of bx.list) (arr[k] <= m ? lo : hi).push(k);
    if (!lo.length || !hi.length) { lo = bx.list.slice(0, bx.list.length >> 1); hi = bx.list.slice(bx.list.length >> 1); }
    const a = makeBox(lo), b = makeBox(hi);
    sseSum += a.sse + b.sse - bx.sse;
    boxes[bi] = a; boxes.push(b);
  }
  // k-means refinement over histogram bins
  let cent = boxes.map((b) => b.mean.slice());
  const lab = new Int32Array(NB);
  for (let it = 0; it < 4; it++) {
    const acc = cent.map(() => [0, 0, 0, 0]);
    for (const k of ids) {
      let bj = 0, bd = Infinity;
      for (let j = 0; j < cent.length; j++) {
        const d = (mr[k] - cent[j][0]) ** 2 + (mg[k] - cent[j][1]) ** 2 + (mb[k] - cent[j][2]) ** 2;
        if (d < bd) { bd = d; bj = j; }
      }
      lab[k] = bj; const a = acc[bj]; a[0] += sr[k]; a[1] += sg[k]; a[2] += sb[k]; a[3] += cnt[k];
    }
    cent = cent.map((c, j) => (acc[j][3] ? [acc[j][0] / acc[j][3], acc[j][1] / acc[j][3], acc[j][2] / acc[j][3]] : c));
    report?.(`Refining ${cent.length}-colour palette (${it + 1}/4)…`);
  }
  const pal = cent.map((c) => c.map((v) => Math.round(v)));
  return { pal, labelOf: (i) => lab[binOf[i]] };
}

const MS = { 1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 6: [[0, 2]], 7: [[3, 2]], 8: [[2, 3]], 9: [[2, 0]], 11: [[2, 1]], 12: [[1, 3]], 13: [[1, 0]], 14: [[0, 3]] };
// edge codes: 0 top, 1 right, 2 bottom, 3 left. Inside is always on the left of travel.
function contourLayer(k, W, H, rank, rank2, cov, cov2, box, st) {
  const S = W + 2, M = S * (H + 2), next = st.next, touched = st.touched;
  const val = (x, y) => { if (x < 0 || y < 0 || x >= W || y >= H) return 0; const i = y * W + x; return rank[i] === k ? cov[i] : rank2[i] === k ? cov2[i] : 0; };
  const eid = (c, x, y) => (c === 0 ? (y + 1) * S + x + 1 : c === 2 ? (y + 2) * S + x + 1 : c === 3 ? M + (y + 1) * S + x + 1 : M + (y + 1) * S + x + 2);
  for (let y = box[1] - 1; y <= box[3]; y++) for (let x = box[0] - 1; x <= box[2]; x++) {
    const tl = val(x, y), tr = val(x + 1, y), br = val(x + 1, y + 1), bl = val(x, y + 1);
    let c = (tl >= 0.5 ? 1 : 0) | (tr >= 0.5 ? 2 : 0) | (br >= 0.5 ? 4 : 0) | (bl >= 0.5 ? 8 : 0);
    if (c === 0 || c === 15) continue;
    let segs = MS[c];
    if (c === 5 || c === 10) {
      const hi = (tl + tr + br + bl) / 4 >= 0.5;
      segs = c === 5 ? (hi ? [[1, 0], [3, 2]] : [[3, 0], [1, 2]]) : (hi ? [[0, 3], [2, 1]] : [[0, 1], [2, 3]]);
    }
    for (const [from, to] of segs) { const f = eid(from, x, y); next[f] = eid(to, x, y); touched.push(f); }
  }
  const pt = (id) => {
    const v = id >= M, r = v ? id - M : id, ey = Math.floor(r / S) - 1, ex = (r % S) - 1;
    if (!v) { const a = val(ex, ey), b = val(ex + 1, ey); return [ex + 0.5 + (0.5 - a) / ((b - a) || 1), ey + 0.5]; }
    const a = val(ex, ey), b = val(ex, ey + 1); return [ex + 0.5, ey + 0.5 + (0.5 - a) / ((b - a) || 1)];
  };
  // an edge id is shared by two cells; pairs (from,to) of adjacent cells agree, so chains close into loops
  const loops = [];
  for (const start of touched) {
    if (next[start] < 0) continue;
    const pts = []; let cur = start, guard = 0;
    while (cur >= 0 && guard++ < 5e6) { pts.push(pt(cur)); const n = next[cur]; next[cur] = -1; cur = n; if (cur === start) break; }
    if (pts.length >= 3) loops.push(pts);
  }
  for (const f of touched) next[f] = -1;
  touched.length = 0;
  return loops;
}

const area2 = (p) => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s; };

function rdp(p, lo, hi, eps, keep) {
  const stack = [[lo, hi]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const ax = p[s][0], ay = p[s][1], bx = p[e % p.length][0], by = p[e % p.length][1];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
    let md = -1, mi = -1;
    for (let i = s + 1; i < e; i++) {
      const q = p[i % p.length];
      const d = Math.abs((q[0] - ax) * dy - (q[1] - ay) * dx) / L;
      if (d > md) { md = d; mi = i; }
    }
    if (md > eps) { keep[mi % p.length] = 1; stack.push([s, mi], [mi, e]); }
  }
}

function simplifyClosed(p, eps) {
  if (p.length < 8 || eps <= 0) return p;
  let far = 0, fd = -1;
  for (let i = 1; i < p.length; i++) { const d = (p[i][0] - p[0][0]) ** 2 + (p[i][1] - p[0][1]) ** 2; if (d > fd) { fd = d; far = i; } }
  const keep = new Uint8Array(p.length); keep[0] = 1; keep[far] = 1;
  rdp(p, 0, far, eps, keep); rdp(p, far, p.length, eps, keep);
  return p.filter((_, i) => keep[i]);
}

const f = (v) => (Math.round(v * 10) / 10).toString();

function loopToPath(p) {
  const n = p.length;
  if (n < 3) return '';
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const M = p.map((q, i) => mid(q, p[(i + 1) % n]));
  let d = `M${f(M[n - 1][0])} ${f(M[n - 1][1])}`;
  for (let i = 0; i < n; i++) {
    const a = p[(i + n - 1) % n], b = p[i], c = p[(i + 1) % n];
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const cos = ((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])) / (l1 * l2 || 1);
    if (cos < 0.5 && l1 > 2.5 && l2 > 2.5) d += `L${f(b[0])} ${f(b[1])}L${f(M[i][0])} ${f(M[i][1])}`;
    else d += `Q${f(b[0])} ${f(b[1])} ${f(M[i][0])} ${f(M[i][1])}`;
  }
  return d + 'Z';
}

export function traceHybridPure(img, settings, report = () => {}) {
  const { width: W, height: H, data } = img, N = W * H;
  const opaque = new Uint8Array(N); let opCount = 0;
  for (let i = 0; i < N; i++) if (data[i * 4 + 3] >= 128) { opaque[i] = 1; opCount++; }
  if (!opCount) throw new Error('The image is fully transparent.');
  const maxColors = Math.max(2, Math.min(1024, settings.colors || 256));
  const targetPsnr = Math.max(25, Math.min(60, settings.targetPsnr || 44));
  report(8, 'Growing the palette until the fidelity target is met…');
  const { pal, labelOf } = buildPalette(data, N, opaque, maxColors, targetPsnr, (m) => report(14, m));
  const order = pal.map((c, i) => i).sort((a, b) => (0.299 * pal[a][0] + 0.587 * pal[a][1] + 0.114 * pal[a][2]) - (0.299 * pal[b][0] + 0.587 * pal[b][1] + 0.114 * pal[b][2]));
  const rankOfLabel = new Int32Array(pal.length); order.forEach((l, r) => { rankOfLabel[l] = r; });
  const rank = new Int16Array(N).fill(-1);
  let se = 0;
  for (let i = 0; i < N; i++) if (opaque[i]) {
    const l = labelOf(i); rank[i] = rankOfLabel[l];
    const c = pal[l]; se += (c[0] - data[i * 4]) ** 2 + (c[1] - data[i * 4 + 1]) ** 2 + (c[2] - data[i * 4 + 2]) ** 2;
  }
  // Vector eligibility: pixel colour within `tol` of its palette colour AND part of a coherent same-colour region.
  const tol = settings.tol ?? 8, minArea = Math.max(1, settings.minVectorArea ?? 64);
  const ok = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (rank[i] >= 0) {
    const c = pal[order[rank[i]]];
    ok[i] = Math.max(Math.abs(c[0] - data[i * 4]), Math.abs(c[1] - data[i * 4 + 1]), Math.abs(c[2] - data[i * 4 + 2])) <= tol ? 1 : 0;
  }
  const vec = new Uint8Array(N), seen = new Uint8Array(N), stack = new Int32Array(N);
  for (let s0 = 0; s0 < N; s0++) {
    if (!ok[s0] || seen[s0]) continue;
    let sp = 0, n = 0; const comp = [s0]; stack[sp++] = s0; seen[s0] = 1;
    while (sp) {
      const q = stack[--sp], x = q % W, r0 = rank[q]; n++;
      const nb = [x > 0 ? q - 1 : -1, x < W - 1 ? q + 1 : -1, q >= W ? q - W : -1, q < N - W ? q + W : -1];
      for (const m of nb) if (m >= 0 && ok[m] && !seen[m] && rank[m] === r0) { seen[m] = 1; stack[sp++] = m; comp.push(m); }
    }
    if (n >= minArea) for (const m of comp) vec[m] = 1;
  }
  // Crisp edges: anti-aliased pixels that are a blend of two neighbouring vector colours join the nearer one,
  // so edges are real hard SVG curves (sharp at any zoom) instead of blurry raster pixels.
  const cov = new Float32Array(N).fill(1), rank2 = new Int16Array(N).fill(-1), cov2 = new Float32Array(N);
  for (let pass = 0; pass < 1; pass++) {
    const add = [];
    for (let i = 0; i < N; i++) {
      if (vec[i] || !opaque[i]) continue;
      const x = i % W, cs = [];
      for (const m of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i < N - W ? i + W : -1]) if (m >= 0 && vec[m]) cs.push(m);
      if (!cs.length) continue;
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      let best = Infinity, bt = 0, ba = -1, bc = -1;
      for (const a of cs) for (const c of cs) {
        const A = pal[order[rank[a]]], B = pal[order[rank[c]]];
        const vx = B[0] - A[0], vy = B[1] - A[1], vz = B[2] - A[2], L = vx * vx + vy * vy + vz * vz;
        let t = L ? ((r - A[0]) * vx + (g - A[1]) * vy + (b - A[2]) * vz) / L : 0; t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(r - A[0] - t * vx, g - A[1] - t * vy, b - A[2] - t * vz);
        if (d < best) { best = d; bt = t; ba = a; bc = c; }
      }
      if (best <= 8) add.push(i, rank[ba], rank[bc], bt);
    }
    for (let j = 0; j < add.length; j += 4) {
      const i = add[j], ra = add[j + 1], rb = add[j + 2], t = add[j + 3];
      vec[i] = 1;
      if (ra === rb) { rank[i] = ra; cov[i] = 1; }
      else if (t < 0.5) { rank[i] = ra; cov[i] = 1 - t; rank2[i] = rb; cov2[i] = t; }
      else { rank[i] = rb; cov[i] = t; rank2[i] = ra; cov2[i] = 1 - t; }
    }
  }
  let vecCount = 0;
  for (let i = 0; i < N; i++) { if (vec[i]) vecCount++; else rank[i] = -1; }
  // Raster underlay = everything opaque that is not vector, grown by `overlap` px so no seams appear.
  const ov = Math.max(0, settings.edgeOverlap ?? 2);
  let rmask = new Uint8Array(N); let rasterPixels = 0;
  for (let i = 0; i < N; i++) if (opaque[i] && !vec[i]) rmask[i] = 1;
  for (let pass = 0; pass < ov; pass++) {
    const nx = rmask.slice();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; if (rmask[i] || !opaque[i]) continue;
      if ((x > 0 && rmask[i - 1]) || (x < W - 1 && rmask[i + 1]) || (y > 0 && rmask[i - W]) || (y < H - 1 && rmask[i + W]) ||
          (x > 0 && y > 0 && rmask[i - W - 1]) || (x < W - 1 && y > 0 && rmask[i - W + 1]) || (x > 0 && y < H - 1 && rmask[i + W - 1]) || (x < W - 1 && y < H - 1 && rmask[i + W + 1])) nx[i] = 1;
    }
    rmask = nx;
  }
  for (let i = 0; i < N; i++) if (opaque[i] && !vec[i]) rasterPixels++;
  const mse = se / (opCount * 3), quantPsnr = mse ? 10 * Math.log10(255 * 255 / mse) : 99;
  const used = new Uint8Array(pal.length); for (let i = 0; i < N; i++) if (rank[i] >= 0) used[rank[i]] = 1;
  const eps = 0.06 + 0.2 * (settings.smoothness ?? 1), speck = (settings.speckle || 0);
  const state = { next: new Int32Array(2 * (W + 2) * (H + 2)).fill(-1), touched: [] };
  const boxes = pal.map(() => [W, H, -1, -1]);
  for (let i = 0; i < N; i++) for (const r of [rank[i], rank2[i]]) if (r >= 0) { const b = boxes[order[r] === undefined ? 0 : r], x = i % W, y = (i / W) | 0; if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; }
  const area = new Int32Array(pal.length); for (let i = 0; i < N; i++) if (rank[i] >= 0) area[rank[i]]++;
  const layers = []; for (let k = 0; k < pal.length; k++) if (area[k]) layers.push(k);
  layers.sort((p, q) => area[q] - area[p]); // large regions first, small ones on top
  const parts = []; let pathCount = 0;
  layers.forEach((k, li) => {
    report(20 + 74 * li / layers.length, `Tracing colour ${li + 1} of ${layers.length}…`);
    let d = '';
    for (const lp of contourLayer(k, W, H, rank, rank2, cov, cov2, boxes[k], state)) {
      if (Math.abs(area2(lp)) / 2 < speck) continue;
      d += loopToPath(simplifyClosed(lp, eps));
    }
    if (!d) return;
    const hex = pal[order[k]].map((v) => v.toString(16).padStart(2, '0')).join('');
    parts.push(`<path fill="#${hex}" stroke="#${hex}" stroke-width="0.35" stroke-linejoin="round" fill-rule="evenodd" d="${d}"/>`);
    pathCount++;
  });
  const svg = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="geometricPrecision">${parts.join('')}</svg>`;
  return { svg, pathCount, colorCount: pal.length, quantPsnr, width: W, height: H, rasterMask: rmask, vectorPixels: vecCount, rasterPixels, opCount, vectorPercent: 100 * vecCount / opCount, rasterPercent: 100 * rasterPixels / opCount, rasterUnderlayPercent: 100 * rmask.reduce((a, v) => a + v, 0) / opCount };
}
