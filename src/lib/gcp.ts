// Pure logic: parse GCP/XMP, project GCPs into drone images, detect checker targets, export ODM gcp_list.

export type Gcp = { name: string; lon: number; lat: number; z: number };
export type Cam = {
  lat: number; lon: number; alt: number; // AbsoluteAltitude, same datum as GCP z (RTK ellipsoidal here)
  yaw: number; pitch: number; roll: number; // gimbal degrees
  f: number; cx: number; cy: number; w: number; h: number; // pixels
};
export type Pt = { x: number; y: number };
export type Detection = Pt & { score: number };

/** "EPSG:4326" header, then `name lon lat z` per line. */
export function parseGcpText(text: string): Gcp[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] && !/^EPSG:4326$/i.test(lines[0]) && !/^[\w-]+\s+-?\d/.test(lines[0]))
    throw new Error(`รองรับเฉพาะ EPSG:4326 (บรรทัดแรก: ${lines[0]})`);
  return lines
    .filter((l) => !/^EPSG/i.test(l))
    .map((l, i) => {
      const [name, lon, lat, z] = l.split(/[\s,]+/);
      const g = { name, lon: +lon, lat: +lat, z: +z };
      if (![g.lon, g.lat, g.z].every(Number.isFinite) || Math.abs(g.lat) > 90 || Math.abs(g.lon) > 180)
        throw new Error(`บรรทัด ${i + 1} ไม่ถูกต้อง: ${l}`);
      return g;
    });
}

/** Reads DJI XMP (drone-dji:*) from the head of a JPEG. Returns null if it is not a DJI nadir-capable image. */
export function parseXmp(head: string, w: number, h: number): Cam | null {
  const num = (k: string) => {
    const m = head.match(new RegExp(`${k}="([^"]+)"`));
    return m ? parseFloat(m[1]) : NaN;
  };
  const cam: Cam = {
    lat: num("drone-dji:GpsLatitude"), lon: num("drone-dji:GpsLongitude"), alt: num("drone-dji:AbsoluteAltitude"),
    yaw: num("drone-dji:GimbalYawDegree"), pitch: num("drone-dji:GimbalPitchDegree"), roll: num("drone-dji:GimbalRollDegree"),
    f: num("drone-dji:CalibratedFocalLength"), cx: num("drone-dji:CalibratedOpticalCenterX"),
    cy: num("drone-dji:CalibratedOpticalCenterY"), w, h,
  };
  if (![cam.lat, cam.lon, cam.alt, cam.yaw].every(Number.isFinite)) return null;
  // shortcut: falls back to a 24mm-equiv guess when DJI calibration tags are missing; read lens EXIF if other drones are used.
  if (!Number.isFinite(cam.f)) cam.f = w * 0.7;
  if (!Number.isFinite(cam.cx)) cam.cx = w / 2;
  if (!Number.isFinite(cam.cy)) cam.cy = h / 2;
  if (!Number.isFinite(cam.pitch)) cam.pitch = -90;
  if (!Number.isFinite(cam.roll)) cam.roll = 0;
  return cam;
}

/**
 * Nadir pinhole projection, flat local tangent plane.
 * shortcut: ignores lens distortion and assumes pitch ≈ -90°; residual is absorbed by the detector's search window.
 * DJI M4E reports GimbalRoll=180 for nadir shots, which flips image axes (verified against hand-marked points).
 */
export function project(cam: Cam, g: Gcp): Pt {
  const east = (g.lon - cam.lon) * 111320 * Math.cos((cam.lat * Math.PI) / 180);
  const north = (g.lat - cam.lat) * 110540;
  const hgt = cam.alt - g.z;
  const y = (cam.yaw * Math.PI) / 180;
  const right = east * Math.cos(y) - north * Math.sin(y);
  const fwd = east * Math.sin(y) + north * Math.cos(y);
  const flip = Math.abs(Math.abs(cam.roll) - 180) < 45 ? -1 : 1;
  return { x: cam.cx + (flip * cam.f * right) / hgt, y: cam.cy - (flip * cam.f * fwd) / hgt };
}

/** Ground sample distance (m/px) at the GCP. */
export const gsd = (cam: Cam, g: Gcp) => (cam.alt - g.z) / cam.f;

/**
 * Finds a 2×2 red/white checker target in an RGBA crop.
 * Two diagonal red quadrants of similar size, whose other diagonal is white; centre = midpoint of the red centroids.
 * `hint` is the projected position inside the crop; `quadPx` the expected quadrant side in pixels.
 */
