use jwalk::{Parallelism, WalkDir};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, State};

struct ScanState {
    cancelled: Arc<AtomicBool>,
    active: AtomicBool,
    snapshot: Mutex<Option<ScanSnapshot>>,
}

impl Default for ScanState {
    fn default() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            active: AtomicBool::new(false),
            snapshot: Mutex::new(None),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileNode {
    id: u64,
    name: String,
    path: String,
    size: u64,
    is_dir: bool,
    extension: Option<String>,
    child_count: usize,
    children: Vec<FileNode>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    root: FileNode,
    treemap: FileNode,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    files: u64,
    dirs: u64,
    bytes: u64,
    current_path: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
enum ScanEvent {
    Progress(Progress),
    Cancelled,
}

#[derive(Debug)]
struct ArenaNode {
    id: u64,
    name: String,
    path: PathBuf,
    own_size: u64,
    is_dir: bool,
    extension: Option<String>,
    parent: Option<usize>,
    children: Vec<usize>,
}

struct ScanSnapshot {
    arena: Vec<ArenaNode>,
    sizes: Vec<u64>,
}

struct ScanOutput {
    result: ScanResult,
    snapshot: ScanSnapshot,
}

const MAX_RESULT_NODES: usize = 20_000;

fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn materialize_shallow(index: usize, arena: &[ArenaNode], sizes: &[u64]) -> FileNode {
    let item = &arena[index];
    FileNode {
        id: item.id,
        name: item.name.clone(),
        path: item.path.to_string_lossy().into_owned(),
        size: sizes[index],
        is_dir: item.is_dir,
        extension: item.extension.clone(),
        child_count: item.children.len(),
        children: Vec::new(),
    }
}

fn calculate_sizes(index: usize, arena: &[ArenaNode], sizes: &mut [u64]) -> u64 {
    let item = &arena[index];
    let size = if item.is_dir {
        item.children
            .iter()
            .map(|child| calculate_sizes(*child, arena, sizes))
            .fold(0_u64, u64::saturating_add)
    } else {
        item.own_size
    };
    sizes[index] = size;
    size
}

fn materialize_proportional(
    index: usize,
    arena: &[ArenaNode],
    sizes: &[u64],
    budget: usize,
    grouped_id: &mut u64,
) -> FileNode {
    let item = &arena[index];
    if !item.is_dir || item.children.is_empty() {
        return materialize_shallow(index, arena, sizes);
    }
    if budget <= 1 {
        *grouped_id += 1;
        return FileNode {
            id: *grouped_id,
            name: format!("[{}]", item.name),
            path: item.path.to_string_lossy().into_owned(),
            size: sizes[index],
            is_dir: false,
            extension: Some("grouped".into()),
            child_count: item.children.len(),
            children: Vec::new(),
        };
    }

    let mut child_indexes = item.children.clone();
    child_indexes.sort_unstable_by(|a, b| sizes[*b].cmp(&sizes[*a]));
    let available = budget - 1;
    let visible_count = child_indexes.len().min(available);
    let (visible, hidden) = child_indexes.split_at(visible_count);
    let hidden_slot = usize::from(!hidden.is_empty());
    let extra = available
        .saturating_sub(visible_count)
        .saturating_sub(hidden_slot);
    let total = visible
        .iter()
        .map(|child| sizes[*child])
        .fold(0_u64, u64::saturating_add)
        .max(1);
    let mut allocations: Vec<usize> = visible
        .iter()
        .map(|child| 1 + (extra as u128 * sizes[*child] as u128 / total as u128) as usize)
        .collect();
    let mut leftover = available
        .saturating_sub(hidden_slot)
        .saturating_sub(allocations.iter().sum::<usize>());
    let mut cursor = 0;
    while leftover > 0 && !allocations.is_empty() {
        let slot = cursor % allocations.len();
        allocations[slot] += 1;
        cursor += 1;
        leftover -= 1;
    }
    let mut children: Vec<FileNode> = visible
        .iter()
        .zip(allocations)
        .map(|(child, child_budget)| {
            materialize_proportional(*child, arena, sizes, child_budget, grouped_id)
        })
        .collect();
    if !hidden.is_empty() {
        *grouped_id += 1;
        children.push(FileNode {
            id: *grouped_id,
            name: format!("[{} smaller items]", hidden.len()),
            path: item.path.to_string_lossy().into_owned(),
            size: hidden
                .iter()
                .map(|child| sizes[*child])
                .fold(0_u64, u64::saturating_add),
            is_dir: false,
            extension: Some("grouped".into()),
            child_count: hidden.len(),
            children: Vec::new(),
        });
    }
    children.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.name.cmp(&b.name)));
    FileNode {
        id: item.id,
        name: item.name.clone(),
        path: item.path.to_string_lossy().into_owned(),
        size: sizes[index],
        is_dir: item.is_dir,
        extension: item.extension.clone(),
        child_count: item.children.len(),
        children,
    }
}

