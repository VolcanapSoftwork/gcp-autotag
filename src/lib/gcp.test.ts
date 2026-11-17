import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import jpeg from "jpeg-js";
import { detectTarget, exportGcpList, gsd, imageToImage, jpegSize, matchTemplate, parseGcpText, parseXmp, project, toGray, toUtm } from "./gcp";
import { QUAD_M, SEARCH_R, TEMPLATE_M } from "./config";

// Real survey (DJI M4E, Bua site) with hand-marked ground truth from the WebODM GCP Interface.
const DATA = process.env.GCP_DATA ?? "/Users/stormnoopper/Desktop/drive-download-20261115T160125Z-1-001";
const IMG = `${DATA}/Rawdata/DJI_202609300833_038_bua`;
const hasData = existsSync(`${DATA}/GCP/gcp_Bua_final.txt`);

describe("toUtm", () => {
  it("matches the WebODM export for gcp01", () => {
    const u = toUtm(13.2320598435, 100.955465996);
    expect(u.zone).toBe(47);
    expect(u.e).toBeCloseTo(711891.72, 1);
    expect(u.n).toBeCloseTo(1463626.47, 1);
  });
});

describe("parseGcpText", () => {
  it("rejects bad rows", () => {
    expect(() => parseGcpText("EPSG:4326\ngcp01 abc 13 1")).toThrow();
    expect(parseGcpText("EPSG:4326\ngcp01 100.9 13.2 -7.9\n")).toEqual([{ name: "gcp01", lon: 100.9, lat: 13.2, z: -7.9 }]);
  });
});

describe("export", () => {
  it("writes ODM layout", () => {
    const out = exportGcpList([{ name: "g", lon: 100.955465996, lat: 13.2320598435, z: -7.9 }], [{ gcp: "g", image: "a.JPG", x: 1, y: 2 }]);
    expect(out.split("\n")[0]).toContain("+zone=47");
    const row = out.split("\n")[1].split("\t");
    expect(row.slice(2)).toEqual(["-7.9", "1.00", "2.00", "a.JPG", "g"]);
    expect(+row[0]).toBeCloseTo(711891.72, 1);
  });
});

describe.skipIf(!hasData)("auto-mark vs hand marks", () => {
  const gcps = parseGcpText(readFileSync(`${DATA}/GCP/EPSG4326_Bua.txt`, "utf8"));
  const truth = readFileSync(`${DATA}/GCP/gcp_Bua_final.txt`, "utf8").trim().split("\n").slice(1).map((l) => {
    const p = l.split(/\s+/);
    return { x: +p[3], y: +p[4], image: p[5], gcp: p[6] };
  });

  it("reads JPEG size from the header", () => {
    const head = new Uint8Array(readFileSync(`${IMG}/${truth[0].image}`).subarray(0, 512_000));
    expect(jpegSize(head)).toEqual({ w: 5280, h: 3956 });
  });

  it.each(truth)("$gcp in $image", ({ x, y, image, gcp }) => {
    const buf = readFileSync(`${IMG}/${image}`);
    const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 2048 });
    const cam = parseXmp(buf.subarray(0, 300_000).toString("latin1"), img.width, img.height)!;
    const g = gcps.find((v) => v.name === gcp)!;
    const p = project(cam, g);
    const x0 = Math.max(0, Math.round(p.x - SEARCH_R)), y0 = Math.max(0, Math.round(p.y - SEARCH_R));
    const x1 = Math.min(img.width, Math.round(p.x + SEARCH_R)), y1 = Math.min(img.height, Math.round(p.y + SEARCH_R));
    const cw = x1 - x0, ch = y1 - y0;
    const crop = new Uint8ClampedArray(cw * ch * 4);
    for (let r = 0; r < ch; r++)
      crop.set(img.data.subarray(((y0 + r) * img.width + x0) * 4, ((y0 + r) * img.width + x1) * 4), r * cw * 4);
    const d = detectTarget(crop, cw, ch, { x: p.x - x0, y: p.y - y0 }, QUAD_M / gsd(cam, g));
    expect(d).not.toBeNull();
    const err = Math.hypot(d!.x + x0 - x, d!.y + y0 - y);
    console.log(`${gcp} ${image} err=${err.toFixed(1)}px score=${d!.score.toFixed(2)}`);
    expect(err).toBeLessThan(6);
  }, 30_000);
});

// Target-agnostic path: one hand mark per GCP is the seed, every other hand mark is found by template matching (no colour rules).
describe.skipIf(!hasData)("template propagation vs hand marks", () => {
  const gcps = parseGcpText(readFileSync(`${DATA}/GCP/EPSG4326_Bua.txt`, "utf8"));
  const truth = readFileSync(`${DATA}/GCP/gcp_Bua_final.txt`, "utf8").trim().split("\n").slice(1).map((l) => {
    const p = l.split(/\s+/);
    return { x: +p[3], y: +p[4], image: p[5], gcp: p[6] };
  });
  const load = (image: string) => {
    const buf = readFileSync(`${IMG}/${image}`);
    const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 2048 });
    return { gray: toGray(img.data, img.width, img.height), cam: parseXmp(buf.subarray(0, 300_000).toString("latin1"), img.width, img.height)! };
  };
  const pairs = truth.flatMap((t) => {
    const seed = truth.find((s) => s.gcp === t.gcp)!;
    return seed === t ? [] : [{ ...t, seed }];
  });

  it.each(pairs)("$gcp in $image from $seed.image", ({ x, y, image, gcp, seed }) => {
    const g = gcps.find((v) => v.name === gcp)!;
    const s = load(seed.image), t = load(image);
    const T = imageToImage(s.cam, t.cam, g), B = imageToImage(t.cam, s.cam, g);
    const sp = project(s.cam, g), off = { x: seed.x - sp.x, y: seed.y - sp.y };
    const p = project(t.cam, g), hint = { x: p.x + B[0] * off.x + B[1] * off.y, y: p.y + B[2] * off.x + B[3] * off.y };
    const x0 = Math.max(0, Math.round(p.x - SEARCH_R)), y0 = Math.max(0, Math.round(p.y - SEARCH_R));
    const cw = Math.min(t.gray.w, Math.round(p.x + SEARCH_R)) - x0, ch = Math.min(t.gray.h, Math.round(p.y + SEARCH_R)) - y0;
    const crop = new Float32Array(cw * ch);
    for (let r = 0; r < ch; r++) crop.set(t.gray.data.subarray((y0 + r) * t.gray.w + x0, (y0 + r) * t.gray.w + x0 + cw), r * cw);
    const d = matchTemplate(s.gray, seed, T, { data: crop, w: cw, h: ch }, { x: hint.x - x0, y: hint.y - y0 }, TEMPLATE_M / gsd(t.cam, g));
    const err = Math.hypot(d!.x + x0 - x, d!.y + y0 - y);
    console.log(`match ${gcp} ${image} err=${err.toFixed(1)}px ncc=${d!.score.toFixed(2)}`);
    expect(err).toBeLessThan(4);
  }, 60_000);
});
