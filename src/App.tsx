import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ChevronDown, ChevronRight, Folder, FolderOpen, HardDrive, LoaderCircle,
  Octagon, RefreshCw, Search, Settings2, X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Treemap } from "./Treemap";
import type { FileNode, ScanEvent, ScanResult } from "./types";
import { formatBytes, formatCount } from "./utils";
import "./styles.css";

type Progress = { files: number; dirs: number; bytes: number; currentPath: string };

const demoTree: FileNode = {
  id: 1, name: "Demo volume", path: "/demo", size: 39278428160, isDir: true, extension: null,
  children: [
    { id: 2, name: "Projects", path: "/demo/Projects", size: 17400000000, isDir: true, extension: null, children: [
      { id: 3, name: "build-cache.bin", path: "/demo/Projects/build-cache.bin", size: 9200000000, isDir: false, extension: "bin", children: [] },
      { id: 4, name: "assets.pack", path: "/demo/Projects/assets.pack", size: 5100000000, isDir: false, extension: "pack", children: [] },
      { id: 5, name: "source.map", path: "/demo/Projects/source.map", size: 3100000000, isDir: false, extension: "map", children: [] },
    ]},
    { id: 6, name: "Media", path: "/demo/Media", size: 13900000000, isDir: true, extension: null, children: [
      { id: 7, name: "documentary.mp4", path: "/demo/Media/documentary.mp4", size: 6800000000, isDir: false, extension: "mp4", children: [] },
      { id: 8, name: "recording.mov", path: "/demo/Media/recording.mov", size: 4900000000, isDir: false, extension: "mov", children: [] },
      { id: 9, name: "library.zip", path: "/demo/Media/library.zip", size: 2200000000, isDir: false, extension: "zip", children: [] },
    ]},
    { id: 10, name: "System", path: "/demo/System", size: 7978428160, isDir: true, extension: null, children: [
      { id: 11, name: "memory.sys", path: "/demo/System/memory.sys", size: 4294967296, isDir: false, extension: "sys", children: [] },
      { id: 12, name: "index.db", path: "/demo/System/index.db", size: 2383459328, isDir: false, extension: "db", children: [] },
      { id: 13, name: "logs.dat", path: "/demo/System/logs.dat", size: 1300001536, isDir: false, extension: "dat", children: [] },
    ]},
  ],
};

