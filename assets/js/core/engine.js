// Dependency-free hybrid vectorizer (runs in a worker, no CDN, no WASM).
// 1) error-driven palette growth (variance splitting + k-means) until a PSNR target is met,
// 2) luminance-ranked STACKED layers (layer k = every pixel with rank >= k) so no seams/gaps,
// 3) sub-pixel marching-squares contours (tile-able), 4) cubic Bezier fitting (or RDP + quadratic smoothing),
// 5) optional piecewise-linear gradient fills for smooth areas.

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
  return { pal, labelOf: (i) => lab[binOf[i]], labelLut: lab };
}


// Pick the dominant opaque colour as a vector-only fallback underlay. This is
// used only for fully opaque photographs, so small contour-fit gaps cannot
// reveal a white/transparent preview background.
function estimateDominantOpaqueColour(data, opaque) {
  const counts = new Uint32Array(NB);
  const sumsR = new Float64Array(NB), sumsG = new Float64Array(NB), sumsB = new Float64Array(NB);
  let best = -1, bestCount = 0;
  for (let i = 0; i < opaque.length; i++) {
    if (!opaque[i]) continue;
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const k = ((r >> SHIFT) << (2 * BITS)) | ((g >> SHIFT) << BITS) | (b >> SHIFT);
    const n = ++counts[k];
    sumsR[k] += r; sumsG[k] += g; sumsB[k] += b;
    if (n > bestCount) { best = k; bestCount = n; }
  }
  if (best < 0 || bestCount === 0) return '#000000';
  const hex = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + hex(sumsR[best] / bestCount) + hex(sumsG[best] / bestCount) + hex(sumsB[best] / bestCount);
}