fn scan(
    path: PathBuf,
    cancelled: Arc<AtomicBool>,
    channel: Channel<ScanEvent>,
) -> Result<ScanOutput, String> {
    if !path.exists() {
        return Err(format!(
            "The selected path does not exist: {}",
            path.display()
        ));
    }
    if !path.is_dir() {
        return Err("Please select a directory, not a file.".into());
    }

    let mut arena = vec![ArenaNode {
        id: 1,
        name: display_name(&path),
        path: path.clone(),
        own_size: 0,
        is_dir: true,
        extension: None,
        parent: None,
        children: Vec::new(),
    }];
    let mut directory_indexes: HashMap<PathBuf, usize> = HashMap::from([(path.clone(), 0)]);
    let mut files = 0_u64;
    let mut dirs = 1_u64;
    let mut bytes = 0_u64;
    let mut next_id = 2_u64;
    let mut last_progress = Instant::now();
    let threads = num_cpus::get().clamp(2, 12);

    let walker = WalkDir::new(&path)
        .skip_hidden(false)
        .follow_links(false)
        .parallelism(Parallelism::RayonNewPool(threads));

    for result in walker {
        if cancelled.load(Ordering::Relaxed) {
            let _ = channel.send(ScanEvent::Cancelled);
            return Err("Scan cancelled".into());
        }
        let entry = match result {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if entry.depth() == 0 {
            continue;
        }
        let entry_path = entry.path();
        let parent = match entry_path
            .parent()
            .and_then(|parent| directory_indexes.get(parent).copied())
        {
            Some(index) => index,
            None => continue,
        };
        let is_dir = entry.file_type().is_dir();
        let own_size = if is_dir {
            0
        } else {
            entry.metadata().map(|metadata| metadata.len()).unwrap_or(0)
        };
        let index = arena.len();
        arena.push(ArenaNode {
            id: next_id,
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry_path.clone(),
            own_size,
            is_dir,
            extension: if is_dir {
                None
            } else {
                entry_path
                    .extension()
                    .map(|value| value.to_string_lossy().to_lowercase())
            },
            parent: Some(parent),
            children: Vec::new(),
        });
        next_id += 1;
        arena[parent].children.push(index);
        if is_dir {
            dirs += 1;
            directory_indexes.insert(entry_path.clone(), index);
        } else {
            files += 1;
            bytes = bytes.saturating_add(own_size);
        }
        if last_progress.elapsed() >= Duration::from_millis(100) {
            let _ = channel.send(ScanEvent::Progress(Progress {
                files,
                dirs,
                bytes,
                current_path: entry_path.to_string_lossy().into_owned(),
            }));
            last_progress = Instant::now();
        }
    }

    let _ = channel.send(ScanEvent::Progress(Progress {
        files,
        dirs,
        bytes,
        current_path: "Finalizing scan results…".into(),
    }));
    let mut sizes = vec![0_u64; arena.len()];
    calculate_sizes(0, &arena, &mut sizes);
    let mut grouped_id = next_id;
    let treemap = materialize_proportional(0, &arena, &sizes, MAX_RESULT_NODES, &mut grouped_id);
    let mut root = materialize_shallow(0, &arena, &sizes);
    let mut root_children = arena[0].children.clone();
    root_children.sort_unstable_by(|a, b| sizes[*b].cmp(&sizes[*a]));
    root.children = root_children
        .into_iter()
        .map(|index| materialize_shallow(index, &arena, &sizes))
        .collect();
    Ok(ScanOutput {
        result: ScanResult { root, treemap },
        snapshot: ScanSnapshot { arena, sizes },
    })
}

#[tauri::command]
async fn scan_directory(
    path: String,
    on_event: Channel<ScanEvent>,
    state: State<'_, ScanState>,
) -> Result<ScanResult, String> {
    if state.active.swap(true, Ordering::SeqCst) {
        return Err("A scan is already running.".into());
    }
    state.cancelled.store(false, Ordering::SeqCst);
    let cancelled = state.cancelled.clone();
    let output = tauri::async_runtime::spawn_blocking(move || {
        scan(PathBuf::from(path), cancelled, on_event)
    })
    .await
    .map_err(|error| error.to_string())?;
    state.active.store(false, Ordering::SeqCst);
    let output = output?;
    let result = output.result;
    *state.snapshot.lock().map_err(|error| error.to_string())? = Some(output.snapshot);
    Ok(result)
}

#[tauri::command]
fn cancel_scan(state: State<'_, ScanState>) {
    state.cancelled.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn get_children(node_id: u64, state: State<'_, ScanState>) -> Result<Vec<FileNode>, String> {
    let snapshot = state.snapshot.lock().map_err(|error| error.to_string())?;
    let snapshot = snapshot.as_ref().ok_or("No completed scan is available.")?;
    let index = usize::try_from(node_id.saturating_sub(1)).map_err(|error| error.to_string())?;
    let item = snapshot
        .arena
        .get(index)
        .ok_or_else(|| "The requested item no longer exists.".to_string())?;
    let mut children = item.children.clone();
    children.sort_unstable_by(|a, b| {
        snapshot.sizes[*b]
            .cmp(&snapshot.sizes[*a])
            .then_with(|| snapshot.arena[*a].name.cmp(&snapshot.arena[*b].name))
    });
    Ok(children
        .into_iter()
        .map(|child| materialize_shallow(child, &snapshot.arena, &snapshot.sizes))
        .collect())
}

#[tauri::command]
fn get_ancestors(node_id: u64, state: State<'_, ScanState>) -> Result<Vec<u64>, String> {
    let snapshot = state.snapshot.lock().map_err(|error| error.to_string())?;
    let snapshot = snapshot.as_ref().ok_or("No completed scan is available.")?;
    let mut index =
        usize::try_from(node_id.saturating_sub(1)).map_err(|error| error.to_string())?;
    if index >= snapshot.arena.len() {
        return Ok(Vec::new());
    }
    let mut ancestors = Vec::new();
    while let Some(parent) = snapshot.arena[index].parent {
        ancestors.push(snapshot.arena[parent].id);
        index = parent;
    }
    ancestors.reverse();
    Ok(ancestors)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ScanState::default())
        .invoke_handler(tauri::generate_handler![
            scan_directory,
            cancel_scan,
            get_children,
            get_ancestors
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpenDirStat");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arena_node(name: &str, size: u64, is_dir: bool, children: Vec<usize>) -> ArenaNode {
        ArenaNode {
            id: name.bytes().map(u64::from).sum(),
            name: name.into(),
            path: PathBuf::from("/scan").join(name),
            own_size: size,
            is_dir,
            extension: (!is_dir).then(|| "dat".into()),
            parent: None,
            children,
        }
    }

    #[test]
    fn materialize_aggregates_nested_sizes_and_sorts_largest_first() {
        let arena = vec![
            arena_node("root", 0, true, vec![1, 2]),
            arena_node("small.dat", 12, false, vec![]),
            arena_node("folder", 0, true, vec![3, 4]),
            arena_node("large.dat", 800, false, vec![]),
            arena_node("medium.dat", 200, false, vec![]),
        ];

        let mut sizes = vec![0; arena.len()];
        calculate_sizes(0, &arena, &mut sizes);
        let mut grouped_id = 10_000;
        let root = materialize_proportional(0, &arena, &sizes, MAX_RESULT_NODES, &mut grouped_id);

        assert_eq!(root.size, 1_012);
        assert_eq!(root.children[0].name, "folder");
        assert_eq!(root.children[0].size, 1_000);
        assert_eq!(root.children[0].children[0].name, "large.dat");
        assert_eq!(root.children[1].name, "small.dat");
    }

    #[test]
    fn materialize_preserves_file_metadata() {
        let arena = vec![arena_node("report.dat", 42, false, vec![])];

        let mut sizes = vec![0; arena.len()];
        calculate_sizes(0, &arena, &mut sizes);
        let file = materialize_shallow(0, &arena, &sizes);

        assert_eq!(file.size, 42);
        assert!(!file.is_dir);
        assert_eq!(file.extension.as_deref(), Some("dat"));
        assert!(file.children.is_empty());
    }

    #[test]
    fn display_name_handles_filesystem_root() {
        assert_eq!(display_name(Path::new("/")), "/");
        assert_eq!(display_name(Path::new("/tmp/example")), "example");
    }

    #[test]
    fn bounded_materialization_groups_excess_children_without_losing_size() {
        let mut arena = vec![arena_node("root", 0, true, (1..=300).collect())];
        arena.extend((0..300).map(|index| {
            arena_node(
                &format!("file-{index}.dat"),
                index as u64 + 1,
                false,
                vec![],
            )
        }));
        let mut sizes = vec![0; arena.len()];
        let expected = calculate_sizes(0, &arena, &mut sizes);
        let mut grouped_id = 10_000;

        let root = materialize_proportional(0, &arena, &sizes, 251, &mut grouped_id);

        assert_eq!(root.size, expected);
        assert_eq!(root.children.len(), 251);
        assert!(root
            .children
            .iter()
            .any(|child| child.name == "[50 smaller items]"));
        assert_eq!(
            root.children.iter().map(|child| child.size).sum::<u64>(),
            expected
        );
    }
}