export function detectTarget(rgba: Uint8ClampedArray, w: number, h: number, hint: Pt, quadPx: number): Detection | null {
  const n = w * h;
  const red = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    // relative thresholds: targets in shade drop to ~(100,30,57) red and bluish ~(145,177,215) white
    red[i] = r > 60 && r - Math.max(g, b) > 35 && g < 0.45 * r && b < 0.7 * r ? 1 : 0;
  }
  const isWhite = (x: number, y: number, minLevel: number) => {
    const i = (y * w + x) * 4;
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    // white paper is neutral or bluish (shade); pink roof tiles are bright but reddish
    return Math.min(r, g, b) > minLevel && r - Math.max(g, b) < 25;
  };

  // connected components (4-neighbour)
  type Blob = { area: number; x: number; y: number; r: number };
  const blobs: Blob[] = [];
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const minA = (quadPx * 0.4) ** 2, maxA = (quadPx * 2.5) ** 2;
  for (let s = 0; s < n; s++) {
    if (!red[s] || seen[s]) continue;
    let top = 0, area = 0, sx = 0, sy = 0, sr = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
    stack[top++] = s; seen[s] = 1;
    while (top) {
      const p = stack[--top], px = p % w, py = (p / w) | 0;
      area++; sx += px; sy += py; sr += rgba[p * 4];
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
      for (const q of [px > 0 ? p - 1 : -1, px < w - 1 ? p + 1 : -1, py > 0 ? p - w : -1, py < h - 1 ? p + w : -1])
        if (q >= 0 && red[q] && !seen[q]) { seen[q] = 1; stack[top++] = q; }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    // a quadrant is a solid square: fill ≥ 0.5 even at 45°, bbox roughly square
    if (area >= minA && area <= maxA && area / (bw * bh) > 0.4 && Math.max(bw, bh) / Math.min(bw, bh) < 2)
      blobs.push({ area, x: sx / area, y: sy / area, r: sr / area });
  }

  const frac = (cx: number, cy: number, r: number, test: (x: number, y: number) => boolean) => {
    let hit = 0, tot = 0;
    for (let y = Math.round(cy - r); y <= cy + r; y++)
      for (let x = Math.round(cx - r); x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        tot++; if (test(x, y)) hit++;
      }
    return tot ? hit / tot : 0;
  };
  const isRed = (x: number, y: number) => red[y * w + x] === 1;

  let best: Detection | null = null;
  const sigma = Math.max(w, h) / 3;
  for (let i = 0; i < blobs.length; i++)
    for (let j = i + 1; j < blobs.length; j++) {
      const a = blobs[i], b = blobs[j];
      const ratio = Math.min(a.area, b.area) / Math.max(a.area, b.area);
      if (ratio < 0.5) continue;
      const side = Math.sqrt((a.area + b.area) / 2);
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
      if (d / side < 1.15 || d / side > 2.3) continue; // diagonal neighbours ≈ √2 · side; shaded quadrants erode to ~1.9
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      // other diagonal: rotate the red→red vector 90°
      const ox = -dy / 2, oy = dx / 2, r = side * 0.35;
      // white paper is brighter in every channel than the red paper's R under the same light
      const lvl = Math.max(60, 0.8 * (a.r + b.r) / 2);
      const isW = (x: number, y: number) => isWhite(x, y, lvl);
      const white = Math.min(frac(mx + ox, my + oy, r, isW), frac(mx - ox, my - oy, r, isW));
      if (white < 0.3) continue;
      // the target sits on ground: one cell beyond each red quadrant must not be red again (rejects tiled roofs)
      if (Math.max(frac(mx + dx * 1.25, my + dy * 1.25, r, isRed), frac(mx - dx * 1.25, my - dy * 1.25, r, isRed)) > 0.4) continue;
      const dist = Math.hypot(mx - hint.x, my - hint.y);
      const score = Math.min(1, white / 0.7) * ratio * Math.exp(-(dist * dist) / (2 * sigma * sigma));
      if (!best || score > best.score) best = { x: mx, y: my, score };
    }
  return best;
}

export type Gray = { data: Float32Array; w: number; h: number };

export function toGray(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Gray {
  const data = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) data[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  return { data, w, h };
}

/** Linear map ground offset (east, north metres) → image offset (px), same model as `project`. */
export function groundToImage(cam: Cam, g: Gcp): [number, number, number, number] {
  const y = (cam.yaw * Math.PI) / 180, flip = Math.abs(Math.abs(cam.roll) - 180) < 45 ? -1 : 1;
  const s = (flip * cam.f) / (cam.alt - g.z), c = Math.cos(y), n = Math.sin(y);
  return [s * c, -s * n, -s * n, -s * c];
}
const mul = (a: number[], b: number[]) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3]];
const inv = (m: number[]) => { const d = m[0] * m[3] - m[1] * m[2]; return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d]; };
/** Maps an image offset in `to` into the matching image offset in `from` (rotation from yaw, scale from height). */
export const imageToImage = (from: Cam, to: Cam, g: Gcp) => mul(groundToImage(from, g), inv(groundToImage(to, g)));

function bilinear(im: Gray, x: number, y: number) {
  x = Math.max(0, Math.min(im.w - 1.001, x)); y = Math.max(0, Math.min(im.h - 1.001, y));
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * im.w + x0, d = im.data;
  return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + im.w] * (1 - fx) + d[i + im.w + 1] * fx) * fy;
}

