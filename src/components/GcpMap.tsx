"use client";
import "leaflet/dist/leaflet.css";
import { useEffect } from "react";
import { CircleMarker, MapContainer, TileLayer, Tooltip, useMap } from "react-leaflet";
import type { Gcp } from "@/lib/gcp";

type Props = {
  gcps: Gcp[];
  cams: { name: string; lat: number; lon: number }[];
  selected: string | null;
  highlightImages: Set<string>;
  onSelect: (name: string) => void;
};

function FitBounds({ pts }: { pts: [number, number][] }) {
  const map = useMap();
  const key = pts.map((p) => p.join()).join(";");
  useEffect(() => {
    if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 19 });
    // refit only when the point set changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map]);
  return null;
}

export default function GcpMap({ gcps, cams, selected, highlightImages, onSelect }: Props) {
  const pts: [number, number][] = gcps.length
    ? gcps.map((g) => [g.lat, g.lon])
    : cams.map((c) => [c.lat, c.lon]);
  return (
    <MapContainer center={[13.7, 100.5]} zoom={6} maxZoom={21} className="h-full w-full">
      <TileLayer
        url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
        attribution="Esri World Imagery"
        maxNativeZoom={19}
        maxZoom={21}
      />
      <FitBounds pts={pts} />
      {cams.map((c) => (
        <CircleMarker
          key={c.name}
          center={[c.lat, c.lon]}
          radius={highlightImages.has(c.name) ? 5 : 3}
          pathOptions={{ color: highlightImages.has(c.name) ? "#ffd54f" : "#90caf9", weight: 1, fillOpacity: 0.8 }}
        >
          <Tooltip>{c.name}</Tooltip>
        </CircleMarker>
      ))}
      {gcps.map((g) => (
        <CircleMarker
          key={g.name}
          center={[g.lat, g.lon]}
          radius={selected === g.name ? 11 : 8}
          pathOptions={{ color: "#fff", weight: 2, fillColor: selected === g.name ? "#ff9800" : "#c62828", fillOpacity: 0.9 }}
          eventHandlers={{ click: () => onSelect(g.name) }}
        >
          <Tooltip permanent direction="top" offset={[0, -8]}>{g.name}</Tooltip>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
