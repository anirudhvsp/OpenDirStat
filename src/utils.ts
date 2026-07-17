import type { FileNode, Rect } from "./types";

export const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 1 : 2)} ${units[exponent]}`;
};

export const formatCount = (value: number) => new Intl.NumberFormat().format(value);

const extensionColors = [
  "#46a3ff", "#ff5f56", "#ffc145", "#53d98c", "#a98bff", "#ff8f5c",
  "#46d8d3", "#ed71b8", "#89b854", "#6e83e6", "#d49d55", "#8a9aa9",
];

export const colorForNode = (node: FileNode) => {
  const key = node.extension || node.name;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return extensionColors[Math.abs(hash) % extensionColors.length];
};

export function layoutTreemap(node: FileNode, width: number, height: number): Rect[] {
  const output: Rect[] = [];
  type Box = { node: FileNode; x: number; y: number; width: number; height: number };

  const squarify = (children: FileNode[], x: number, y: number, width: number, height: number): Box[] => {
    const valid = children.filter((child) => child.size > 0).sort((a, b) => b.size - a.size);
    const total = valid.reduce((sum, child) => sum + child.size, 0);
    if (!valid.length || total <= 0) return [];
    type Item = { node: FileNode; area: number };
    const pending: Item[] = valid.map((child) => ({
      node: child,
      area: child.size / total * width * height,
    }));
    const boxes: Box[] = [];
    let bx = x, by = y, bw = width, bh = height;
    let row: Item[] = [];

    const worst = (items: Item[], side: number) => {
      if (!items.length || side <= 0) return Infinity;
      const sum = items.reduce((value, item) => value + item.area, 0);
      const largest = items[0].area;
      const smallest = items[items.length - 1].area;
      return Math.max(side * side * largest / (sum * sum), (sum * sum) / (side * side * smallest));
    };
    const place = (items: Item[]) => {
      const area = items.reduce((sum, item) => sum + item.area, 0);
      if (bw >= bh) {
        const stripWidth = area / bh;
        let offset = by;
        items.forEach((item, index) => {
          const itemHeight = index === items.length - 1 ? by + bh - offset : item.area / stripWidth;
          boxes.push({ node: item.node, x: bx, y: offset, width: stripWidth, height: itemHeight });
          offset += itemHeight;
        });
        bx += stripWidth;
        bw -= stripWidth;
      } else {
        const stripHeight = area / bw;
        let offset = bx;
        items.forEach((item, index) => {
          const itemWidth = index === items.length - 1 ? bx + bw - offset : item.area / stripHeight;
          boxes.push({ node: item.node, x: offset, y: by, width: itemWidth, height: stripHeight });
          offset += itemWidth;
        });
        by += stripHeight;
        bh -= stripHeight;
      }
    };
    for (const item of pending) {
      const side = Math.min(bw, bh);
      if (!row.length || worst([...row, item], side) <= worst(row, side)) row.push(item);
      else {
        place(row);
        row = [item];
      }
    }
    if (row.length) place(row);
    return boxes;
  };

  const layout = (
    item: FileNode, x: number, y: number, w: number, h: number,
    depth: number, ancestors: number[],
  ) => {
    if (w < 0.4 || h < 0.4 || item.size <= 0) return;
    if (!item.isDir) {
      output.push({ node: item, ancestors, depth, x, y, width: w, height: h });
      return;
    }
    output.push({ node: item, ancestors, depth, x, y, width: w, height: h });
    const pad = 0;
    const innerW = Math.max(0, w - pad * 2);
    const innerH = Math.max(0, h - pad * 2);
    squarify(item.children, x + pad, y + pad, innerW, innerH).forEach((box) =>
      layout(box.node, box.x, box.y, box.width, box.height, depth + 1, [...ancestors, item.id]));
  };
  layout(node, 0, 0, width, height, 0, []);
  return output;
}