function TreeRow({ node, level, selectedId, revealIds, onSelect }: {
  node: FileNode; level: number; selectedId: number | null; revealIds: Set<number>;
  onSelect: (node: FileNode) => void;
}) {
  const [open, setOpen] = useState(level < 2);
  const [children, setChildren] = useState(node.children);
  const [loading, setLoading] = useState(false);
  const rowRef = useRef<HTMLButtonElement>(null);
  const hasChildren = node.isDir && (node.childCount ?? node.children.length) > 0;
  const loadChildren = async () => {
    if (!hasChildren || children.length > 0 || loading || !isTauri()) return;
    setLoading(true);
    try {
      setChildren(await invoke<FileNode[]>("get_children", { nodeId: node.id }));
    } finally {
      setLoading(false);
    }
  };
  const toggle = async (event: React.MouseEvent) => {
    event.stopPropagation();
    const next = !open;
    setOpen(next);
    if (next) await loadChildren();
  };
  useEffect(() => {
    if (revealIds.has(node.id)) {
      setOpen(true);
      void loadChildren();
    }
  }, [revealIds, node.id]);
  useEffect(() => {
    if (selectedId === node.id) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedId, node.id]);
  return (
    <>
      <button ref={rowRef} className={`tree-row ${node.id === selectedId ? "selected" : ""}`} onClick={() => onSelect(node)}>
        <span className="name-cell" style={{ paddingLeft: 12 + level * 20 }}>
          {hasChildren ? (
            <span className="chevron" onClick={toggle}>
              {loading ? <LoaderCircle className="row-spinner" size={13} /> : open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
          ) : <span className="chevron" />}
          {node.isDir ? (open ? <FolderOpen size={16} /> : <Folder size={16} />) : <span className="file-dot" />}
          <span title={node.path}>{node.name}</span>
        </span>
        <span>{formatBytes(node.size)}</span>
        <span>{node.isDir ? formatCount(node.childCount ?? children.length) : node.extension || "—"}</span>
      </button>
      {node.isDir && open && children.map((child) => (
        <TreeRow key={child.id} node={child} level={level + 1} selectedId={selectedId} revealIds={revealIds} onSelect={onSelect} />
      ))}
    </>
  );
}

export default function App() {
  const [root, setRoot] = useState<FileNode | null>(null);
  const [mapRoot, setMapRoot] = useState<FileNode | null>(null);
  const [selected, setSelected] = useState<FileNode | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [scanning, setScanning] = useState(false);
  const [query, setQuery] = useState("");
  const [revealIds, setRevealIds] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const shownRoot = root || demoTree;
  const visibleChildren = useMemo(() => {
    if (!query.trim()) return shownRoot.children;
    const term = query.toLowerCase();
    return shownRoot.children.filter((node) => node.name.toLowerCase().includes(term));
  }, [shownRoot, query]);

  const chooseDirectory = async () => {
    setError(null);
    if (!isTauri()) {
      setRoot(demoTree); setSelected(demoTree);
      setError("Directory scanning runs in the Tauri desktop window. Showing demo data in browser preview.");
      return;
    }
    const selectedPath = await open({ directory: true, multiple: false, title: "Choose a directory to analyze" });
    if (typeof selectedPath === "string") await scan(selectedPath);
  };

  const scan = async (path: string) => {
    setScanning(true); setRoot(null); setMapRoot(null); setSelected(null);
    setProgress({ files: 0, dirs: 0, bytes: 0, currentPath: path });
    const channel = new Channel<ScanEvent>();
    channel.onmessage = (message) => {
      if (message.event === "progress") setProgress(message.data);
    };
    try {
      const result = await invoke<ScanResult>("scan_directory", { path, onEvent: channel });
      setRoot(result.root); setMapRoot(result.treemap); setSelected(result.root);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setScanning(false); setProgress(null);
    }
  };

  const cancel = async () => {
    if (isTauri()) await invoke("cancel_scan");
  };

  const selectFromMap = async (node: FileNode) => {
    setSelected(node);
    if (!isTauri()) return;
    try {
      const ancestors = await invoke<number[]>("get_ancestors", { nodeId: node.id });
      setRevealIds(new Set(ancestors));
    } catch {
      setRevealIds(new Set());
    }
  };

  return (
    <main>
      <header>
        <div className="brand"><span className="brand-mark"><HardDrive size={18} /></span><strong>OpenDirStat</strong></div>
        <button className="primary" onClick={chooseDirectory}><FolderOpen size={16} /> Select folder</button>
        <button className="icon-button" aria-label="Rescan" disabled={!root || scanning} onClick={() => root && scan(root.path)}><RefreshCw size={17} /></button>
        <div className="header-spacer" />
        <button className="icon-button" aria-label="Settings"><Settings2 size={17} /></button>
      </header>

      {error && <div className="notice"><span>{error}</span><button onClick={() => setError(null)}><X size={15} /></button></div>}

      {scanning && progress ? (
        <section className="scan-state">
          <div className="scan-icon"><LoaderCircle size={32} /></div>
          <div className="scan-copy">
            <strong>Scanning storage…</strong>
            <span title={progress.currentPath}>{progress.currentPath}</span>
          </div>
          <div className="scan-stats">
            <span><b>{formatCount(progress.files)}</b> files</span>
            <span><b>{formatCount(progress.dirs)}</b> folders</span>
            <span><b>{formatBytes(progress.bytes)}</b> found</span>
          </div>
          <button className="cancel" onClick={cancel}><Octagon size={15} /> Stop</button>
        </section>
      ) : (
        <section className="summary">
          <div><span>Analyzing</span><strong>{root ? root.path : "Interactive preview"}</strong></div>
          <div><span>Total size</span><strong>{formatBytes(shownRoot.size)}</strong></div>
          <div><span>Top-level items</span><strong>{formatCount(shownRoot.children.length)}</strong></div>
          {!root && <button className="quiet-button" onClick={chooseDirectory}>Choose a real folder</button>}
        </section>
      )}

      <section className="workspace">
        <div className="table-panel">
          <div className="panel-toolbar">
            <div className="search"><Search size={15} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter top-level items" /></div>
          </div>
          <div className="table-head"><span>Name</span><span>Size</span><span>Items / type</span></div>
          <div className="tree-scroll">
            {visibleChildren.map((node) => <TreeRow key={node.id} node={node} level={0} selectedId={selected?.id || null} revealIds={revealIds} onSelect={(item) => { setSelected(item); setRevealIds(new Set()); }} />)}
          </div>
        </div>
        <div className="detail-panel">
          <div className="detail-label">Selection</div>
          <strong>{selected?.name || shownRoot.name}</strong>
          <span>{formatBytes(selected?.size || shownRoot.size)}</span>
          <small>{selected?.path || shownRoot.path}</small>
        </div>
      </section>

      <section className="map-panel">
        <div className="map-header">
          <div><strong>Storage map</strong><span>Each tile is one file, sized proportionally</span></div>
          <div className="legend"><i className="blue" /> Documents <i className="yellow" /> Archives <i className="green" /> Media <i className="purple" /> Other</div>
        </div>
        <Treemap root={mapRoot || shownRoot} selectedId={selected?.id || null} onSelect={selectFromMap} />
      </section>
    </main>
  );
}
