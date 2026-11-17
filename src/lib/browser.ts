// Browser-only image IO: everything stays on the user's machine, nothing is uploaded.
import { type Cam, type Gcp, type Pt, detectTarget, gsd, imageToImage, jpegSize, matchTemplate, parseXmp, project, toGray } from "./gcp";
import { MIN_NCC, QUAD_M, SEARCH_R, TEMPLATE_M } from "./config";

export type DroneImage = { name: string; file: File; cam: Cam };
export type Candidate = {
  key: string; gcp: string; image: string;
  pred: Pt; // projected from EXIF pose
  mark: (Pt & { score: number; source: "auto" | "match" | "manual" }) | null;
  rejected: boolean;
  thumb: string | null; // object URL of a crop around mark/pred
};

const THUMB = 120; // px of source image each side of the centre

export async function readDroneImage(file: File): Promise<DroneImage | null> {
  const head = new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer());
  const size = jpegSize(head);
  if (!size) return null;
  const cam = parseXmp(new TextDecoder("latin1").decode(head), size.w, size.h);
  return cam ? { name: file.name, file, cam } : null;
}

function crop(bmp: ImageBitmap, x0: number, y0: number, w: number, h: number) {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, x0, y0, w, h, 0, 0, w, h);
  return { canvas: c, data: ctx.getImageData(0, 0, w, h).data };
}

async function thumb(bmp: ImageBitmap, at: Pt) {
  const s = THUMB * 2, c = new OffscreenCanvas(s, s);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#222";
  ctx.fillRect(0, 0, s, s);
  ctx.drawImage(bmp, at.x - THUMB, at.y - THUMB, s, s, 0, 0, s, s);
  return URL.createObjectURL(await c.convertToBlob({ type: "image/jpeg", quality: 0.85 }));
}

/** Projects every GCP into every image, then searches for the target around each projection. */
export async function autoMark(
  images: DroneImage[], gcps: Gcp[], onProgress: (done: number, total: number) => void,
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i], { w, h } = img.cam;
    const hits = gcps
      .map((g) => ({ g, p: project(img.cam, g) }))
      .filter(({ p }) => p.x > -SEARCH_R / 2 && p.y > -SEARCH_R / 2 && p.x < w + SEARCH_R / 2 && p.y < h + SEARCH_R / 2);
    if (hits.length) {
      const bmp = await createImageBitmap(img.file);
      for (const { g, p } of hits) {
        const x0 = Math.max(0, Math.round(p.x - SEARCH_R)), y0 = Math.max(0, Math.round(p.y - SEARCH_R));
        const cw = Math.min(w, Math.round(p.x + SEARCH_R)) - x0, ch = Math.min(h, Math.round(p.y + SEARCH_R)) - y0;
        if (cw < 50 || ch < 50) continue;
        const d = detectTarget(crop(bmp, x0, y0, cw, ch).data, cw, ch, { x: p.x - x0, y: p.y - y0 }, QUAD_M / gsd(img.cam, g));
        const mark = d ? { x: d.x + x0, y: d.y + y0, score: d.score, source: "auto" as const } : null;
        // projections that land outside the frame without a detection are just "not in this photo"
        if (!mark && (p.x < 0 || p.y < 0 || p.x >= w || p.y >= h)) continue;
        out.push({ key: `${g.name}|${img.name}`, gcp: g.name, image: img.name, pred: p, mark, rejected: false, thumb: await thumb(bmp, mark ?? p) });
      }
      bmp.close();
    }
    onProgress(i + 1, images.length);
  }
  return out;
}

/** Loads a region of the full-res image for manual adjustment. */
export async function loadRegion(file: File, at: Pt, r: number, imgW: number, imgH: number) {
  const x0 = Math.max(0, Math.min(imgW - 2 * r, Math.round(at.x - r)));
  const y0 = Math.max(0, Math.min(imgH - 2 * r, Math.round(at.y - r)));
  const bmp = await createImageBitmap(file, x0, y0, 2 * r, 2 * r);
  return { bmp, x0, y0 };
}

export async function regionThumb(file: File, at: Pt) {
  const bmp = await createImageBitmap(file, Math.round(at.x - THUMB), Math.round(at.y - THUMB), THUMB * 2, THUMB * 2);
  const c = new OffscreenCanvas(THUMB * 2, THUMB * 2);
  c.getContext("2d")!.drawImage(bmp, 0, 0);
  bmp.close();
  return URL.createObjectURL(await c.convertToBlob({ type: "image/jpeg", quality: 0.85 }));
}

async function grayRegion(file: File, x0: number, y0: number, w: number, h: number) {
  const bmp = await createImageBitmap(file, x0, y0, w, h);
  const c = new OffscreenCanvas(w, h), ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return toGray(ctx.getImageData(0, 0, w, h).data, w, h);
}

/**
 * Uses one marked image of a GCP as a template to find the same spot in its other images (works for any target design).
 * shortcut: runs on the main thread (~0.3 s per image); move to a Web Worker if surveys have many images per GCP.
 */
export async function propagate(seed: Candidate, targets: Candidate[], images: Map<string, DroneImage>, g: Gcp): Promise<Candidate[]> {
  const s = images.get(seed.image)!, sm = seed.mark!;
  // radius covers the template rotated by any yaw (√2) plus a scale change between flights
  const sr = Math.ceil((TEMPLATE_M / gsd(s.cam, g)) * 2);
  const sx0 = Math.round(sm.x - sr), sy0 = Math.round(sm.y - sr);
  const seedGray = await grayRegion(s.file, sx0, sy0, 2 * sr, 2 * sr);
  const seedPt = { x: sm.x - sx0, y: sm.y - sy0 };
  const sp = project(s.cam, g), off = { x: sm.x - sp.x, y: sm.y - sp.y };
  const out: Candidate[] = [];
  for (const c of targets) {
    const t = images.get(c.image)!, { w, h } = t.cam;
    // carry the seed's offset from its prediction over (absorbs GCP coordinate error)
    const B = imageToImage(t.cam, s.cam, g);
    const hint = { x: c.pred.x + B[0] * off.x + B[1] * off.y, y: c.pred.y + B[2] * off.x + B[3] * off.y };
    const x0 = Math.max(0, Math.round(hint.x - SEARCH_R)), y0 = Math.max(0, Math.round(hint.y - SEARCH_R));
    const cw = Math.min(w, Math.round(hint.x + SEARCH_R)) - x0, ch = Math.min(h, Math.round(hint.y + SEARCH_R)) - y0;
    if (cw < 50 || ch < 50) continue;
    const d = matchTemplate(seedGray, seedPt, imageToImage(s.cam, t.cam, g), await grayRegion(t.file, x0, y0, cw, ch),
      { x: hint.x - x0, y: hint.y - y0 }, TEMPLATE_M / gsd(t.cam, g));
    if (!d || d.score < MIN_NCC) continue;
    const mark = { x: d.x + x0, y: d.y + y0, score: d.score, source: "match" as const };
    if (c.thumb) URL.revokeObjectURL(c.thumb);
    out.push({ ...c, mark, thumb: await regionThumb(t.file, mark) });
  }
  return out;
}
