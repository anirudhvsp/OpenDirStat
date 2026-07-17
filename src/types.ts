export type FileNode = {
  id: number;
  name: string;
  path: string;
  size: number;
  isDir: boolean;
  extension: string | null;
  childCount?: number;
  children: FileNode[];
};

export type ScanResult = {
  root: FileNode;
  treemap: FileNode;
};

export type ScanEvent =
  | { event: "progress"; data: { files: number; dirs: number; bytes: number; currentPath: string } }
  | { event: "cancelled"; data: null };

export type Rect = {
  node: FileNode;
  ancestors: number[];
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
};
