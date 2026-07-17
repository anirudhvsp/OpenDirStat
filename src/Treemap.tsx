import { useEffect, useMemo, useRef, useState } from "react";
import type { FileNode, Rect } from "./types";
import { colorForNode, formatBytes, layoutTreemap } from "./utils";

type Props = {
  root: FileNode;
  selectedId: number | null;
  onSelect: (node: FileNode) => void;
};

export function Treemap({ root, selectedId, onSelect }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 400 });
  const [hovered, setHovered] = useState<Rect | null>(null);
  const rects = useMemo(() => layoutTreemap(root, size.width, size.height), [root, size]);

  useEffect(() => {
    if (!wrapRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) });
    });
    observer.observe(wrapRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = size.width * ratio;
    canvas.height = size.height * ratio;
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.fillStyle = "#090b10";
    ctx.fillRect(0, 0, size.width, size.height);
    rects.forEach((rect) => {
      if (rect.node.isDir) return;
      const gap = rect.width > 3 && rect.height > 3 ? 0.35 : 0.08;
      const color = colorForNode(rect.node);
      ctx.fillStyle = color;
      ctx.fillRect(rect.x + gap, rect.y + gap, Math.max(0, rect.width - gap * 2), Math.max(0, rect.height - gap * 2));
      const gradient = ctx.createRadialGradient(
        rect.x + rect.width * .5, rect.y + rect.height * .45, 0,
        rect.x + rect.width * .5, rect.y + rect.height * .5,
        Math.max(rect.width, rect.height) * .72,
      );
      gradient.addColorStop(0, "rgba(255,255,255,.62)");
      gradient.addColorStop(.24, "rgba(255,255,255,.24)");
      gradient.addColorStop(.62, "rgba(0,0,0,.08)");
      gradient.addColorStop(1, "rgba(0,0,0,.58)");
      ctx.fillStyle = gradient;
      ctx.fillRect(rect.x + gap, rect.y + gap, Math.max(0, rect.width - gap * 2), Math.max(0, rect.height - gap * 2));
      if (rect.node.id === selectedId) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2.5;
        ctx.strokeRect(rect.x + 1, rect.y + 1, Math.max(0, rect.width - 2), Math.max(0, rect.height - 2));
      }
    });
    const selectedDirectory = rects.find((rect) => rect.node.isDir && rect.node.id === selectedId);
    if (selectedDirectory) {
      const inset = selectedDirectory.depth === 0 ? 1.5 : 0.75;
      ctx.strokeStyle = "#ffb347";
      ctx.lineWidth = 2.5;
      ctx.strokeRect(
        selectedDirectory.x + inset,
        selectedDirectory.y + inset,
        Math.max(0, selectedDirectory.width - inset * 2),
        Math.max(0, selectedDirectory.height - inset * 2),
      );
    }
  }, [rects, selectedId, size]);

  const findRect = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    return [...rects].reverse().find((r) => !r.node.isDir && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) || null;
  };

  return (
    <div className="treemap-wrap" ref={wrapRef}>
      <canvas
        ref={ref}
        onMouseMove={(event) => setHovered(findRect(event))}
        onMouseLeave={() => setHovered(null)}
        onClick={(event) => { const hit = findRect(event); if (hit) onSelect(hit.node); }}
      />
      {hovered && (
        <div className="map-tooltip">
          <strong>{hovered.node.name}</strong>
          <span>{formatBytes(hovered.node.size)}</span>
          <small>{hovered.node.path}</small>
        </div>
      )}
    </div>
  );
}