/** Normalised cross-correlation of template `t` (side×side, zero-mean, unit-norm) centred at (cx, cy) in `im`, sampled every `step` px. */
function ncc(im: Gray, t: Float32Array, side: number, step: number, cx: number, cy: number) {
  const half = (side - 1) / 2;
  let s = 0, s2 = 0, st = 0;
  for (let v = 0; v < side; v++)
    for (let u = 0; u < side; u++) {
      const p = bilinear(im, cx + (u - half) * step, cy + (v - half) * step), k = t[v * side + u];
      s += p; s2 += p * p; st += p * k;
    }
  const n = side * side, varP = s2 - (s * s) / n;
  return varP > 1e-6 ? st / Math.sqrt(varP) : 0; // Σt = 0 so the mean term drops out
}

/**
 * Finds the point marked in `seed` inside `target` by template matching, for any target design.
 * The seed patch is warped by `T` (target px → seed px, from imageToImage) so yaw/height differences are removed.
 * Coarse grid over the whole crop, then a full-resolution refine. Score = NCC in [-1, 1].
 */
export function matchTemplate(seed: Gray, seedPt: Pt, T: number[], target: Gray, hint: Pt, radiusPx: number): Detection | null {
  const step = Math.max(1, Math.floor(radiusPx / 12));
  const build = (stp: number) => {
    const half = Math.round(radiusPx / stp), side = 2 * half + 1, t = new Float32Array(side * side);
    for (let v = 0; v < side; v++)
      for (let u = 0; u < side; u++) {
        const du = (u - half) * stp, dv = (v - half) * stp;
        t[v * side + u] = bilinear(seed, seedPt.x + T[0] * du + T[1] * dv, seedPt.y + T[2] * du + T[3] * dv);
      }
    const mean = t.reduce((a, b) => a + b, 0) / t.length;
    let norm = 0;
    for (let i = 0; i < t.length; i++) { t[i] -= mean; norm += t[i] * t[i]; }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < t.length; i++) t[i] /= norm;
    return { t, side };
  };

  // coarse: every `step` px, weighted toward the hint so a look-alike far away loses
  const c = build(step), sigma = Math.max(target.w, target.h) / 3;
  let best = { x: 0, y: 0, v: -Infinity };
  for (let y = radiusPx; y < target.h - radiusPx; y += step)
    for (let x = radiusPx; x < target.w - radiusPx; x += step) {
      const v = ncc(target, c.t, c.side, step, x, y) * Math.exp(-((x - hint.x) ** 2 + (y - hint.y) ** 2) / (2 * sigma * sigma));
      if (v > best.v) best = { x, y, v };
    }
  if (best.v === -Infinity) return null;

  // refine at full resolution, then sub-pixel parabola
  const f = build(1), at = (x: number, y: number) => ncc(target, f.t, f.side, 1, x, y);
  let bx = best.x, by = best.y, bv = at(bx, by);
  for (let y = best.y - step; y <= best.y + step; y++)
    for (let x = best.x - step; x <= best.x + step; x++) {
      const v = at(x, y);
      if (v > bv) { bx = x; by = y; bv = v; }
    }
  const sub = (m: number, z: number, p: number) => (m - 2 * z + p < 0 ? (0.5 * (m - p)) / (m - 2 * z + p) : 0);
  return {
    x: bx + sub(at(bx - 1, by), bv, at(bx + 1, by)),
    y: by + sub(at(bx, by - 1), bv, at(bx, by + 1)),
    score: bv,
  };
}

/** WGS84 → UTM (Krüger series, mm-level inside the zone). */
export function toUtm(lat: number, lon: number) {
  const zone = Math.floor((lon + 180) / 6) + 1;
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const phi = (lat * Math.PI) / 180, lam = (lon * Math.PI) / 180;
  const lam0 = (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2, A = Math.cos(phi) * (lam - lam0);
  const M = a * ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi
    - ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi)
    + ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi)
    - ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));
  const e = k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000;
  let nn = k0 * (M + N * Math.tan(phi) * (A * A / 2 + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24
    + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
  if (lat < 0) nn += 10000000;
  return { e, n: nn, zone, south: lat < 0 };
}

/** Width/height from the first SOF marker of a JPEG (APP segments, incl. the EXIF thumbnail, are skipped whole). */
export function jpegSize(b: Uint8Array): { w: number; h: number } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
      return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
    i += 2 + len;
  }
  return null;
}

export type Mark = { gcp: string; image: string; x: number; y: number };

/** ODM/WebODM gcp_list.txt in the UTM zone of the first GCP (same layout as the WebODM GCP Interface export). */
export function exportGcpList(gcps: Gcp[], marks: Mark[]): string {
  if (!gcps.length) return "";
  const { zone, south } = toUtm(gcps[0].lat, gcps[0].lon);
  const head = `+proj=utm +zone=${zone}${south ? " +south" : ""} +ellps=WGS84 +datum=WGS84 +units=m +no_defs`;
  const byName = new Map(gcps.map((g) => [g.name, g]));
  const rows = marks.flatMap((m) => {
    const g = byName.get(m.gcp);
    if (!g) return [];
    const u = toUtm(g.lat, g.lon);
    return [[u.e.toFixed(3), u.n.toFixed(3), g.z, m.x.toFixed(2), m.y.toFixed(2), m.image, m.gcp].join("\t")];
  });
  return [head, ...rows].join("\n") + "\n";
}