const MS = { 1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 6: [[0, 2]], 7: [[3, 2]], 8: [[2, 3]], 9: [[2, 0]], 11: [[2, 1]], 12: [[1, 3]], 13: [[1, 0]], 14: [[0, 3]] };
// Edge codes: 0 top, 1 right, 2 bottom, 3 left. Inside is always on the left of travel (holes wind the other way,
// so fill-rule nonzero is correct and overlapping tile pieces simply union).
function contourLayer(k, rank, rank2, cov, cov2, W, box, win, st) {
  const [wx0, wy0, wx1, wy1] = win, ww = wx1 - wx0 + 1, wh = wy1 - wy0 + 1, S = ww + 2, M = S * (wh + 2), ox = wx0 - 1, oy = wy0 - 1;
  const next = st.next, touched = st.touched;
  const val = (x, y) => { if (x < wx0 || y < wy0 || x > wx1 || y > wy1) return 0; const i = y * W + x; return rank[i] === k ? cov[i] : rank2[i] === k ? cov2[i] : 0; };
  const eid = (c, x, y) => { const lx = x - ox, ly = y - oy; return c === 0 ? ly * S + lx : c === 2 ? (ly + 1) * S + lx : c === 3 ? M + ly * S + lx : M + ly * S + lx + 1; };
  for (let y = box[1] - 1; y <= box[3]; y++) for (let x = box[0] - 1; x <= box[2]; x++) {
    const tl = val(x, y), tr = val(x + 1, y), br = val(x + 1, y + 1), bl = val(x, y + 1);
    const c = (tl >= 0.5 ? 1 : 0) | (tr >= 0.5 ? 2 : 0) | (br >= 0.5 ? 4 : 0) | (bl >= 0.5 ? 8 : 0);
    if (c === 0 || c === 15) continue;
    let segs = MS[c];
    if (c === 5 || c === 10) {
      const hi = (tl + tr + br + bl) / 4 >= 0.5;
      segs = c === 5 ? (hi ? [[1, 0], [3, 2]] : [[3, 0], [1, 2]]) : (hi ? [[0, 3], [2, 1]] : [[0, 1], [2, 3]]);
    }
    for (const [from, to] of segs) { const f0 = eid(from, x, y); next[f0] = eid(to, x, y); touched.push(f0); }
  }
  const pt = (id) => {
    const v = id >= M, r = v ? id - M : id, ey = Math.floor(r / S) + oy, ex = (r % S) + ox;
    if (!v) { const a = val(ex, ey), b = val(ex + 1, ey); return [ex + 0.5 + (0.5 - a) / ((b - a) || 1), ey + 0.5]; }
    const a = val(ex, ey), b = val(ex, ey + 1); return [ex + 0.5, ey + 0.5 + (0.5 - a) / ((b - a) || 1)];
  };
  const loops = [];
  for (const start of touched) {
    if (next[start] < 0) continue;
    const pts = []; let cur = start, guard = 0;
    while (cur >= 0 && guard++ < 2e7) { pts.push(pt(cur)); const n = next[cur]; next[cur] = -1; cur = n; if (cur === start) break; }
    if (pts.length >= 3) loops.push(pts);
  }
  for (const f0 of touched) next[f0] = -1;
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

// ---- quadratic smoothing (legacy mode, `curve: "quad"`) ----
function loopToPathLinear(p) {
  if (p.length < 3) return '';
  let d = `M${f(p[0][0])} ${f(p[0][1])}`;
  for (let i = 1; i < p.length; i++) d += `L${f(p[i][0])} ${f(p[i][1])}`;
  return d + 'Z';
}

function loopToPathQuad(p) {
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

// ---- cubic Bezier fitting (Schneider least-squares with reparameterisation), corner-aware ----
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1]], vadd = (a, b) => [a[0] + b[0], a[1] + b[1]], vmul = (a, s) => [a[0] * s, a[1] * s];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1], vlen = (a) => Math.hypot(a[0], a[1]);
const vnorm = (a) => { const l = vlen(a) || 1; return [a[0] / l, a[1] / l]; };
const bez = (c, t) => { const m = 1 - t; return [m * m * m * c[0][0] + 3 * m * m * t * c[1][0] + 3 * m * t * t * c[2][0] + t * t * t * c[3][0], m * m * m * c[0][1] + 3 * m * m * t * c[1][1] + 3 * m * t * t * c[2][1] + t * t * t * c[3][1]]; };
const bez1 = (c, t) => { const m = 1 - t; return [3 * m * m * (c[1][0] - c[0][0]) + 6 * m * t * (c[2][0] - c[1][0]) + 3 * t * t * (c[3][0] - c[2][0]), 3 * m * m * (c[1][1] - c[0][1]) + 6 * m * t * (c[2][1] - c[1][1]) + 3 * t * t * (c[3][1] - c[2][1])]; };
const bez2 = (c, t) => { const m = 1 - t; return [6 * m * (c[2][0] - 2 * c[1][0] + c[0][0]) + 6 * t * (c[3][0] - 2 * c[2][0] + c[1][0]), 6 * m * (c[2][1] - 2 * c[1][1] + c[0][1]) + 6 * t * (c[3][1] - 2 * c[2][1] + c[1][1])]; };

function chordParam(P) { const u = [0]; for (let i = 1; i < P.length; i++) u.push(u[i - 1] + vlen(vsub(P[i], P[i - 1]))); const L = u[u.length - 1] || 1; return u.map((v) => v / L); }

function genBezier(P, u, t1, t2) {
  const n = P.length, P0 = P[0], P3 = P[n - 1];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < n; i++) {
    const t = u[i], m = 1 - t, b0 = m * m * m, b1 = 3 * t * m * m, b2 = 3 * t * t * m, b3 = t * t * t;
    const a1 = vmul(t1, b1), a2 = vmul(t2, b2);
    c00 += vdot(a1, a1); c01 += vdot(a1, a2); c11 += vdot(a2, a2);
    const tmp = vsub(P[i], vadd(vmul(P0, b0 + b1), vmul(P3, b2 + b3)));
    x0 += vdot(a1, tmp); x1 += vdot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01, seg = vlen(vsub(P3, P0));
  let aL = 0, aR = 0;
  if (Math.abs(det) > 1e-12) { aL = (x0 * c11 - x1 * c01) / det; aR = (c00 * x1 - c01 * x0) / det; }
  if (aL < 1e-6 * seg || aR < 1e-6 * seg) aL = aR = seg / 3;
  return [P0, vadd(P0, vmul(t1, aL)), vadd(P3, vmul(t2, aR)), P3];
}

function reparam(P, u, c) {
  return u.map((t, i) => {
    const q = bez(c, t), d1 = bez1(c, t), d2 = bez2(c, t), diff = vsub(q, P[i]);
    const num = vdot(diff, d1), den = vdot(d1, d1) + vdot(diff, d2);
    return den ? Math.max(0, Math.min(1, t - num / den)) : t;
  });
}

