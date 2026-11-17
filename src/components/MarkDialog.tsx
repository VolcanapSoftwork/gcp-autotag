"use client";
import { useEffect, useRef, useState } from "react";
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Slider, Typography } from "@mui/material";
import type { Pt } from "@/lib/gcp";
import { type Candidate, type DroneImage, loadRegion } from "@/lib/browser";

const R = 400; // half-size of the loaded region, source px

type Props = {
  cand: Candidate | null;
  image: DroneImage | null;
  onClose: () => void;
  onSave: (p: Pt) => void;
  onReject: () => void;
};

/** Full-resolution region around the mark; click to place the point, scroll/slider to zoom. */
export default function MarkDialog({ cand, image, onClose, onSave, onReject }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [region, setRegion] = useState<{ bmp: ImageBitmap; x0: number; y0: number } | null>(null);
  // the parent remounts this dialog per candidate (key), so initial state is per-candidate
  const [pt, setPt] = useState<Pt | null>(cand?.mark ? { x: cand.mark.x, y: cand.mark.y } : null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    if (!cand || !image) return;
    let alive = true;
    const at = cand.mark ?? cand.pred;
    loadRegion(image.file, at, R, image.cam.w, image.cam.h).then((r) => (alive ? setRegion(r) : r.bmp.close()));
    return () => {
      alive = false;
      setRegion((old) => (old?.bmp.close(), null));
    };
  }, [cand, image]);

  // draw: the region is scaled so the view stays centred on the current point
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !region || !cand) return;
    const ctx = c.getContext("2d")!;
    const view = (2 * R) / zoom, centre = pt ?? cand.pred;
    const sx = Math.max(0, Math.min(2 * R - view, centre.x - region.x0 - view / 2));
    const sy = Math.max(0, Math.min(2 * R - view, centre.y - region.y0 - view / 2));
    ctx.imageSmoothingEnabled = zoom < 2;
    ctx.drawImage(region.bmp, sx, sy, view, view, 0, 0, c.width, c.height);
    const k = c.width / view;
    const draw = (p: Pt, color: string, size: number) => {
      const x = (p.x - region.x0 - sx) * k, y = (p.y - region.y0 - sy) * k;
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.moveTo(x - size * 1.6, y); ctx.lineTo(x + size * 1.6, y);
      ctx.moveTo(x, y - size * 1.6); ctx.lineTo(x, y + size * 1.6); ctx.stroke();
    };
    draw(cand.pred, "rgba(144,202,249,0.9)", 10);
    if (pt) draw(pt, "#ff9800", 14);
    c.dataset.sx = String(sx); c.dataset.sy = String(sy); c.dataset.k = String(k);
  }, [region, pt, zoom, cand]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const c = e.currentTarget, b = c.getBoundingClientRect();
    if (!region) return;
    const k = +c.dataset.k! * (b.width / c.width);
    setPt({ x: region.x0 + +c.dataset.sx! + (e.clientX - b.left) / k, y: region.y0 + +c.dataset.sy! + (e.clientY - b.top) / k });
  };

  return (
    <Dialog open={!!cand} onClose={onClose} maxWidth="md">
      <DialogTitle className="!pb-1">
        {cand?.gcp} · <span className="font-mono text-sm">{cand?.image}</span>
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" className="!mb-2">
          คลิกตรงจุดตัดกลางเป้า · วงฟ้า = ตำแหน่งที่คำนวณจาก EXIF · วงส้ม = จุดที่มาร์ก
          {pt && <span className="ml-2 font-mono">({pt.x.toFixed(1)}, {pt.y.toFixed(1)})</span>}
        </Typography>
        <canvas
          ref={canvasRef}
          width={640}
          height={640}
          onClick={onClick}
          onWheel={(e) => setZoom((z) => Math.min(8, Math.max(1, z * (e.deltaY < 0 ? 1.25 : 0.8))))}
          className="block aspect-square w-full max-w-[640px] cursor-crosshair bg-neutral-900"
          aria-label="ภาพสำหรับมาร์กจุด"
        />
        <div className="mt-2 flex items-center gap-3">
          <Typography variant="caption">Zoom</Typography>
          <Slider size="small" min={1} max={8} step={0.25} value={zoom} onChange={(_, v) => setZoom(v as number)} aria-label="Zoom" />
        </div>
      </DialogContent>
      <DialogActions>
        <Button color="secondary" onClick={onReject}>ไม่ใช้ภาพนี้</Button>
        <div className="flex-1" />
        <Button onClick={onClose}>ยกเลิก</Button>
        <Button variant="contained" disabled={!pt} onClick={() => pt && onSave(pt)}>บันทึกจุด</Button>
      </DialogActions>
    </Dialog>
  );
}
