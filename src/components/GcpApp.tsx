"use client";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import {
  Alert, Button, Chip, IconButton, LinearProgress, List, ListItemButton, ListItemText, Paper, TextField, Tooltip, Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import DownloadIcon from "@mui/icons-material/Download";
import PhotoLibraryIcon from "@mui/icons-material/PhotoLibrary";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import { type Gcp, type Pt, exportGcpList, parseGcpText } from "@/lib/gcp";
import { type Candidate, type DroneImage, autoMark, propagate, readDroneImage, regionThumb } from "@/lib/browser";
import { MIN_SCORE, REVIEW_NCC } from "@/lib/config";
import MarkDialog from "./MarkDialog";

const GcpMap = dynamic(() => import("./GcpMap"), { ssr: false });

const SAMPLE = "EPSG:4326\n# name  lon  lat  z(ellipsoidal, same datum as drone RTK altitude)\n";

// 1e-5° ≈ 1.1 m — a value that is exact at 5 decimals was most likely rounded
const looksRounded = (g: Gcp) => [g.lon, g.lat].some((v) => Math.abs(v * 1e5 - Math.round(v * 1e5)) < 1e-6);

type Status = "ok" | "review" | "none" | "rejected";
const status = (c: Candidate): Status =>
  c.rejected ? "rejected" : !c.mark ? "none" : c.mark.source === "manual" || c.mark.score >= (c.mark.source === "match" ? REVIEW_NCC : MIN_SCORE) ? "ok" : "review";
const STATUS_CHIP: Record<Status, { label: string; color: "success" | "warning" | "default" | "error" }> = {
  ok: { label: "มาร์กแล้ว", color: "success" },
  review: { label: "ควรตรวจ", color: "warning" },
  none: { label: "หาไม่พบ", color: "default" },
  rejected: { label: "ไม่ใช้", color: "error" },
};

export default function GcpApp() {
  const [gcpText, setGcpText] = useState(SAMPLE);
  const [gcpFile, setGcpFile] = useState<string | null>(null);
  const [gcps, setGcps] = useState<Gcp[]>([]);
  const [gcpError, setGcpError] = useState<string | null>(null);
  const [images, setImages] = useState<DroneImage[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [reading, setReading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [cands, setCands] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Candidate | null>(null);
  const [matching, setMatching] = useState<string | null>(null); // GCP whose images are being template-matched

  const imageByName = useMemo(() => new Map(images.map((i) => [i.name, i])), [images]);
  const byGcp = useMemo(() => {
    const m = new Map<string, Candidate[]>();
    for (const c of cands) m.set(c.gcp, [...(m.get(c.gcp) ?? []), c]);
    return m;
  }, [cands]);
  const accepted = cands.filter((c) => c.mark && !c.rejected);

  const loadGcps = (text: string) => {
    try {
      const list = parseGcpText(text);
      if (!list.length) throw new Error("ไม่พบพิกัด GCP");
      setGcps(list); setGcpError(null); setCands([]); setSelected(null);
    } catch (e) {
      setGcpError((e as Error).message);
    }
  };

  const onGcpFile = async (f: File | undefined) => {
    if (!f) return;
    const t = await f.text();
    setGcpText(t); setGcpFile(f.name); loadGcps(t);
  };

  const onImages = async (files: FileList | null) => {
    if (!files) return;
    setReading(true);
    const jpgs = [...files].filter((f) => /\.jpe?g$/i.test(f.name));
    const read = await Promise.all(jpgs.map(readDroneImage));
    setImages(read.filter((r): r is DroneImage => !!r).sort((a, b) => a.name.localeCompare(b.name)));
    setSkipped(jpgs.filter((_, i) => !read[i]).map((f) => f.name));
    setCands([]); setReading(false);
  };

  const run = async () => {
    cands.forEach((c) => c.thumb && URL.revokeObjectURL(c.thumb));
    setProgress(0);
    const out = await autoMark(images, gcps, (d, t) => setProgress((d / t) * 100));
    setCands(out); setProgress(null);
  };

  const update = (key: string, patch: Partial<Candidate>) =>
    setCands((cs) => cs.map((c) => (c.key === key ? { ...c, ...patch } : c)));

  const saveMark = async (c: Candidate, p: Pt) => {
    setEditing(null);
    const img = imageByName.get(c.image)!;
    if (c.thumb) URL.revokeObjectURL(c.thumb);
    const seed: Candidate = { ...c, mark: { ...p, score: 1, source: "manual" }, rejected: false, thumb: await regionThumb(img.file, p) };
    update(c.key, seed);
    // a hand mark becomes the template for this GCP's other images that are still unmarked or doubtful
    const targets = cands.filter((o) => o.gcp === c.gcp && o.key !== c.key && !o.rejected && o.mark?.source !== "manual" && status(o) !== "ok");
    if (!targets.length) return;
    setMatching(c.gcp);
    try {
      const found = new Map((await propagate(seed, targets, imageByName, gcps.find((g) => g.name === c.gcp)!)).map((f) => [f.key, f]));
      setCands((cs) => cs.map((o) => found.get(o.key) ?? o));
    } finally {
      setMatching(null);
    }
  };

  const exportFile = () => {
    const blob = new Blob([exportGcpList(gcps, accepted.map((c) => ({ gcp: c.gcp, image: c.image, x: c.mark!.x, y: c.mark!.y })))], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "gcp_list.txt";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const sel = selected ? byGcp.get(selected) ?? [] : [];
  const highlight = new Set(sel.filter((c) => c.mark && !c.rejected).map((c) => c.image));

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-neutral-300 bg-white px-5 py-3">
        <Typography variant="h6" component="h1" className="!font-semibold">Ground Control Point Interface</Typography>
        <Chip size="small" label="Auto" color="primary" variant="outlined" />
        <div className="flex-1" />
        <Typography variant="body2" color="text.secondary">{accepted.length} จุดใน {new Set(accepted.map((c) => c.image)).size} ภาพ</Typography>
        <Button variant="contained" startIcon={<DownloadIcon />} disabled={!accepted.length} onClick={exportFile}>
          Export gcp_list.txt
        </Button>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(420px,1fr)_1fr]">
        <section className="min-h-0 overflow-y-auto p-4">
          {!selected ? (
            <div className="flex flex-col gap-4">
              <Paper variant="outlined" className="p-4">
                <Typography variant="subtitle1" className="!font-semibold">1. พิกัด GCP</Typography>
                <Typography variant="body2" color="text.secondary" className="!mb-3">
                  เลือกไฟล์ .txt หรือพิมพ์/วางพิกัดเอง (EPSG:4326 · ชื่อ lon lat z)
                </Typography>
                <Button component="label" variant="outlined" startIcon={<UploadFileIcon />} className="!mb-3">
                  {gcpFile ?? "เลือกไฟล์ GCP"}
                  <input hidden type="file" accept=".txt,.csv" onChange={(e) => onGcpFile(e.target.files?.[0])} />
                </Button>
                <TextField
                  multiline minRows={4} maxRows={10} fullWidth value={gcpText}
                  onChange={(e) => setGcpText(e.target.value)}
                  slotProps={{ input: { className: "font-mono text-sm" } }}
                  label="พิกัด"
                />
                <div className="mt-2 flex items-center gap-2">
                  <Button variant="contained" size="small" onClick={() => loadGcps(gcpText.replace(/^#.*$/gm, ""))}>โหลดพิกัด</Button>
                  {gcps.length > 0 && <Typography variant="body2">{gcps.length} จุด</Typography>}
                </div>
                {gcpError && <Alert severity="error" className="!mt-2">{gcpError}</Alert>}
              </Paper>

              <Paper variant="outlined" className="p-4">
                <Typography variant="subtitle1" className="!font-semibold">2. ภาพจากโดรน</Typography>
                <Typography variant="body2" color="text.secondary" className="!mb-3">
                  ภาพ JPG ที่มี EXIF/XMP ของ DJI · อ่านในเบราว์เซอร์ ไม่มีการอัปโหลดออกจากเครื่อง
                </Typography>
                <div className="flex flex-wrap gap-2">
                  <Button component="label" variant="outlined" startIcon={<PhotoLibraryIcon />}>
                    เลือกโฟลเดอร์
                    <input hidden type="file" multiple {...{ webkitdirectory: "" }} onChange={(e) => onImages(e.target.files)} />
                  </Button>
                  <Button component="label" variant="outlined">
                    เลือกไฟล์ภาพ
                    <input hidden type="file" multiple accept="image/jpeg" onChange={(e) => onImages(e.target.files)} />
                  </Button>
                </div>
                {reading && <LinearProgress className="!mt-3" />}
                {images.length > 0 && <Typography variant="body2" className="!mt-2">{images.length} ภาพพร้อมใช้</Typography>}
                {skipped.length > 0 && (
                  <Alert severity="warning" className="!mt-2">ข้าม {skipped.length} ไฟล์ที่ไม่มีข้อมูลตำแหน่งกล้อง: {skipped.slice(0, 3).join(", ")}{skipped.length > 3 && " …"}</Alert>
                )}
              </Paper>

              <Paper variant="outlined" className="p-4">
                <Typography variant="subtitle1" className="!font-semibold">3. มาร์กจุดอัตโนมัติ</Typography>
                <Typography variant="body2" color="text.secondary" className="!mb-3">
                  คำนวณตำแหน่ง GCP บนแต่ละภาพจาก RTK + มุมกล้อง แล้วหาเป้าแดง-ขาวรอบจุดนั้น · เป้าแบบอื่น: มาร์กเอง 1 ภาพต่อ GCP ระบบจะหาในภาพที่เหลือให้
                </Typography>
                <Button
                  variant="contained" startIcon={<AutoFixHighIcon />}
                  disabled={!gcps.length || !images.length || progress !== null}
                  onClick={run}
                >
                  เริ่มมาร์ก
                </Button>
                {progress !== null && <LinearProgress variant="determinate" value={progress} className="!mt-3" />}
              </Paper>

              {gcps.length > 0 && (
                <Paper variant="outlined">
                  <Typography variant="subtitle1" className="!font-semibold px-4 pt-3">Ground Control Points</Typography>
                  <List dense>
                    {gcps.map((g) => {
                      const cs = byGcp.get(g.name) ?? [];
                      const n = (s: Status) => cs.filter((c) => status(c) === s).length;
                      const used = n("ok") + n("review");
                      return (
                        <ListItemButton key={g.name} onClick={() => setSelected(g.name)} disabled={!cands.length}>
                          <ListItemText
                            primary={<span className="font-medium">{g.name}</span>}
                            secondary={<span className="font-mono text-xs">{g.lon.toFixed(7)}, {g.lat.toFixed(7)}, {g.z}</span>}
                          />
                          <div className="flex flex-wrap justify-end gap-1">
                            {looksRounded(g) && (
                              <Tooltip title="พิกัดดูเหมือนถูกปัดเหลือทศนิยม 5 ตำแหน่ง (~1 m) — ความแม่นของงานจะลดลง">
                                <Chip size="small" color="warning" variant="outlined" label="พิกัดถูกปัด?" />
                              </Tooltip>
                            )}
                            {cands.length > 0 && <>
                              <Chip size="small" color={used >= 3 ? "success" : "error"} label={`${used} ภาพ`} />
                              {n("review") > 0 && <Chip size="small" color="warning" label={`ตรวจ ${n("review")}`} />}
                            </>}
                          </div>
                        </ListItemButton>
                      );
                    })}
                  </List>
                </Paper>
              )}
            </div>
          ) : (
            <div>
              <div className="mb-3 flex items-center gap-2">
                <IconButton onClick={() => setSelected(null)} aria-label="กลับ"><ArrowBackIcon /></IconButton>
                <Typography variant="h6">{selected}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {sel.length} ภาพที่ GCP น่าจะอยู่ · คลิกภาพเพื่อปรับจุด · มาร์กเอง 1 ภาพแล้วระบบจะหาจุดเดียวกันในภาพที่เหลือให้
                </Typography>
              </div>
              {matching === selected && <LinearProgress className="!mb-3" aria-label="กำลังหาจุดในภาพอื่น" />}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
                {[...sel]
                  .sort((a, b) => (b.mark?.score ?? -1) - (a.mark?.score ?? -1))
                  .map((c) => {
                    const s = status(c);
                    return (
                      <button
                        key={c.key}
                        onClick={() => setEditing(c)}
                        className={`overflow-hidden rounded-md border bg-white text-left transition hover:shadow ${s === "rejected" ? "opacity-40" : ""}`}
                      >
                        <div className="relative aspect-square bg-neutral-800">
                          {/* blob: URLs, next/image cannot optimise them */}
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          {c.thumb && <img src={c.thumb} alt={c.image} className="h-full w-full object-cover" />}
                          {/* thumb is centred on mark (or prediction) */}
                          <svg viewBox="0 0 100 100" className="pointer-events-none absolute inset-0 h-full w-full">
                            <circle cx="50" cy="50" r="7" fill="none" stroke={c.mark ? "#ff9800" : "#90caf9"} strokeWidth="1.2" />
                            <path d="M50 38v24M38 50h24" stroke={c.mark ? "#ff9800" : "#90caf9"} strokeWidth="0.8" />
                          </svg>
                        </div>
                        <div className="flex items-center justify-between gap-1 p-1.5">
                          <span className="truncate font-mono text-[11px]">{c.image.replace(/^DJI_\d{8}/, "")}</span>
                          <Chip size="small" color={STATUS_CHIP[s].color} label={c.mark && s !== "rejected" && c.mark.source !== "manual" ? c.mark.score.toFixed(2) : STATUS_CHIP[s].label} />
                        </div>
                      </button>
                    );
                  })}
              </div>
            </div>
          )}
        </section>

        <section className="hidden min-h-0 border-l border-neutral-300 lg:block">
          <GcpMap
            gcps={gcps}
            cams={images.map((i) => ({ name: i.name, lat: i.cam.lat, lon: i.cam.lon }))}
            selected={selected}
            highlightImages={highlight}
            onSelect={(n) => cands.length && setSelected(n)}
          />
        </section>
      </main>

      <MarkDialog
        key={editing?.key ?? "none"}
        cand={editing}
        image={editing ? imageByName.get(editing.image) ?? null : null}
        onClose={() => setEditing(null)}
        onSave={(p) => editing && saveMark(editing, p)}
        onReject={() => { if (editing) update(editing.key, { rejected: true }); setEditing(null); }}
      />
    </div>
  );
}