function bezErr(P, c, u) {
  let md = 0, mi = Math.floor(P.length / 2);
  for (let i = 1; i < P.length - 1; i++) { const d = vlen(vsub(bez(c, u[i]), P[i])); if (d > md) { md = d; mi = i; } }
  return [md, mi];
}

function fitCubic(P, t1, t2, tol, out, depth) {
  const n = P.length;
  if (n === 2) { const d = vlen(vsub(P[1], P[0])) / 3; out.push([vadd(P[0], vmul(t1, d)), vadd(P[1], vmul(t2, d)), P[1]]); return; }
  let u = chordParam(P), c = genBezier(P, u, t1, t2), [err, idx] = bezErr(P, c, u);
  if (err <= tol) { out.push(c.slice(1)); return; }
  for (let it = 0; it < 5 && err <= tol * 12; it++) {
    u = reparam(P, u, c); c = genBezier(P, u, t1, t2); [err, idx] = bezErr(P, c, u);
    if (err <= tol) { out.push(c.slice(1)); return; }
  }
  if (depth > 14 || n < 5) { out.push(c.slice(1)); return; }
  idx = Math.max(1, Math.min(n - 2, idx));
  const tc = vnorm(vmul(vadd(vsub(P[idx - 1], P[idx]), vsub(P[idx], P[idx + 1])), 0.5));
  fitCubic(P.slice(0, idx + 1), t1, tc, tol, out, depth + 1);
  fitCubic(P.slice(idx), vmul(tc, -1), t2, tol, out, depth + 1);
}

function findCorners(P) {
  const n = P.length, ang = new Float32Array(n), R = 4.5;
  let total = 0; for (let i = 0; i < n; i++) total += vlen(vsub(P[(i + 1) % n], P[i]));
  if (total < 14) return [];
  const walk = (i, dir) => { let j = i, d = 0, steps = 0; const pts = [P[i]]; while (d < R && steps < 14) { const nj = (j + dir + n) % n; d += vlen(vsub(P[nj], P[j])); j = nj; pts.push(P[j]); steps++; } return { j, d, pts }; };
  const straight = (w, tol) => { const a = w.pts[0], b = w.pts[w.pts.length - 1], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1; let m = 0; for (const q of w.pts) m = Math.max(m, Math.abs((q[0] - a[0]) * dy - (q[1] - a[1]) * dx) / L); return m <= tol; };
  for (let i = 0; i < n; i++) {
    const wb = walk(i, -1), wf = walk(i, 1);
    if (wb.d < R * 0.8 || wf.d < R * 0.8) continue;
    const a = vsub(P[i], P[wb.j]), b = vsub(P[wf.j], P[i]), la = vlen(a), lb = vlen(b);
    if (la < 2 || lb < 2) continue;
    if (!straight(wb, 0.4) || !straight(wf, 0.4)) continue; // both arms must be genuinely straight
    ang[i] = Math.acos(Math.max(-1, Math.min(1, vdot(a, b) / (la * lb))));
  }
  const corners = [];
  for (let i = 0; i < n; i++) {
    if (ang[i] < 0.9) continue; // ~52 degrees
    let isMax = true;
    for (let d = 1; d <= 7 && isMax; d++) {
      const forward = ang[(i + d) % n];
      const backward = ang[(i - d + n) % n];
      if (forward > ang[i] || backward >= ang[i]) isMax = false;
    }
    if (isMax) corners.push(i);
  }
  return corners;
}

function loopToPathBezier(L, tol, smooth = true) {
  const P = [];
  for (const q of L) { const l = P[P.length - 1]; if (!l || Math.abs(l[0] - q[0]) + Math.abs(l[1] - q[1]) > 1e-3) P.push(q); }
  if (P.length > 1 && Math.abs(P[0][0] - P[P.length - 1][0]) + Math.abs(P[0][1] - P[P.length - 1][1]) < 1e-3) P.pop();
  const n = P.length;
  if (n < 3) return '';
  const cornerIdx = findCorners(P), frozen = new Set(cornerIdx);
  let Q = P;
  for (let pass = 0; pass < (smooth ? 2 : 0); pass++) {
    const R = Q.map((q, i) => (frozen.has(i) ? q : [(Q[(i + n - 1) % n][0] + 2 * q[0] + Q[(i + 1) % n][0]) / 4, (Q[(i + n - 1) % n][1] + 2 * q[1] + Q[(i + 1) % n][1]) / 4]));
    Q = R;
  }
  for (let i = 0; i < n; i++) P[i] = Q[i];
  let br = cornerIdx.map((i) => [i, true]);
  if (br.length === 0) br = [[0, false], [n >> 1, false]];
  else if (br.length === 1) br.push([(br[0][0] + (n >> 1)) % n, false]);
  br.sort((a, b) => a[0] - b[0]);
  const K = 4, idx = (i) => ((i % n) + n) % n;
  const fwd = (b, corner, k) => vnorm(corner ? vsub(P[idx(b + k)], P[b]) : vsub(P[idx(b + k)], P[idx(b - k)]));
  const bwd = (b, corner, k) => vnorm(corner ? vsub(P[idx(b - k)], P[b]) : vsub(P[idx(b - k)], P[idx(b + k)]));
  let d = `M${f(P[br[0][0]][0])} ${f(P[br[0][0]][1])}`;
  for (let r = 0; r < br.length; r++) {
    const [s, sc] = br[r], [e, ec] = br[(r + 1) % br.length];
    const len = ((e - s + n) % n) || n;
    const run = []; for (let j = 0; j <= len; j++) run.push(P[idx(s + j)]);
    const k = Math.max(1, Math.min(K, len >> 1));
    const out = [];
    fitCubic(run, fwd(s, sc, k), bwd(e, ec, k), tol, out, 0);
    let cur = run[0];
    for (const c of out) {
      if (c.length === 3) {
        const ch = vsub(c[2], cur), cl = vlen(ch) || 1;
        const dev = Math.max(Math.abs(vdot(vsub(c[0], cur), [-ch[1] / cl, ch[0] / cl])), Math.abs(vdot(vsub(c[1], cur), [-ch[1] / cl, ch[0] / cl])));
        d += dev < 0.04 ? `L${f(c[2][0])} ${f(c[2][1])}` : `C${f(c[0][0])} ${f(c[0][1])} ${f(c[1][0])} ${f(c[1][1])} ${f(c[2][0])} ${f(c[2][1])}`;
        cur = c[2];
      }
    }
  }
  return d + 'Z';
}

// ---- gradient fills: piecewise-planar colour model (rank-1: one direction, 3-channel slope) ----
function buildSmoothGradientMask(data, opaque, W, H, noise) {
  const N = W * H;
  const candidate = new Uint8Array(N);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const index = y * W + x;
    if (!opaque[index] || data[index * 4 + 3] !== 255) continue;
    let ok = true;
    for (let channel = 0; channel < 3 && ok; channel++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const row = (y + dy) * W;
        for (let dx = -1; dx <= 1; dx++) sum += data[(row + x + dx) * 4 + channel];
      }
      if (Math.abs(data[index * 4 + channel] - sum / 9) > noise) ok = false;
    }
    if (ok) candidate[index] = 1;
  }
  return candidate;
}

function fitGradient(list, W, data) {
  const n = list.length; let mx = 0, my = 0, mr = 0, mg = 0, mb = 0;
  for (const i of list) { mx += i % W; my += (i / W) | 0; mr += data[i * 4]; mg += data[i * 4 + 1]; mb += data[i * 4 + 2]; }
  mx /= n; my /= n; mr /= n; mg /= n; mb /= n;
  let sxx = 0, sxy = 0, syy = 0; const sxc = [0, 0, 0], syc = [0, 0, 0];
  for (const i of list) {
    const x = (i % W) - mx, y = ((i / W) | 0) - my, r = data[i * 4] - mr, g = data[i * 4 + 1] - mg, b = data[i * 4 + 2] - mb;
    sxx += x * x; sxy += x * y; syy += y * y; sxc[0] += x * r; sxc[1] += x * g; sxc[2] += x * b; syc[0] += y * r; syc[1] += y * g; syc[2] += y * b;
  }
  const det = sxx * syy - sxy * sxy;
  if (Math.abs(det) < 1e-9) return null;
  const B = [0, 1, 2].map((c) => [(sxc[c] * syy - syc[c] * sxy) / det, (syc[c] * sxx - sxc[c] * sxy) / det]);
  const m00 = B.reduce((a, r) => a + r[0] * r[0], 0), m01 = B.reduce((a, r) => a + r[0] * r[1], 0), m11 = B.reduce((a, r) => a + r[1] * r[1], 0);
  const th = 0.5 * Math.atan2(2 * m01, m00 - m11), d = [Math.cos(th), Math.sin(th)];
  const s = B.map((r) => r[0] * d[0] + r[1] * d[1]);
  return { mx, my, mean: [mr, mg, mb], d, s };
}

function gradientPass(vec, opaque, rank, cov, rank2, data, W, H, palLen, settings, fills, candidateMask = null) {
  const N = W * H, gTol = settings.gradTol ?? ((settings.tol ?? 4) + 2), gMin = Math.max(300, (settings.minVectorArea ?? 48) * 6), noise = settings.gradNoise ?? 4;
  const cand = candidateMask || new Uint8Array(N);
  if (!candidateMask) {
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x; if (vec[i] || !opaque[i] || data[i * 4 + 3] !== 255) continue;
      let ok = 1;
      for (let c = 0; c < 3 && ok; c++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += data[((y + dy) * W + x + dx) * 4 + c];
        if (Math.abs(data[i * 4 + c] - s / 9) > noise) ok = 0;
      }
      cand[i] = ok;
    }
  }
  const seen = new Uint8Array(N), stack = new Int32Array(N);
  const accept = (list) => {
    const fit = fitGradient(list, W, data); if (!fit) return false;
    const res = (i) => { const t = ((i % W) - fit.mx) * fit.d[0] + (((i / W) | 0) - fit.my) * fit.d[1]; let m = 0; for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(data[i * 4 + c] - (fit.mean[c] + fit.s[c] * t))); return m; };
    let inl = list.filter((i) => res(i) <= gTol);
    if (inl.length < 0.9 * list.length || inl.length < gMin) return false;
    const fit2 = fitGradient(inl, W, data) || fit;
    const res2 = (i) => { const t = ((i % W) - fit2.mx) * fit2.d[0] + (((i / W) | 0) - fit2.my) * fit2.d[1]; let m = 0; for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(data[i * 4 + c] - (fit2.mean[c] + fit2.s[c] * t))); return m; };
    inl = inl.filter((i) => res2(i) <= gTol);
    if (inl.length < gMin) return false;
    let tmin = Infinity, tmax = -Infinity;
    for (const i of inl) { const t = ((i % W) - fit2.mx) * fit2.d[0] + (((i / W) | 0) - fit2.my) * fit2.d[1]; if (t < tmin) tmin = t; if (t > tmax) tmax = t; }
    const col = (t) => fit2.mean.map((m, c) => Math.max(0, Math.min(255, Math.round(m + fit2.s[c] * t))));
    const c0 = col(tmin), c1 = col(tmax), span = Math.max(...c0.map((v, c) => Math.abs(v - c1[c])));
    const hex = (c) => c.map((v) => v.toString(16).padStart(2, '0')).join('');
    const def = span < 2 ? { solid: hex(col((tmin + tmax) / 2)) }
      : { x1: fit2.mx + 0.5 + fit2.d[0] * tmin, y1: fit2.my + 0.5 + fit2.d[1] * tmin, x2: fit2.mx + 0.5 + fit2.d[0] * tmax, y2: fit2.my + 0.5 + fit2.d[1] * tmax, c0: hex(c0), c1: hex(c1) };
    const rk = palLen + fills.length; fills.push(def);
    for (const i of inl) { vec[i] = 1; rank[i] = rk; cov[i] = 1; rank2[i] = -1; }
    return true;
  };
  const split = (list, depth) => {
    if (accept(list)) return;
    if (depth >= 6 || list.length < gMin * 2) return;
    let x0 = W, x1 = 0, y0 = H, y1 = 0;
    for (const i of list) { const x = i % W, y = (i / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const useX = x1 - x0 >= y1 - y0, key = (i) => (useX ? i % W : (i / W) | 0);
    let m = 0; for (const i of list) m += key(i); m /= list.length;
    const a = [], b = []; for (const i of list) (key(i) <= m ? a : b).push(i);
    if (a.length && b.length) { split(a, depth + 1); split(b, depth + 1); }
  };
  for (let s0 = 0; s0 < N; s0++) {
    if (!cand[s0] || seen[s0]) continue;
    let sp = 0; const comp = [s0]; stack[sp++] = s0; seen[s0] = 1;
    while (sp) {
      const q = stack[--sp], x = q % W;
      for (const m of [x > 0 ? q - 1 : -1, x < W - 1 ? q + 1 : -1, q >= W ? q - W : -1, q < N - W ? q + W : -1]) if (m >= 0 && cand[m] && !seen[m]) { seen[m] = 1; stack[sp++] = m; comp.push(m); }
    }
    if (comp.length >= gMin) split(comp, 0);
  }
}

const HYBRID_PROFILE_ADJUSTMENTS = Object.freeze({
  auto: { tolerance: 1, minArea: 1 },
  photo: { tolerance: 0.7, minArea: 1.75 },
  illustration: { tolerance: 0.95, minArea: 0.9 },
  poster: { tolerance: 1.5, minArea: 0.75 },
  logo: { tolerance: 2, minArea: 0.5 }
});

export function resolveHybridProfile(settings) {
  const adjustment = HYBRID_PROFILE_ADJUSTMENTS[settings.profile || 'auto'] || HYBRID_PROFILE_ADJUSTMENTS.auto;
  const baseTolerance = Number.isFinite(settings.tol) ? settings.tol : 8;
  const baseArea = Number.isFinite(settings.minVectorArea) ? settings.minVectorArea : 64;
  return {
    ...settings,
    tol: Math.max(1, Math.min(32, Math.round(baseTolerance * adjustment.tolerance))),
    minVectorArea: Math.max(1, Math.min(2048, Math.round(baseArea * adjustment.minArea)))
  };
}

export function prepareHybridPalette(img, settings, report = () => {}) {
  const { width, height, data } = img, N = width * height;
  const opaque = new Uint8Array(N); let opCount = 0;
  for (let i = 0; i < N; i++) if (data[i * 4 + 3] > 0) { opaque[i] = 1; opCount++; }
  if (!opCount) throw new Error('The image is fully transparent.');
  const maxColors = Math.max(2, Math.min(512, settings.colors || 256));
  const targetPsnr = Math.max(25, Math.min(60, settings.targetPsnr || 44));
  report(8, 'Growing the palette until the fidelity target is met…');
  const palette = buildPalette(data, N, opaque, maxColors, targetPsnr, (m) => report(14, m));
  return { ...palette, opaque, opCount, width, height };
}

export function traceHybridPure(img, settings, report = () => {}, prepared = null) {
  const { width: W, height: H, data } = img, N = W * H;
  const paletteData = prepared || prepareHybridPalette(img, settings, report);
  const { opaque, opCount, pal, labelOf, assignments, edgeMask, gpuBackend = 'cpu', gpuEdgePixels = 0 } = paletteData;
  const pureVector = settings.pureVector === true;
  if (pureVector) {
    for (let i = 0; i < N; i++) {
      const alpha = data[i * 4 + 3];
      if (alpha > 0 && alpha < 255) {
        throw new Error('Pure Vector Photo cannot preserve semi-transparent pixels yet. Use Hybrid Vector or Pixel-Exact mode for this image.');
      }
    }
  }
  if (opaque.length !== N || !Array.isArray(pal) || typeof labelOf !== 'function') throw new Error('Prepared palette data is invalid.');
  if (assignments && assignments.length !== N) throw new Error('GPU palette assignment length does not match the image.');
  if (edgeMask && edgeMask.length !== N) throw new Error('GPU edge mask length does not match the image.');
  const order = pal.map((c, i) => i).sort((a, b) => (0.299 * pal[a][0] + 0.587 * pal[a][1] + 0.114 * pal[a][2]) - (0.299 * pal[b][0] + 0.587 * pal[b][1] + 0.114 * pal[b][2]));
  const rankOfLabel = new Int32Array(pal.length); order.forEach((l, r) => { rankOfLabel[l] = r; });
  const rank = new Int32Array(N).fill(-1);
  let se = 0;
  for (let i = 0; i < N; i++) if (opaque[i]) {
    const l = assignments ? assignments[i] : labelOf(i);
    if (!Number.isInteger(l) || l < 0 || l >= pal.length) throw new Error('Palette assignment returned an invalid colour index.');
    rank[i] = rankOfLabel[l];
    const c = pal[l]; se += (c[0] - data[i * 4]) ** 2 + (c[1] - data[i * 4 + 1]) ** 2 + (c[2] - data[i * 4 + 2]) ** 2;
  }
  // Vector eligibility: pixel colour within `tol` of its palette colour AND part of a coherent same-colour region.
  const tol = settings.tol ?? 8, minArea = Math.max(1, settings.minVectorArea ?? 64);
  const ok = new Uint8Array(N);
  const gradientNoise = Math.max(0, Math.min(24, settings.gradNoise ?? 5));
  const pureGradientMask = pureVector && settings.gradients
    ? buildSmoothGradientMask(data, opaque, W, H, gradientNoise)
    : null;
  for (let i = 0; i < N; i++) if (rank[i] >= 0) {
    const c = pal[order[rank[i]]];
    const fullyOpaque = data[i * 4 + 3] === 255;
    const withinTolerance = pureVector || (fullyOpaque && Math.max(Math.abs(c[0] - data[i * 4]), Math.abs(c[1] - data[i * 4 + 1]), Math.abs(c[2] - data[i * 4 + 2])) <= tol);
    const protectEdge = !pureVector && settings.edgeProtection !== false && !!edgeMask?.[i];
    const reserveForGradient = !!pureGradientMask?.[i];
    ok[i] = withinTolerance && !protectEdge && !reserveForGradient ? 1 : 0;
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
  // Crisp edges: anti-aliased pixels that blend two neighbouring vector colours join the nearer one with sub-pixel coverage.
  const cov = new Float32Array(N).fill(1), rank2 = new Int16Array(N).fill(-1), cov2 = new Float32Array(N);
  if (!pureVector) {
    const add = [];
    for (let i = 0; i < N; i++) {
      if (vec[i] || !opaque[i] || data[i * 4 + 3] !== 255 || (settings.edgeProtection !== false && edgeMask?.[i])) continue;
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
  const fills = [];
  if (settings.gradients) { report(18, 'Fitting gradient fills to smooth areas…'); gradientPass(vec, opaque, rank, cov, rank2, data, W, H, pal.length, { ...settings, tol }, fills, pureGradientMask); }
  if (pureVector) {
    for (let i = 0; i < N; i++) if (opaque[i] && !vec[i]) vec[i] = 1;
  }
  let vecCount = 0;
  for (let i = 0; i < N; i++) { if (vec[i]) vecCount++; else rank[i] = -1; }
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
  if (settings.underlay === 'full') rmask.set(opaque); // full raster underlay: seams between vector shapes reveal true pixels, never the page background
  for (let i = 0; i < N; i++) if (opaque[i] && !vec[i]) rasterPixels++;
  const mse = se / (opCount * 3), quantPsnr = mse ? 10 * Math.log10(255 * 255 / mse) : 99;

  // ---- contour tracing, optionally in tiles ----
  const total = pal.length + fills.length, speck = settings.speckle || 0;
  const bezier = (settings.curve || 'bezier') === 'bezier';
  const eps = 0.06 + 0.2 * (settings.smoothness ?? 1), btol = pureVector ? 0.03 : (0.08 + 0.17 * (settings.smoothness ?? 1));
  let T = settings.tileSize === 'auto' || settings.tileSize === undefined ? (N > 4e6 ? 1024 : 0) : Number(settings.tileSize) || 0;
  if (T && T >= Math.max(W, H)) T = 0;
  const PAD = 2, tilesX = T ? Math.ceil(W / T) : 1, tilesY = T ? Math.ceil(H / T) : 1;
  const maxWin = T ? T + 2 * PAD : Math.max(W, H);
  const state = { next: new Int32Array(2 * (T ? (maxWin + 2) * (maxWin + 2) : (W + 2) * (H + 2))).fill(-1), touched: [] };
  const area = new Int32Array(total); for (let i = 0; i < N; i++) if (rank[i] >= 0) area[rank[i]]++;
  const dOf = new Array(total).fill('');
  for (let ty = 0; ty < tilesY; ty++) for (let tx = 0; tx < tilesX; tx++) {
    const cx0 = T ? tx * T : 0, cy0 = T ? ty * T : 0, cx1 = T ? Math.min(W, cx0 + T) : W, cy1 = T ? Math.min(H, cy0 + T) : H;
    const win = T ? [Math.max(0, cx0 - PAD), Math.max(0, cy0 - PAD), Math.min(W - 1, cx1 - 1 + PAD), Math.min(H - 1, cy1 - 1 + PAD)] : [0, 0, W - 1, H - 1];
    report(20 + 74 * (ty * tilesX + tx) / (tilesX * tilesY), tilesX * tilesY > 1 ? `Tracing tile ${ty * tilesX + tx + 1} of ${tilesX * tilesY}…` : 'Tracing contours…');
    const boxes = new Map();
    for (let y = win[1]; y <= win[3]; y++) for (let x = win[0]; x <= win[2]; x++) {
      const i = y * W + x;
      for (const r of (rank2[i] >= 0 && rank[i] >= 0 ? [rank[i], rank2[i]] : [rank[i]])) {
        if (r < 0) continue;
        let b = boxes.get(r); if (!b) { b = [x, y, x, y]; boxes.set(r, b); }
        if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
      }
    }
    for (const [k, box] of boxes) {
      if (k >= total) continue;
      for (const lp of contourLayer(k, rank, rank2, cov, cov2, W, box, win, state)) {
        if (speck > 0) {
          let cut = false;
          for (const q of lp) if ((win[0] > 0 && q[0] <= win[0] + 0.01) || (win[2] < W - 1 && q[0] >= win[2] + 0.99) || (win[1] > 0 && q[1] <= win[1] + 0.01) || (win[3] < H - 1 && q[1] >= win[3] + 0.99)) { cut = true; break; }
          if (!cut && Math.abs(area2(lp)) / 2 < speck) continue;
        }
        dOf[k] += bezier ? loopToPathBezier(lp, btol, !pureVector) : (pureVector ? loopToPathLinear(lp) : loopToPathQuad(simplifyClosed(lp, eps)));
      }
    }
  }
  const layers = []; for (let k = 0; k < total; k++) if (dOf[k]) layers.push(k);
  layers.sort((p, q) => area[q] - area[p]); // large regions first, small ones on top
  const hexOf = (c) => c.map((v) => v.toString(16).padStart(2, '0')).join('');
  const defs = []; const parts = []; let pathCount = 0, gradientCount = 0;
  for (const k of layers) {
    let paint;
    if (k < pal.length) paint = '#' + hexOf(pal[order[k]]);
    else {
      const g = fills[k - pal.length];
      if (g.solid) paint = '#' + g.solid;
      else { const id = 'g' + gradientCount++; defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f(g.x1)}" y1="${f(g.y1)}" x2="${f(g.x2)}" y2="${f(g.y2)}"><stop offset="0" stop-color="#${g.c0}"/><stop offset="1" stop-color="#${g.c1}"/></linearGradient>`); paint = `url(#${id})`; }
    }
    parts.push(`<path fill="${paint}" stroke="${paint}" stroke-width="${pureVector ? 0.55 : 0.35}" stroke-linejoin="round" d="${dOf[k]}"/>`);
    pathCount++;
  }
  const background = pureVector && opCount === N ? `<path fill="${estimateDominantOpaqueColour(data, opaque)}" d="M0 0H${W}V${H}H0Z"/>` : '';
  const svg = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="geometricPrecision">${defs.length ? `<defs>${defs.join('')}</defs>` : ''}${background}${parts.join('')}</svg>`;
  return { svg, pathCount: pathCount + (background ? 1 : 0), colorCount: pal.length, gradientCount, gradientPieces: fills.length, tiles: tilesX * tilesY, quantPsnr, width: W, height: H, rasterMask: rmask, vectorPixels: vecCount, rasterPixels, opCount, vectorPercent: 100 * vecCount / opCount, rasterPercent: 100 * rasterPixels / opCount, rasterUnderlayPercent: 100 * rmask.reduce((a, v) => a + v, 0) / opCount, gpuBackend, gpuEdgePixels };
}
