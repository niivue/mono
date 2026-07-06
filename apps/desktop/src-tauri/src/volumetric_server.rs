use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use serde_json::{json, Value};
use std::{
    collections::{hash_map::DefaultHasher, HashMap, HashSet, VecDeque},
    fs::{self, File},
    hash::{Hash, Hasher},
    io::Read,
    net::TcpListener,
    path::{Path as FsPath, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::UNIX_EPOCH,
};
use tokio::runtime::Builder;
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

#[derive(Clone)]
pub struct ServerHandle {
    pub url: String,
    pub port: u16,
    pub volume_count: usize,
    volumes: VolumeStore,
    dataset_root: Arc<Mutex<Option<PathBuf>>>,
    preview_cache: Arc<Mutex<PreviewCache>>,
    decoded_level_cache: Arc<Mutex<DecodedLevelCache>>,
    pyramid_locks: PyramidLocks,
    warm_generation: Arc<AtomicU64>,
    warm_progress: Arc<Mutex<WarmProgress>>,
}

type VolumeStore = Arc<Mutex<Vec<VolumeEntry>>>;
/// Per-volume build locks keyed by source signature, so different volumes can
/// build their pyramids concurrently while same-volume builds stay serialized.
type PyramidLocks = Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>;

/// Total byte budget for the in-memory rendered-preview cache. Cache keys
/// include client-controlled fields (size, version, region), so without a
/// ceiling a client could grow this without bound; evict oldest-first past it.
const PREVIEW_CACHE_MAX_BYTES: usize = 256 * 1024 * 1024;

/// Byte-bounded, insertion-ordered (FIFO) cache of rendered preview BMPs.
/// Exposes the subset of the HashMap API the call sites use so they stay
/// unchanged: `get` (read), `insert` (evicts past the budget), and `clear`.
#[derive(Default)]
struct PreviewCache {
    entries: HashMap<String, Vec<u8>>,
    order: VecDeque<String>,
    total_bytes: usize,
}

impl PreviewCache {
    fn get(&self, key: &str) -> Option<&Vec<u8>> {
        self.entries.get(key)
    }

    fn insert(&mut self, key: String, bytes: Vec<u8>) {
        if let Some(previous) = self.entries.remove(&key) {
            self.total_bytes = self.total_bytes.saturating_sub(previous.len());
            if let Some(pos) = self.order.iter().position(|existing| existing == &key) {
                self.order.remove(pos);
            }
        }
        // A single entry larger than the whole budget is never worth caching.
        if bytes.len() > PREVIEW_CACHE_MAX_BYTES {
            return;
        }
        self.total_bytes += bytes.len();
        self.order.push_back(key.clone());
        self.entries.insert(key, bytes);
        while self.total_bytes > PREVIEW_CACHE_MAX_BYTES {
            let Some(evicted) = self.order.pop_front() else {
                break;
            };
            if let Some(removed) = self.entries.remove(&evicted) {
                self.total_bytes = self.total_bytes.saturating_sub(removed.len());
            }
        }
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
        self.total_bytes = 0;
    }
}

/// Total byte budget for cached decoded pyramid-level voxel data. This stores
/// decompressed coarse levels only, never full source volumes by default.
const DEFAULT_DECODED_LEVEL_CACHE_BYTES: usize = 512 * 1024 * 1024;

#[derive(Clone)]
struct DecodedNifti {
    header: NiftiHeader,
    data: Vec<u8>,
}

#[derive(Default)]
struct DecodedLevelCache {
    entries: HashMap<String, Arc<DecodedNifti>>,
    order: VecDeque<String>,
    total_bytes: usize,
}

impl DecodedLevelCache {
    fn get(&self, key: &str) -> Option<Arc<DecodedNifti>> {
        self.entries.get(key).cloned()
    }

    fn insert(&mut self, key: String, decoded: Arc<DecodedNifti>) {
        if let Some(previous) = self.entries.remove(&key) {
            self.total_bytes = self.total_bytes.saturating_sub(previous.data.len());
            if let Some(pos) = self.order.iter().position(|existing| existing == &key) {
                self.order.remove(pos);
            }
        }

        let entry_bytes = decoded.data.len();
        if entry_bytes > decoded_level_cache_budget_bytes() {
            return;
        }

        self.total_bytes += entry_bytes;
        self.order.push_back(key.clone());
        self.entries.insert(key, decoded);
        self.evict_to_budget();
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
        self.total_bytes = 0;
    }

    fn evict_to_budget(&mut self) {
        let budget = decoded_level_cache_budget_bytes();
        while self.total_bytes > budget {
            let Some(evicted) = self.order.pop_front() else {
                break;
            };
            if let Some(removed) = self.entries.remove(&evicted) {
                self.total_bytes = self.total_bytes.saturating_sub(removed.data.len());
            }
        }
    }
}

fn decoded_level_cache_budget_bytes() -> usize {
    std::env::var("NEUROVUE_DECODED_LEVEL_CACHE_BYTES")
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .filter(|&bytes| bytes > 0)
        .unwrap_or(DEFAULT_DECODED_LEVEL_CACHE_BYTES)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WarmProgressSnapshot {
    pub active: bool,
    pub completed: usize,
    pub total: usize,
}

#[derive(Clone)]
pub struct RegisteredVolume {
    pub id: String,
    pub label: String,
}

#[derive(Default)]
struct WarmProgress {
    generation: u64,
    active: bool,
    completed: usize,
    total: usize,
}

impl WarmProgress {
    fn snapshot(&self) -> WarmProgressSnapshot {
        WarmProgressSnapshot {
            active: self.active,
            completed: self.completed,
            total: self.total,
        }
    }
}

#[derive(Clone)]
struct AppState {
    base_url: String,
    volumes: VolumeStore,
    dataset_root: Arc<Mutex<Option<PathBuf>>>,
    preview_cache: Arc<Mutex<PreviewCache>>,
    decoded_level_cache: Arc<Mutex<DecodedLevelCache>>,
    pyramid_locks: PyramidLocks,
    patch: Arc<Mutex<Option<Value>>>,
    /// Caps concurrent slice renders so a burst of cold tiles can't each
    /// decode a full volume into memory at once.
    render_semaphore: Arc<tokio::sync::Semaphore>,
}

/// How many slice renders may run concurrently. Each holds a full decoded
/// volume in memory, so keep this well below the worker-thread count.
fn render_permits() -> usize {
    std::thread::available_parallelism()
        .map(|n| (n.get() / 2).clamp(2, 4))
        .unwrap_or(2)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VolumeEntry {
    id: String,
    label: String,
    role: VolumeRole,
    format: String,
    shape: [u16; 3],
    spacing: [f32; 3],
    dtype: String,
    source_path: Option<PathBuf>,
    #[serde(skip)]
    cache_signature: Option<String>,
    sidecar_paths: Vec<PathBuf>,
    derived_from: Option<String>,
    derivation: Option<VolumeDerivation>,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
enum VolumeRole {
    Source,
    Overlay,
    Derived,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VolumeDerivation {
    operation: String,
    source_path: String,
    output_path: String,
}

#[derive(Deserialize)]
struct SlicePath {
    vol_id: String,
    axis: String,
    slice: u16,
}

#[derive(Deserialize)]
struct ImagePath {
    vol_id: String,
    axis: String,
    slice: u16,
    region: String,
    size: String,
    rotation: String,
    quality_format: String,
}

#[derive(Clone, Copy)]
struct ImageRegion {
    x: usize,
    y: usize,
    width: usize,
    height: usize,
}

#[derive(Deserialize)]
struct ImageQuery {
    level: Option<u8>,
    v: Option<String>,
}

#[derive(Deserialize)]
struct LevelPath {
    vol_id: String,
    level: u8,
}

pub fn spawn_default() -> ServerHandle {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind NeuroVue local server");
    let addr = listener
        .local_addr()
        .expect("read NeuroVue local server addr");
    listener
        .set_nonblocking(true)
        .expect("set NeuroVue listener nonblocking");

    let base_url = format!("http://{}", addr);
    let discovery = discover_volumes();
    let volume_count = discovery.volumes.len();
    let warm_volumes = discovery.volumes.clone();
    let warm_root = discovery.root.clone();
    let volumes = Arc::new(Mutex::new(discovery.volumes));
    let dataset_root = Arc::new(Mutex::new(discovery.root));
    let preview_cache = Arc::new(Mutex::new(PreviewCache::default()));
    let decoded_level_cache = Arc::new(Mutex::new(DecodedLevelCache::default()));
    let pyramid_locks: PyramidLocks = Arc::new(Mutex::new(HashMap::new()));
    let warm_generation = Arc::new(AtomicU64::new(0));
    let warm_progress = Arc::new(Mutex::new(WarmProgress::default()));
    let state = AppState {
        base_url: base_url.clone(),
        volumes: volumes.clone(),
        dataset_root: dataset_root.clone(),
        preview_cache: preview_cache.clone(),
        decoded_level_cache: decoded_level_cache.clone(),
        pyramid_locks: pyramid_locks.clone(),
        patch: Arc::new(Mutex::new(None)),
        render_semaphore: Arc::new(tokio::sync::Semaphore::new(render_permits())),
    };

    // Warm pyramid levels for the startup sample in the background.
    let my_gen = warm_generation.load(Ordering::SeqCst);
    spawn_pyramid_warm(
        warm_volumes,
        warm_root,
        pyramid_locks.clone(),
        warm_generation.clone(),
        warm_progress.clone(),
        my_gen,
    );

    std::thread::spawn(move || {
        let runtime = Builder::new_multi_thread()
            .enable_all()
            .thread_name("neurovue-server")
            .build()
            .expect("build NeuroVue local server runtime");

        runtime.block_on(async move {
            let listener =
                tokio::net::TcpListener::from_std(listener).expect("adopt NeuroVue listener");
            let app = Router::new()
                .route("/api", get(api_info))
                .route("/iiif/desktop", get(desktops))
                .route("/iiif/desktop/:desktop_id/manifest", get(desktop_manifest))
                .route("/iiif/desktop/:desktop_id/version", get(desktop_version))
                .route("/volumes/:vol_id/metadata", get(volume_metadata))
                .route("/volumes/:vol_id/raw", get(raw_volume))
                .route("/volumes/:vol_id/raw.nii", get(raw_volume))
                .route("/volumes/:vol_id/raw.nii.gz", get(raw_volume))
                .route(
                    "/volumes/:vol_id/levels/:level/raw.nii",
                    get(raw_level_volume),
                )
                .route(
                    "/iiif/image/:vol_id/:axis/:slice/info.json",
                    get(image_info),
                )
                .route(
                    "/iiif/image/:vol_id/:axis/:slice/:region/:size/:rotation/:quality_format",
                    get(image_tile),
                )
                .route(
                    "/session/correction.patch.json",
                    get(read_patch).post(write_patch),
                )
                .layer(app_cors_layer())
                .with_state(state);

            if let Err(error) = axum::serve(listener, app).await {
                eprintln!("NeuroVue local server stopped: {error}");
            }
        });
    });

    ServerHandle {
        url: base_url,
        port: addr.port(),
        volume_count,
        volumes,
        dataset_root,
        preview_cache,
        decoded_level_cache,
        pyramid_locks,
        warm_generation,
        warm_progress,
    }
}

/// Lock a mutex, recovering the guard if another thread poisoned it by panicking
/// while holding it. These locks never wrap panicking work, so the data behind
/// them stays consistent — and degrading to "every volume vanished" on poison is
/// far worse than carrying on.
fn lock_recover<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn dataset_root(handle: &ServerHandle) -> Option<PathBuf> {
    lock_recover(&handle.dataset_root).clone()
}

/// BIDS dataset metadata read from `dataset_description.json`. BIDS defines no
/// guaranteed-unique dataset id, so this is purely informational (the preview
/// cache is still keyed by path); `Name` and the optional `DatasetDOI` are the
/// useful identifiers to surface.
#[derive(Clone, Default)]
pub struct BidsDatasetInfo {
    pub name: Option<String>,
    pub bids_version: Option<String>,
    pub dataset_doi: Option<String>,
}

/// Read `dataset_description.json` at the current dataset root, if present.
pub fn bids_dataset_info(handle: &ServerHandle) -> Option<BidsDatasetInfo> {
    read_bids_dataset_info(&dataset_root(handle)?)
}

fn read_bids_dataset_info(root: &FsPath) -> Option<BidsDatasetInfo> {
    let text = fs::read_to_string(root.join("dataset_description.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let string_field = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(|raw| raw.trim().to_string())
            .filter(|trimmed| !trimmed.is_empty())
    };
    Some(BidsDatasetInfo {
        name: string_field("Name"),
        bids_version: string_field("BIDSVersion"),
        dataset_doi: string_field("DatasetDOI"),
    })
}

pub fn cache_root() -> PathBuf {
    std::env::temp_dir().join("neurovue")
}

/// Origins allowed to read from the local server: the app's own webview (the
/// vite dev URL in development, the tauri:// scheme in a packaged build). This
/// replaces the previous permissive CORS so an arbitrary web page the user
/// visits can't fetch their local volume data. `<img>` previews still display
/// cross-origin (image display isn't CORS-gated); only fetch-based reads are
/// restricted. Extra origins can be added via NEUROVUE_ALLOWED_ORIGINS (comma
/// separated).
fn app_cors_layer() -> CorsLayer {
    let mut origins = vec![
        "http://127.0.0.1:5175".to_string(),
        "http://localhost:5175".to_string(),
        "tauri://localhost".to_string(),
        "https://tauri.localhost".to_string(),
    ];
    if let Ok(extra) = std::env::var("NEUROVUE_ALLOWED_ORIGINS") {
        origins.extend(
            extra
                .split(',')
                .map(str::trim)
                .filter(|origin| !origin.is_empty())
                .map(str::to_string),
        );
    }
    let allowed = origins
        .iter()
        .filter_map(|origin| HeaderValue::from_str(origin).ok())
        .collect::<Vec<_>>();

    CorsLayer::new()
        .allow_origin(AllowOrigin::list(allowed))
        .allow_methods(Any)
        .allow_headers(Any)
}

pub fn working_derivatives_dir() -> PathBuf {
    cache_root().join("working-derivatives")
}

pub fn open_dataset_root(handle: &ServerHandle, root: &std::path::Path) -> Result<usize, String> {
    let root = fs::canonicalize(root)
        .map_err(|error| format!("open_dataset_root: {}: {error}", root.display()))?;
    if !root.is_dir() {
        return Err(format!(
            "open_dataset_root: not a directory: {}",
            root.display()
        ));
    }

    let mut volumes = discover_volumes_in_root(&root, max_volume_count());
    if volumes.is_empty() {
        let mut candidates = Vec::new();
        collect_nifti_paths(&root, &mut candidates, max_volume_count());
        if candidates.is_empty() {
            return Err(format!(
                "open_dataset_root: no .nii or .nii.gz files found under {}",
                root.display()
            ));
        }
        return Err(format!(
            "open_dataset_root: found {} .nii/.nii.gz file(s) under {} but none have a readable NIfTI header (likely empty stubs or unsupported variants)",
            candidates.len(),
            root.display()
        ));
    }
    append_working_derivatives(&mut volumes, Some(&root));
    let volume_count = volumes.len();
    let warm_volumes = volumes.clone();
    let warm_root = Some(root.clone());

    *lock_recover(&handle.volumes) = volumes;
    *lock_recover(&handle.dataset_root) = Some(root);
    lock_recover(&handle.preview_cache).clear();
    lock_recover(&handle.decoded_level_cache).clear();

    // Cancel any in-flight warming for the previous dataset, then warm the new one.
    let my_gen = handle.warm_generation.fetch_add(1, Ordering::SeqCst) + 1;
    spawn_pyramid_warm(
        warm_volumes,
        warm_root.clone(),
        handle.pyramid_locks.clone(),
        handle.warm_generation.clone(),
        handle.warm_progress.clone(),
        my_gen,
    );

    // Prune old dataset caches in the background, keeping the one we just opened.
    let keep_segment = dataset_segment(warm_root.as_deref());
    std::thread::spawn(move || sweep_dataset_cache(&keep_segment));

    Ok(volume_count)
}

pub fn volume_count(handle: &ServerHandle) -> usize {
    handle
        .volumes
        .lock()
        .map(|volumes| volumes.len())
        .unwrap_or(handle.volume_count)
}

pub fn warm_progress(handle: &ServerHandle) -> WarmProgressSnapshot {
    lock_recover(&handle.warm_progress).snapshot()
}

pub fn register_derived_volume(
    handle: &ServerHandle,
    source_path: &std::path::Path,
    output_path: &std::path::Path,
    operation: &str,
) -> Result<String, String> {
    let header = read_nifti_header(output_path).ok_or_else(|| {
        format!(
            "register_derived_volume: unreadable NIfTI {}",
            output_path.display()
        )
    })?;
    let output_parent = output_path.parent().unwrap_or_else(|| FsPath::new(""));
    let output_id = volume_id(output_path, output_parent);
    let source_path = fs::canonicalize(source_path).map_err(|error| {
        format!(
            "register_derived_volume: source {}: {error}",
            source_path.display()
        )
    })?;
    let output_path = fs::canonicalize(output_path).map_err(|error| {
        format!(
            "register_derived_volume: output {}: {error}",
            output_path.display()
        )
    })?;
    let mut volumes = lock_recover(&handle.volumes);
    let source_id = volumes
        .iter()
        .find(|volume| {
            volume
                .source_path
                .as_deref()
                .is_some_and(|path| same_canonical_path(path, &source_path))
        })
        .map(|volume| volume.id.clone());
    let unique_id = unique_volume_id(&volumes, &format!("derived__{output_id}"));
    let source_label = source_id
        .as_deref()
        .and_then(|id| volumes.iter().find(|volume| volume.id == id))
        .map(|volume| volume.label.clone())
        .unwrap_or_else(|| "Derived volume".to_string());
    let cache_signature = source_cache_signature(&unique_id, &output_path, &header);

    volumes.push(VolumeEntry {
        id: unique_id.clone(),
        label: format!("{source_label} / {operation}"),
        role: VolumeRole::Derived,
        format: "nifti".to_string(),
        shape: header.shape,
        spacing: header.spacing,
        dtype: header.dtype,
        source_path: Some(output_path.clone()),
        cache_signature,
        sidecar_paths: find_json_sidecars(&output_path, output_parent),
        derived_from: source_id,
        derivation: Some(VolumeDerivation {
            operation: operation.to_string(),
            source_path: source_path.display().to_string(),
            output_path: output_path.display().to_string(),
        }),
    });

    Ok(unique_id)
}

pub fn register_overlay_volume(
    handle: &ServerHandle,
    overlay_path: &std::path::Path,
) -> Result<RegisteredVolume, String> {
    let overlay_path = fs::canonicalize(overlay_path).map_err(|error| {
        format!(
            "register_overlay_volume: {}: {error}",
            overlay_path.display()
        )
    })?;
    if !overlay_path.is_file() || !is_nifti_path(&overlay_path) {
        return Err(format!(
            "register_overlay_volume: not a NIfTI file: {}",
            overlay_path.display()
        ));
    }
    let header = read_nifti_header(&overlay_path).ok_or_else(|| {
        format!(
            "register_overlay_volume: unreadable NIfTI {}",
            overlay_path.display()
        )
    })?;
    let dataset_root = dataset_root(handle);
    let mut volumes = lock_recover(&handle.volumes);

    if let Some(existing) = volumes.iter().find(|volume| {
        volume
            .source_path
            .as_deref()
            .is_some_and(|path| same_canonical_path(path, &overlay_path))
    }) {
        return Ok(RegisteredVolume {
            id: existing.id.clone(),
            label: existing.label.clone(),
        });
    }

    if volumes.len() >= max_volume_count() {
        return Err(format!(
            "register_overlay_volume: volume limit {} reached",
            max_volume_count()
        ));
    }

    let overlay_root = dataset_root
        .as_deref()
        .filter(|root| overlay_path.starts_with(root))
        .or_else(|| overlay_path.parent())
        .unwrap_or_else(|| FsPath::new(""));
    let overlay_id = volume_id(&overlay_path, overlay_root);
    let unique_id = unique_volume_id(&volumes, &format!("overlay__{overlay_id}"));
    let label = overlay_volume_label(&overlay_path, overlay_root, &unique_id);
    let cache_signature = source_cache_signature(&unique_id, &overlay_path, &header);
    let entry = VolumeEntry {
        id: unique_id.clone(),
        label: label.clone(),
        role: VolumeRole::Overlay,
        format: "nifti".to_string(),
        shape: header.shape,
        spacing: header.spacing,
        dtype: header.dtype,
        source_path: Some(overlay_path.clone()),
        cache_signature,
        sidecar_paths: find_json_sidecars(&overlay_path, overlay_root),
        derived_from: None,
        derivation: None,
    };

    volumes.push(entry.clone());
    drop(volumes);

    let my_gen = handle.warm_generation.fetch_add(1, Ordering::SeqCst) + 1;
    spawn_pyramid_warm(
        vec![entry],
        dataset_root,
        handle.pyramid_locks.clone(),
        handle.warm_generation.clone(),
        handle.warm_progress.clone(),
        my_gen,
    );

    Ok(RegisteredVolume {
        id: unique_id,
        label,
    })
}

/// Result of writing a portable `.nvbundle` to disk.
pub struct BundleExportResult {
    pub bundle_path: String,
    pub volume_count: usize,
    pub total_bytes: u64,
}

/// Export the given volumes (and their JSON sidecars) into a self-describing
/// bundle directory at `dest`: `<dest>/manifest.json` + `<dest>/data/*`. Each
/// data file gets a cryptographic (SHA-256) content hash recorded in the
/// manifest so a later import can verify integrity. `view` is an opaque
/// view-state blob supplied by the frontend (layers, colormaps, windows, clip
/// planes, …) and is round-tripped verbatim. `created_at` is an ISO-8601
/// timestamp from the caller (kept out of Rust to avoid a time-format dep, and
/// to match the existing `savePatch` convention).
///
/// The bundle format is intentionally container-agnostic (a plain directory
/// today); zipping it into a single AirDrop-friendly file is a thin wrapper the
/// share transport can add later. Whole-volume export only for now — the
/// per-volume manifest entry has room for a future `sliceRange` field.
pub fn export_bundle(
    handle: &ServerHandle,
    dest: &FsPath,
    volume_ids: &[String],
    view: &Value,
    created_at: &str,
) -> Result<BundleExportResult, String> {
    if volume_ids.is_empty() {
        return Err("export_bundle: no volumes selected for export".to_string());
    }

    // Resolve every requested id up front (preserving request order) so we fail
    // before touching the filesystem if any is unknown or lacks a source file.
    let selected: Vec<VolumeEntry> = {
        let volumes = lock_recover(&handle.volumes);
        let mut out = Vec::with_capacity(volume_ids.len());
        for id in volume_ids {
            let entry = volumes
                .iter()
                .find(|volume| &volume.id == id)
                .ok_or_else(|| format!("export_bundle: unknown volume {id}"))?;
            if entry.source_path.is_none() {
                return Err(format!("export_bundle: volume {id} has no source file"));
            }
            out.push(entry.clone());
        }
        out
    };

    // Guard the destination: replace a prior NeuroVue bundle, but never clobber
    // a non-bundle directory the user may have picked by mistake.
    if dest.is_dir() {
        if dest.join("manifest.json").is_file() {
            fs::remove_dir_all(dest)
                .map_err(|error| format!("export_bundle: replace {}: {error}", dest.display()))?;
        } else if dir_is_non_empty(dest) {
            return Err(format!(
                "export_bundle: {} exists and is not a NeuroVue bundle",
                dest.display()
            ));
        }
    } else if dest.is_file() {
        fs::remove_file(dest)
            .map_err(|error| format!("export_bundle: overwrite {}: {error}", dest.display()))?;
    }

    let data_dir = dest.join("data");
    fs::create_dir_all(&data_dir)
        .map_err(|error| format!("export_bundle: create {}: {error}", data_dir.display()))?;

    let mut used_names: HashSet<String> = HashSet::new();
    let mut total_bytes: u64 = 0;
    let mut manifest_volumes: Vec<Value> = Vec::with_capacity(selected.len());

    for entry in &selected {
        let source = entry
            .source_path
            .as_ref()
            .expect("source_path presence checked above");
        let (rel, bytes, sha) = copy_into_bundle(source, &data_dir, &mut used_names, "volume.nii")?;
        total_bytes += bytes;

        let mut sidecars: Vec<Value> = Vec::new();
        for sidecar in &entry.sidecar_paths {
            let (sc_rel, sc_bytes, sc_sha) =
                copy_into_bundle(sidecar, &data_dir, &mut used_names, "sidecar.json")?;
            total_bytes += sc_bytes;
            sidecars.push(json!({
                "name": file_name_or(sidecar, "sidecar.json"),
                "data": sc_rel,
                "sha256": sc_sha,
                "bytes": sc_bytes,
            }));
        }

        manifest_volumes.push(json!({
            "id": entry.id,
            "role": entry.role,
            "label": entry.label,
            "data": rel,
            "sha256": sha,
            "bytes": bytes,
            "shape": entry.shape,
            "spacing": entry.spacing,
            "dtype": entry.dtype,
            "derivedFrom": entry.derived_from,
            "derivation": entry.derivation,
            "sidecars": sidecars,
        }));
    }

    let bids = bids_dataset_info(handle);
    let manifest = json!({
        "nvbundle": "1",
        "kind": "dataset-subset",
        "createdAt": created_at,
        "tool": { "name": "NeuroVue", "version": env!("CARGO_PKG_VERSION") },
        "source": {
            "datasetName": bids.as_ref().and_then(|info| info.name.clone()),
            "datasetDoi": bids.as_ref().and_then(|info| info.dataset_doi.clone()),
            "datasetRoot": dataset_root(handle).map(|path| path.display().to_string()),
        },
        "volumes": manifest_volumes,
        "view": view,
    });

    let manifest_path = dest.join("manifest.json");
    let manifest_text = serde_json::to_string_pretty(&manifest)
        .map_err(|error| format!("export_bundle: serialize manifest: {error}"))?;
    fs::write(&manifest_path, manifest_text)
        .map_err(|error| format!("export_bundle: write {}: {error}", manifest_path.display()))?;

    Ok(BundleExportResult {
        bundle_path: dest.display().to_string(),
        volume_count: selected.len(),
        total_bytes,
    })
}

/// Copy `source` into `data_dir` under a bundle-unique file name, returning the
/// bundle-relative path (`data/<name>`), the byte count, and the SHA-256 hash.
fn copy_into_bundle(
    source: &FsPath,
    data_dir: &FsPath,
    used_names: &mut HashSet<String>,
    fallback: &str,
) -> Result<(String, u64, String), String> {
    let name = unique_bundle_name(source, used_names, fallback);
    let out = data_dir.join(&name);
    let bytes = fs::copy(source, &out)
        .map_err(|error| format!("export_bundle: copy {}: {error}", source.display()))?;
    let sha = sha256_file(&out)
        .map_err(|error| format!("export_bundle: hash {}: {error}", out.display()))?;
    Ok((format!("data/{name}"), bytes, sha))
}

/// Stream a file through SHA-256 without holding it in memory (volumes are big).
fn sha256_file(path: &FsPath) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 1 << 16];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Pick a file name for the bundle's `data/` dir that hasn't been used yet,
/// disambiguating collisions (e.g. two `sub-01_T1w.json` sidecars) with a
/// numeric prefix so nothing silently overwrites.
fn unique_bundle_name(source: &FsPath, used: &mut HashSet<String>, fallback: &str) -> String {
    let base = file_name_or(source, fallback);
    if used.insert(base.clone()) {
        return base;
    }
    let mut counter = 1usize;
    loop {
        let candidate = format!("{counter}-{base}");
        if used.insert(candidate.clone()) {
            return candidate;
        }
        counter += 1;
    }
}

fn file_name_or(path: &FsPath, fallback: &str) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(fallback)
        .to_string()
}

fn dir_is_non_empty(dir: &FsPath) -> bool {
    fs::read_dir(dir)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}

/// Read a bundle's `manifest.json` and verify every declared data file against
/// its recorded SHA-256. Pure read — no server state changes; the frontend
/// loads the volumes separately via the normal open-dataset seam (the bundle's
/// `data/` dir). Returns the parsed manifest plus a per-file verification list
/// so the UI can warn on stale/modified/corrupt payloads before trusting them.
pub fn read_bundle(path: &FsPath) -> Result<Value, String> {
    let root = fs::canonicalize(path)
        .map_err(|error| format!("read_bundle: {}: {error}", path.display()))?;
    let manifest_path = root.join("manifest.json");
    let text = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("read_bundle: read {}: {error}", manifest_path.display()))?;
    let manifest: Value = serde_json::from_str(&text)
        .map_err(|error| format!("read_bundle: parse {}: {error}", manifest_path.display()))?;

    let mut verification: Vec<Value> = Vec::new();
    let mut all_verified = true;
    if let Some(volumes) = manifest.get("volumes").and_then(Value::as_array) {
        for volume in volumes {
            verify_bundle_entry(&root, volume, &mut verification, &mut all_verified);
            if let Some(sidecars) = volume.get("sidecars").and_then(Value::as_array) {
                for sidecar in sidecars {
                    verify_bundle_entry(&root, sidecar, &mut verification, &mut all_verified);
                }
            }
        }
    }

    Ok(json!({
        "manifest": manifest,
        "bundlePath": root.display().to_string(),
        "dataDir": root.join("data").display().to_string(),
        "verification": verification,
        "allVerified": all_verified,
    }))
}

/// Hash-check one manifest entry (`{ data, sha256 }`) and push a result record.
/// Rejects any `data` path that escapes the bundle root (absolute or `..`).
fn verify_bundle_entry(root: &FsPath, entry: &Value, out: &mut Vec<Value>, all_verified: &mut bool) {
    let Some(rel) = entry.get("data").and_then(Value::as_str) else {
        return;
    };
    let expected = entry.get("sha256").and_then(Value::as_str).unwrap_or("");

    let rel_path = FsPath::new(rel);
    let escapes = rel_path.is_absolute()
        || rel_path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir));
    let (status, actual) = if escapes {
        ("invalid", None)
    } else {
        let file = root.join(rel_path);
        if !file.is_file() {
            ("missing", None)
        } else {
            match sha256_file(&file) {
                Ok(hash) if hash == expected => ("ok", Some(hash)),
                Ok(hash) => ("mismatch", Some(hash)),
                Err(_) => ("unreadable", None),
            }
        }
    };
    if status != "ok" {
        *all_verified = false;
    }
    out.push(json!({
        "data": rel,
        "expected": expected,
        "actual": actual,
        "status": status,
    }));
}

async fn api_info(State(state): State<AppState>) -> Json<Value> {
    let volumes = lock_recover(&state.volumes).clone();
    Json(json!({
        "service": "neurovue-volumetric-server",
        "version": "0.1.0",
        "desktop": format!("{}/iiif/desktop/neuro/manifest", state.base_url),
        "volumes": volumes.iter().map(|volume| {
            let encoded = url_component(&volume.id);
            json!({
                "id": volume.id,
                "role": volume.role,
                "derivedFrom": volume.derived_from.as_deref(),
                "format": volume.format,
                "shape": volume.shape,
                "spacing": volume.spacing,
                "dtype": volume.dtype,
                "metadata": format!("{}/volumes/{}/metadata", state.base_url, encoded),
                "raw": raw_volume_url(&state.base_url, &encoded, volume),
            })
        }).collect::<Vec<_>>()
    }))
}

async fn desktops(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "desktops": [{
            "id": "neuro",
            "manifest": format!("{}/iiif/desktop/neuro/manifest", state.base_url),
            "viewer": state.base_url,
        }]
    }))
}

fn grid_rows(count: u32, columns: u32) -> u32 {
    if count == 0 {
        0
    } else {
        count.div_ceil(columns.max(1))
    }
}

fn grid_height(rows: u32, tile_size: u32, gap: u32) -> u32 {
    if rows == 0 {
        0
    } else {
        rows * tile_size + rows.saturating_sub(1) * gap
    }
}

async fn desktop_manifest(
    Path(desktop_id): Path<String>,
    State(state): State<AppState>,
) -> Json<Value> {
    let volumes = lock_recover(&state.volumes).clone();
    let tile_size = 1024_u32;
    let gap = 96_u32;
    let pitch = tile_size + gap;
    let section_label_space = tile_size * 2;
    let section_gap = 512_u32;
    let source_count = volumes
        .iter()
        .filter(|volume| volume.role != VolumeRole::Derived)
        .count() as u32;
    let derived_count = volumes
        .iter()
        .filter(|volume| volume.role == VolumeRole::Derived)
        .count() as u32;
    let layout_count = source_count.max(derived_count).max(1);
    let columns = (layout_count as f64).sqrt().ceil().max(1.0) as u32;
    let source_rows = grid_rows(source_count, columns);
    let derived_rows = grid_rows(derived_count, columns);
    let source_top = section_label_space;
    let source_height = grid_height(source_rows, tile_size, gap);
    let derived_top = if derived_count > 0 {
        source_top + source_height + section_gap + section_label_space
    } else {
        0
    };
    let derived_height = grid_height(derived_rows, tile_size, gap);
    let rows = source_rows + derived_rows;
    let world_width = columns * tile_size + columns.saturating_sub(1) * gap;
    let world_height = if derived_count > 0 {
        derived_top + derived_height
    } else {
        source_top + source_height
    }
    .max(tile_size);

    let mut source_index = 0_u32;
    let mut derived_index = 0_u32;
    let items = volumes
        .iter()
        .enumerate()
        .map(|(index, volume)| {
            let encoded = url_component(&volume.id);
            let role_index = if volume.role == VolumeRole::Derived {
                let next = derived_index;
                derived_index += 1;
                next
            } else {
                let next = source_index;
                source_index += 1;
                next
            };
            let col = role_index % columns;
            let row = role_index / columns;
            let top = if volume.role == VolumeRole::Derived {
                derived_top
            } else {
                source_top
            };
            let preview_slice = volume.shape[2] / 2;
            let preview_service = format!(
                "{}/iiif/image/{}/axial/{}",
                state.base_url, encoded, preview_slice
            );

            json!({
                "id": volume.id,
                "type": "NiftiVolumeItem",
                "label": volume.label,
                "role": volume.role,
                "index": index,
                "bounds": {
                    "x": col * pitch,
                    "y": top + row * pitch,
                    "width": tile_size,
                    "height": tile_size
                },
                "format": volume.format,
                "shape": volume.shape,
                "spacing": volume.spacing,
                "dtype": volume.dtype,
                "derivedFrom": volume.derived_from.as_deref(),
                "derivation": volume.derivation.as_ref(),
                "manifest": format!("{}/iiif/presentation/{}/manifest", state.base_url, encoded),
                "metadata": format!("{}/volumes/{}/metadata", state.base_url, encoded),
                "preview": {
                    "axis": "axial",
                    "slice": preview_slice,
                    "service": preview_service,
                    "image": format!("{}/full/96,96/0/default.png", preview_service)
                },
                "levels": volume_levels(&state.base_url, &encoded, volume),
                "brickTemplate": format!("{}?level={{level}}&bbox={{bbox}}", raw_volume_url(&state.base_url, &encoded, volume)),
                "sliceServices": {
                    "axial": format!("{}/iiif/image/{}/axial/{{slice}}", state.base_url, encoded),
                    "coronal": format!("{}/iiif/image/{}/coronal/{{slice}}", state.base_url, encoded),
                    "sagittal": format!("{}/iiif/image/{}/sagittal/{{slice}}", state.base_url, encoded)
                }
            })
        })
        .collect::<Vec<_>>();

    Json(json!({
        "type": "VolumeDesktop",
        "id": format!("{}/iiif/desktop/{}/manifest", state.base_url, desktop_id),
        "label": format!("NeuroVue desktop: {}", desktop_id),
        "profile": "https://neurovue.app/iiif/volumetric/osd-desktop/v1",
        "tileSize": tile_size,
        "gap": gap,
        "world": {
            "width": world_width,
            "height": world_height,
            "units": "desktop-px",
            "columns": columns,
            "rows": rows
        },
        "itemCount": items.len(),
        "items": items
    }))
}

async fn desktop_version(
    Path(desktop_id): Path<String>,
    State(state): State<AppState>,
) -> Response {
    let version = desktop_version_string(&state);
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    if let Ok(value) = HeaderValue::from_str(&format!("\"{version}\"")) {
        headers.insert(header::ETAG, value);
    }

    (
        headers,
        Json(json!({
            "id": format!("{}/iiif/desktop/{}/version", state.base_url, desktop_id),
            "version": version
        })),
    )
        .into_response()
}

fn desktop_version_string(state: &AppState) -> String {
    let volumes = lock_recover(&state.volumes);
    let dataset_root = lock_recover(&state.dataset_root);
    let mut hasher = DefaultHasher::new();

    state.base_url.hash(&mut hasher);
    dataset_root.hash(&mut hasher);
    volumes.len().hash(&mut hasher);
    for volume in volumes.iter() {
        volume.id.hash(&mut hasher);
        volume.label.hash(&mut hasher);
        volume.role.hash(&mut hasher);
        volume.format.hash(&mut hasher);
        volume.shape.hash(&mut hasher);
        for spacing in volume.spacing {
            spacing.to_bits().hash(&mut hasher);
        }
        volume.dtype.hash(&mut hasher);
        volume.source_path.hash(&mut hasher);
        volume.cache_signature.hash(&mut hasher);
        volume.derived_from.hash(&mut hasher);
    }

    format!("{:016x}", hasher.finish())
}

async fn volume_metadata(
    Path(vol_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Value>, StatusCode> {
    let volume = find_volume(&state, &vol_id).ok_or(StatusCode::NOT_FOUND)?;
    let sidecars = volume
        .sidecar_paths
        .iter()
        .filter_map(|path| read_json_sidecar(path).map(|metadata| (path, metadata)))
        .map(|(path, metadata)| {
            json!({
                "kind": "json",
                "name": path.file_name().and_then(|name| name.to_str()).unwrap_or("sidecar.json"),
                "path": path.display().to_string(),
                "metadata": metadata
            })
        })
        .collect::<Vec<_>>();

    Ok(Json(json!({
        "id": volume.id,
        "label": volume.label,
        "role": volume.role,
        "format": volume.format,
        "shape": volume.shape,
        "spacing": volume.spacing,
        "dtype": volume.dtype,
        "derivedFrom": volume.derived_from,
        "derivation": volume.derivation,
        "sourcePath": volume.source_path.as_ref().map(|path| path.display().to_string()),
        "sidecars": sidecars
    })))
}

async fn raw_volume(
    Path(vol_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Response, StatusCode> {
    let volume = find_volume(&state, &vol_id).ok_or(StatusCode::NOT_FOUND)?;
    let path = volume.source_path.as_ref().ok_or(StatusCode::NOT_FOUND)?;
    let body = tokio::fs::read(path)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, raw_volume_content_type(path));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=3600"),
    );
    Ok((headers, body).into_response())
}

async fn raw_level_volume(
    Path(path): Path<LevelPath>,
    State(state): State<AppState>,
) -> Result<Response, StatusCode> {
    let volume = find_volume(&state, &path.vol_id).ok_or(StatusCode::NOT_FOUND)?;
    let dataset_root = current_dataset_root(&state);
    let level = clamp_pyramid_level(path.level, volume.shape);
    let path = if level == 0 {
        volume.source_path.clone().ok_or(StatusCode::NOT_FOUND)?
    } else {
        ensure_downsampled_nifti(
            &volume,
            level,
            &state.pyramid_locks,
            dataset_root.as_deref(),
        )
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?
    };
    let body = tokio::fs::read(&path)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, raw_volume_content_type(&path));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=3600"),
    );
    Ok((headers, body).into_response())
}

async fn image_info(
    Path(path): Path<SlicePath>,
    State(state): State<AppState>,
) -> Result<Json<Value>, StatusCode> {
    let volume = find_volume(&state, &path.vol_id).ok_or(StatusCode::NOT_FOUND)?;
    let (width, height) = slice_dims(&volume, &path.axis).ok_or(StatusCode::BAD_REQUEST)?;
    let max_slice = slice_count(&volume, &path.axis).ok_or(StatusCode::BAD_REQUEST)?;
    if path.slice >= max_slice {
        return Err(StatusCode::RANGE_NOT_SATISFIABLE);
    }
    let service_id = format!(
        "{}/iiif/image/{}/{}/{}",
        state.base_url,
        url_component(&volume.id),
        path.axis,
        path.slice
    );

    Ok(Json(json!({
        "@context": "http://iiif.io/api/image/3/context.json",
        "id": service_id,
        "type": "ImageService3",
        "profile": "level1",
        "protocol": "http://iiif.io/api/image",
        "width": width,
        "height": height,
        "tiles": [{
            "width": 512,
            "height": 512,
            "scaleFactors": [1]
        }]
    })))
}

async fn image_tile(
    Path(path): Path<ImagePath>,
    Query(query): Query<ImageQuery>,
    State(state): State<AppState>,
) -> Result<Response, StatusCode> {
    let volume = find_volume(&state, &path.vol_id).ok_or(StatusCode::NOT_FOUND)?;
    let (width, height) = slice_dims(&volume, &path.axis).ok_or(StatusCode::BAD_REQUEST)?;
    let max_slice = slice_count(&volume, &path.axis).ok_or(StatusCode::BAD_REQUEST)?;
    if path.slice >= max_slice {
        return Err(StatusCode::RANGE_NOT_SATISFIABLE);
    }
    if path.rotation != "0" {
        return Err(StatusCode::BAD_REQUEST);
    }
    let region = parse_image_region(&path.region, usize::from(width), usize::from(height))
        .ok_or(StatusCode::BAD_REQUEST)?;

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=300"),
    );

    let cache_key = format!(
        "{}:{}:{}:{}:{}:{}:{:?}:{}",
        path.vol_id,
        path.axis,
        path.slice,
        path.region,
        path.size,
        path.quality_format,
        query.level,
        query.v.as_deref().unwrap_or("")
    );
    if let Some(cached) = lock_recover(&state.preview_cache).get(&cache_key).cloned() {
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/bmp"));
        return Ok((headers, cached).into_response());
    }

    let dataset_root = current_dataset_root(&state);
    let disk_path = disk_preview_cache_path(
        &volume,
        &path.axis,
        path.slice,
        &path.region,
        &path.size,
        &path.rotation,
        &path.quality_format,
        query.level,
        query.v.as_deref().unwrap_or(""),
        dataset_root.as_deref(),
    );
    if let Some(ref dp) = disk_path {
        if let Ok(bytes) = fs::read(dp) {
            lock_recover(&state.preview_cache).insert(cache_key.clone(), bytes.clone());
            headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/bmp"));
            return Ok((headers, bytes).into_response());
        }
    }

    // Cap concurrent renders so a burst of cold tiles can't each hold a full
    // decoded volume in memory at once. The semaphore is never closed, so a
    // failed acquire is unreachable; proceed without a permit if it ever errors.
    let _render_permit = state.render_semaphore.acquire().await.ok();
    // Another request may have rendered this exact tile while we waited.
    if let Some(cached) = lock_recover(&state.preview_cache).get(&cache_key).cloned() {
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/bmp"));
        return Ok((headers, cached).into_response());
    }

    if let Some(bmp) = render_slice_bmp(
        &volume,
        &path.axis,
        path.slice,
        region,
        &path.size,
        query.level,
        &state.pyramid_locks,
        &state.decoded_level_cache,
        dataset_root.as_deref(),
    ) {
        lock_recover(&state.preview_cache).insert(cache_key, bmp.clone());
        if let Some(dp) = disk_path {
            write_preview_to_disk(&dp, &bmp);
        }
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/bmp"));
        return Ok((headers, bmp).into_response());
    }

    let svg = preview_svg(&volume, &path.axis, path.slice, width, height, &path);
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("image/svg+xml; charset=utf-8"),
    );
    Ok((headers, svg).into_response())
}

async fn read_patch(State(state): State<AppState>) -> Json<Value> {
    let patch = lock_recover(&state.patch)
        .clone()
        .unwrap_or_else(|| json!({ "status": "empty" }));
    Json(patch)
}

async fn write_patch(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    let mut patch = lock_recover(&state.patch);
    *patch = Some(payload.clone());
    // Best-effort persistence under NeuroFlow: never fail the HTTP response.
    let persisted_path = persist_correction_patch(&payload);
    Ok(Json(json!({
        "ok": true,
        "path": persisted_path.unwrap_or_else(|| "session://neurovue/correction.patch.json".to_string()),
        "patch": payload
    })))
}

/// Resolved NeuroFlow launch context, present only when running under a session.
struct NeuroflowContext {
    session_dir: PathBuf,
    output_dir: PathBuf,
    step: String,
    tool: String,
    context: Value,
}

/// Read the NeuroFlow session context from the environment, if any.
///
/// Returns `None` when `NEUROFLOW_SESSION` is unset, preserving the legacy
/// in-memory-only behavior.
fn neuroflow_context() -> Option<NeuroflowContext> {
    let session_dir = PathBuf::from(std::env::var_os("NEUROFLOW_SESSION")?);
    let context = fs::read(session_dir.join("context.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or_else(|| json!({}));

    let step = std::env::var("NEUROFLOW_STEP").ok().or_else(|| {
        context
            .get("step")
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    let step = step.unwrap_or_else(|| "explore".to_string());

    let output_dir = std::env::var_os("NEUROFLOW_OUTPUT_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            context
                .get("outputDir")
                .and_then(Value::as_str)
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| session_dir.join("outputs").join(&step));

    let tool = context
        .get("tool")
        .and_then(Value::as_str)
        .unwrap_or("neuroflow.gallery.tools/neurovue")
        .to_string();

    Some(NeuroflowContext {
        session_dir,
        output_dir,
        step,
        tool,
        context,
    })
}

/// Dataset roots declared by the NeuroFlow launch context (`inputs.bids_dir`
/// and the parent directories of `inputs.volumes`).
fn neuroflow_dataset_roots() -> Vec<PathBuf> {
    let Some(ctx) = neuroflow_context() else {
        return Vec::new();
    };
    let inputs = ctx.context.get("inputs");
    let mut roots = Vec::new();

    if let Some(bids_dir) = inputs
        .and_then(|inputs| inputs.get("bids_dir"))
        .and_then(Value::as_str)
    {
        roots.push(PathBuf::from(bids_dir));
    }

    if let Some(volumes) = inputs
        .and_then(|inputs| inputs.get("volumes"))
        .and_then(Value::as_array)
    {
        for volume in volumes.iter().filter_map(Value::as_str) {
            let path = PathBuf::from(volume);
            if let Some(parent) = path.parent() {
                let parent = parent.to_path_buf();
                if !roots.contains(&parent) {
                    roots.push(parent);
                }
            }
        }
    }

    roots
}

/// Persist a saved correction patch to disk and append a provenance line when
/// running under NeuroFlow. Returns the disk path written, if any. All failures
/// are swallowed so HTTP saves never break.
fn persist_correction_patch(payload: &Value) -> Option<String> {
    let ctx = neuroflow_context()?;

    let patch_path = ctx.output_dir.join("correction.patch.json");
    if let Some(parent) = patch_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let written = serde_json::to_vec_pretty(payload)
        .ok()
        .and_then(|bytes| fs::write(&patch_path, bytes).ok())
        .is_some();

    let provenance = json!({
        "ts": iso8601_utc_now(),
        "step": ctx.step,
        "tool": ctx.tool,
        "action": "correction.save",
        "outputs": { "correction.patch.json": "correction.patch.json" },
        "agent": "neurovue@neuroflow-aware"
    });
    if let Ok(mut line) = serde_json::to_vec(&provenance) {
        line.push(b'\n');
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(ctx.session_dir.join("provenance.jsonl"))
        {
            let _ = std::io::Write::write_all(&mut file, &line);
        }
    }

    written.then(|| patch_path.display().to_string())
}

/// Format the current time as an ISO-8601 UTC timestamp (e.g.
/// `2026-06-02T18:30:00Z`) without pulling in a date/time dependency.
fn iso8601_utc_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // Days since the Unix epoch and seconds within the day.
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    // Civil-from-days algorithm (Howard Hinnant), valid for all Gregorian dates.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as i64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

const DEFAULT_MAX_VOLUMES: usize = 512;
const MAX_PYRAMID_LEVEL: u8 = 3;
const PYRAMID_CACHE_NAME: &str = "nifti-pyramid-v3";
const PREVIEW_DISK_CACHE_NAME: &str = "preview-cache-v2";

struct VolumeDiscovery {
    root: Option<PathBuf>,
    volumes: Vec<VolumeEntry>,
}

#[derive(Clone)]
struct NiftiHeader {
    shape: [u16; 3],
    spacing: [f32; 3],
    dtype: String,
    little_endian: bool,
    datatype_code: i16,
    bitpix: i16,
    vox_offset: usize,
    scl_slope: f32,
    scl_inter: f32,
}

fn max_volume_count() -> usize {
    std::env::var("NEUROVUE_MAX_VOLUMES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_VOLUMES)
}

fn discover_volumes() -> VolumeDiscovery {
    let max_volumes = max_volume_count();
    for root in discovery_roots() {
        let mut volumes = discover_volumes_in_root(&root, max_volumes);
        if !volumes.is_empty() {
            let root = if root.is_file() {
                root.parent().map(FsPath::to_path_buf)
            } else {
                Some(root)
            }
            .map(|path| fs::canonicalize(&path).unwrap_or(path));
            append_working_derivatives(&mut volumes, root.as_deref());
            return VolumeDiscovery { root, volumes };
        }
    }

    let mut volumes: Vec<VolumeEntry> = fallback_mni152_volume().into_iter().collect();
    let root = volumes
        .first()
        .and_then(|volume| volume.source_path.as_ref())
        .and_then(|path| path.parent())
        .map(FsPath::to_path_buf);
    append_working_derivatives(&mut volumes, root.as_deref());
    VolumeDiscovery { root, volumes }
}

fn append_working_derivatives(volumes: &mut Vec<VolumeEntry>, dataset_root: Option<&FsPath>) {
    let output_dir = working_derivatives_dir();
    let entries = match fs::read_dir(&output_dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    let mut paths = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_nifti_path(path))
        .collect::<Vec<_>>();

    paths.sort();
    for path in paths {
        if let Some(entry) = working_derivative_entry(&path, &output_dir, volumes, dataset_root) {
            volumes.push(entry);
        }
    }
}

fn working_derivative_entry(
    output_path: &FsPath,
    output_root: &FsPath,
    volumes: &[VolumeEntry],
    dataset_root: Option<&FsPath>,
) -> Option<VolumeEntry> {
    let sidecar_path = nifti_json_sidecar_path(output_path);
    let metadata = read_json_sidecar(&sidecar_path)?;
    if !metadata
        .get("NeuroVueGenerated")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    if metadata
        .get("DerivativeType")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind != "working")
    {
        return None;
    }

    let source_path = metadata
        .get("SourceImage")
        .and_then(Value::as_str)
        .and_then(|path| fs::canonicalize(path).ok())?;
    if !source_belongs_to_dataset(&source_path, dataset_root) {
        return None;
    }
    let output_path = fs::canonicalize(output_path).ok()?;
    if volumes.iter().any(|volume| {
        volume
            .source_path
            .as_deref()
            .is_some_and(|path| same_canonical_path(path, &output_path))
    }) {
        return None;
    }

    let header = read_nifti_header(&output_path)?;
    let output_parent = output_path.parent().unwrap_or(output_root);
    let output_id = volume_id(&output_path, output_root);
    let operation = metadata
        .get("NeuroVueOperation")
        .and_then(Value::as_str)
        .unwrap_or("operation")
        .to_string();
    let source_id = volumes
        .iter()
        .find(|volume| {
            volume
                .source_path
                .as_deref()
                .is_some_and(|path| same_canonical_path(path, &source_path))
        })
        .map(|volume| volume.id.clone());
    let source_label = source_id
        .as_deref()
        .and_then(|id| volumes.iter().find(|volume| volume.id == id))
        .map(|volume| volume.label.clone())
        .unwrap_or_else(|| "Restored derivative".to_string());
    let unique_id = unique_volume_id(volumes, &format!("derived__{output_id}"));
    let cache_signature = source_cache_signature(&unique_id, &output_path, &header);

    Some(VolumeEntry {
        id: unique_id,
        label: format!("{source_label} / {operation}"),
        role: VolumeRole::Derived,
        format: "nifti".to_string(),
        shape: header.shape,
        spacing: header.spacing,
        dtype: header.dtype,
        source_path: Some(output_path.clone()),
        cache_signature,
        sidecar_paths: find_json_sidecars(&output_path, output_parent),
        derived_from: source_id,
        derivation: Some(VolumeDerivation {
            operation,
            source_path: source_path.display().to_string(),
            output_path: output_path.display().to_string(),
        }),
    })
}

fn source_belongs_to_dataset(source_path: &FsPath, dataset_root: Option<&FsPath>) -> bool {
    dataset_root
        .map(|root| source_path.starts_with(root))
        .unwrap_or(true)
}

fn nifti_json_sidecar_path(path: &FsPath) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("volume.nii.gz");
    let stem = strip_nifti_file_suffix(file_name);
    path.with_file_name(format!("{stem}.json"))
}

fn strip_nifti_file_suffix(value: &str) -> &str {
    value
        .strip_suffix(".nii.gz")
        .or_else(|| value.strip_suffix(".nii"))
        .unwrap_or(value)
}

fn discovery_roots() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/Users/chrisdrake"));

    let mut roots = Vec::new();
    for key in ["NEUROVUE_BIDS_ROOT", "NEUROVUE_DATASET_ROOT"] {
        if let Some(value) = std::env::var_os(key) {
            roots.extend(std::env::split_paths(&value));
        }
    }

    // When launched under NeuroFlow, auto-discover the dataset named in the
    // session context (composes with the NEUROVUE_* env vars above, takes
    // priority over the hardcoded development fallbacks below).
    roots.extend(neuroflow_dataset_roots());

    roots.extend([
        home.join("Dev/NiivueRL/data/ds000030_t1w"),
        home.join("Dev/bids-examples/ds000117"),
        home.join("Dev/bids-examples/ds007"),
        home.join("Dev/mono/packages/dev-images/images/volumes/mni152.nii.gz"),
        home.join("Dev/mono/apps/medgfx/medgfx/mni152.nii.gz"),
        home.join(
            "Dev/niivue/niivue/packages/niivue-desktop/resources/images/standard/mni152.nii.gz",
        ),
        home.join("Dev/niivue/niivue/packages/niivue/demos/images/mni152.nii.gz"),
        home.join("Dev/niivue-demo-images/mni152.nii.gz"),
    ]);

    // Bundled default volume (set by lib.rs from the app's resource dir). Appended
    // last so a real dev dataset/volume above still wins on desktop; on iOS — where
    // the dev paths don't exist — this is the only one that resolves.
    if let Some(value) = std::env::var_os("NEUROVUE_DEFAULT_VOLUME") {
        roots.push(PathBuf::from(value));
    }

    roots
}

fn discover_volumes_in_root(root: &FsPath, max_volumes: usize) -> Vec<VolumeEntry> {
    if root.is_file() && is_nifti_path(root) {
        return volume_entry(root, root.parent().unwrap_or_else(|| FsPath::new("")))
            .into_iter()
            .collect();
    }

    if !root.is_dir() {
        return Vec::new();
    }

    let mut paths = Vec::new();
    collect_nifti_paths(root, &mut paths, max_volumes);
    paths.sort();

    paths
        .iter()
        .filter_map(|path| volume_entry(path, root))
        .take(max_volumes)
        .collect()
}

fn collect_nifti_paths(root: &FsPath, paths: &mut Vec<PathBuf>, max_volumes: usize) {
    if paths.len() >= max_volumes {
        return;
    }

    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        if paths.len() >= max_volumes {
            return;
        }

        let path = entry.path();
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with('.'))
        {
            continue;
        }

        if path.is_dir() {
            collect_nifti_paths(&path, paths, max_volumes);
        } else if is_nifti_path(&path) {
            paths.push(path);
        }
    }
}

fn volume_entry(path: &FsPath, root: &FsPath) -> Option<VolumeEntry> {
    let header = read_nifti_header(path)?;
    let id = volume_id(path, root);
    let cache_signature = source_cache_signature(&id, path, &header);
    let label = path
        .strip_prefix(root)
        .ok()
        .and_then(|relative| relative.to_str())
        .or_else(|| path.file_name().and_then(|name| name.to_str()))
        .unwrap_or(&id)
        .to_string();

    Some(VolumeEntry {
        id,
        label,
        role: VolumeRole::Source,
        format: "nifti".to_string(),
        shape: header.shape,
        spacing: header.spacing,
        dtype: header.dtype,
        source_path: Some(path.to_path_buf()),
        cache_signature,
        sidecar_paths: find_json_sidecars(path, root),
        derived_from: None,
        derivation: None,
    })
}

fn overlay_volume_label(path: &FsPath, root: &FsPath, fallback_id: &str) -> String {
    let label = path
        .strip_prefix(root)
        .ok()
        .and_then(|relative| relative.to_str())
        .or_else(|| path.file_name().and_then(|name| name.to_str()))
        .unwrap_or(fallback_id);
    format!("Overlay / {label}")
}

fn fallback_mni152_volume() -> Option<VolumeEntry> {
    let source_path = discovery_roots().into_iter().find(|path| path.is_file());
    let header = source_path
        .as_ref()
        .and_then(|path| read_nifti_header(path))
        .unwrap_or(NiftiHeader {
            shape: [197, 233, 189],
            spacing: [1.0, 1.0, 1.0],
            dtype: "uint8".to_string(),
            little_endian: true,
            datatype_code: 2,
            bitpix: 8,
            vox_offset: 352,
            scl_slope: 1.0,
            scl_inter: 0.0,
        });
    let cache_signature = source_path
        .as_deref()
        .and_then(|path| source_cache_signature("mni152", path, &header));

    Some(VolumeEntry {
        id: "mni152".to_string(),
        label: "MNI152 reference".to_string(),
        role: VolumeRole::Source,
        format: "nifti".to_string(),
        shape: header.shape,
        spacing: header.spacing,
        dtype: header.dtype,
        sidecar_paths: source_path
            .as_ref()
            .map(|path| find_json_sidecars(path, path.parent().unwrap_or_else(|| FsPath::new(""))))
            .unwrap_or_default(),
        source_path,
        cache_signature,
        derived_from: None,
        derivation: None,
    })
}

fn volume_levels(base_url: &str, encoded_id: &str, volume: &VolumeEntry) -> Vec<Value> {
    let max_level = max_pyramid_level(volume.shape);

    (0..=max_level)
        .map(|level| {
            let factor = pyramid_factor(level);
            let shape = downsampled_shape(volume.shape, factor);
            let spacing = [
                volume.spacing[0] * factor as f32,
                volume.spacing[1] * factor as f32,
                volume.spacing[2] * factor as f32,
            ];
            let raw = if level == 0 {
                raw_volume_url(base_url, encoded_id, volume)
            } else {
                format!("{base_url}/volumes/{encoded_id}/levels/{level}/raw.nii")
            };

            json!({
                "level": level,
                "factor": factor,
                "shape": shape,
                "spacing": spacing,
                "ready": true,
                "bytes": null,
                "raw": raw,
            })
        })
        .collect()
}

fn max_pyramid_level(shape: [u16; 3]) -> u8 {
    (0..=MAX_PYRAMID_LEVEL)
        .take_while(|level| {
            let factor = pyramid_factor(*level);
            shape
                .iter()
                .all(|dimension| usize::from(*dimension).div_ceil(factor) >= 8)
        })
        .last()
        .unwrap_or(0)
}

fn clamp_pyramid_level(level: u8, shape: [u16; 3]) -> u8 {
    level.min(max_pyramid_level(shape))
}

fn pyramid_factor(level: u8) -> usize {
    1_usize << usize::from(level)
}

fn downsampled_shape(shape: [u16; 3], factor: usize) -> [u16; 3] {
    [
        usize_to_u16(usize::from(shape[0]).div_ceil(factor)),
        usize_to_u16(usize::from(shape[1]).div_ceil(factor)),
        usize_to_u16(usize::from(shape[2]).div_ceil(factor)),
    ]
}

fn usize_to_u16(value: usize) -> u16 {
    value.min(usize::from(u16::MAX)) as u16
}

fn is_nifti_path(path: &FsPath) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".nii") || name.ends_with(".nii.gz"))
}

fn raw_volume_url(base_url: &str, encoded_id: &str, volume: &VolumeEntry) -> String {
    format!(
        "{}/volumes/{}/raw{}",
        base_url,
        encoded_id,
        raw_volume_suffix(volume.source_path.as_deref())
    )
}

fn raw_volume_suffix(path: Option<&FsPath>) -> &'static str {
    if path
        .and_then(|path| path.file_name())
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".nii"))
    {
        ".nii"
    } else {
        ".nii.gz"
    }
}

fn raw_volume_content_type(path: &FsPath) -> HeaderValue {
    if raw_volume_suffix(Some(path)) == ".nii.gz" {
        HeaderValue::from_static("application/x.nifti+gzip")
    } else {
        HeaderValue::from_static("application/x.nifti")
    }
}

fn volume_id(path: &FsPath, root: &FsPath) -> String {
    let relative = path.strip_prefix(root).unwrap_or(path);
    strip_nifti_extension(relative)
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "__")
}

fn unique_volume_id(volumes: &[VolumeEntry], base: &str) -> String {
    if !volumes.iter().any(|volume| volume.id == base) {
        return base.to_string();
    }

    for suffix in 2.. {
        let candidate = format!("{base}_{suffix}");
        if !volumes.iter().any(|volume| volume.id == candidate) {
            return candidate;
        }
    }

    base.to_string()
}

fn same_canonical_path(left: &FsPath, right: &FsPath) -> bool {
    fs::canonicalize(left)
        .map(|path| path == right)
        .unwrap_or_else(|_| left == right)
}

fn strip_nifti_extension(path: &FsPath) -> PathBuf {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return path.to_path_buf();
    };
    let stem = file_name
        .strip_suffix(".nii.gz")
        .or_else(|| file_name.strip_suffix(".nii"))
        .unwrap_or(file_name);
    path.with_file_name(stem)
}

fn find_json_sidecars(path: &FsPath, root: &FsPath) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();

    push_sidecar_candidate(&mut candidates, &mut seen, path.with_extension("json"));

    if let Some(file_name) = path.file_name().and_then(|name| name.to_str()) {
        push_sidecar_candidate(
            &mut candidates,
            &mut seen,
            path.with_file_name(format!("{file_name}.json")),
        );

        if let Some(stem) = file_name
            .strip_suffix(".nii.gz")
            .or_else(|| file_name.strip_suffix(".nii"))
        {
            push_sidecar_candidate(
                &mut candidates,
                &mut seen,
                path.with_file_name(format!("{stem}.json")),
            );

            let inherited = inherited_bids_sidecar_names(stem);
            for ancestor in sidecar_ancestors(path, root) {
                for name in &inherited {
                    push_sidecar_candidate(&mut candidates, &mut seen, ancestor.join(name));
                }
            }
        }
    }

    candidates
        .into_iter()
        .filter(|candidate| candidate.is_file())
        .collect()
}

fn push_sidecar_candidate(
    candidates: &mut Vec<PathBuf>,
    seen: &mut HashSet<PathBuf>,
    candidate: PathBuf,
) {
    if seen.insert(candidate.clone()) {
        candidates.push(candidate);
    }
}

fn sidecar_ancestors(path: &FsPath, root: &FsPath) -> Vec<PathBuf> {
    let mut ancestors = Vec::new();
    let mut current = path.parent();

    while let Some(dir) = current {
        ancestors.push(dir.to_path_buf());
        if dir == root {
            break;
        }
        current = dir.parent();
    }

    ancestors
}

fn inherited_bids_sidecar_names(stem: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut seen = HashSet::new();
    let parts = stem.split('_').collect::<Vec<_>>();
    let Some(suffix) = parts.last().copied() else {
        return names;
    };
    let entity_parts = &parts[..parts.len().saturating_sub(1)];
    let preferred_keys = [
        "task", "acq", "ce", "rec", "dir", "echo", "part", "space", "res", "desc",
    ];

    for key in preferred_keys {
        let selected = entity_parts
            .iter()
            .copied()
            .filter(|part| part.starts_with(&format!("{key}-")))
            .collect::<Vec<_>>();
        if !selected.is_empty() {
            push_sidecar_name(
                &mut names,
                &mut seen,
                &format!("{}_{}.json", selected.join("_"), suffix),
            );
        }
    }

    let non_identity = entity_parts
        .iter()
        .copied()
        .filter(|part| !part.starts_with("sub-") && !part.starts_with("ses-"))
        .collect::<Vec<_>>();
    if !non_identity.is_empty() {
        push_sidecar_name(
            &mut names,
            &mut seen,
            &format!("{}_{}.json", non_identity.join("_"), suffix),
        );
    }
    push_sidecar_name(&mut names, &mut seen, &format!("{suffix}.json"));

    names
}

fn push_sidecar_name(names: &mut Vec<String>, seen: &mut HashSet<String>, name: &str) {
    if seen.insert(name.to_string()) {
        names.push(name.to_string());
    }
}

fn read_nifti_header(path: &FsPath) -> Option<NiftiHeader> {
    let mut header = [0_u8; 348];
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".gz"))
    {
        let file = File::open(path).ok()?;
        let mut decoder = GzDecoder::new(file);
        decoder.read_exact(&mut header).ok()?;
    } else {
        let mut file = File::open(path).ok()?;
        file.read_exact(&mut header).ok()?;
    }

    parse_nifti_header(&header)
}

/// Voxel-count ceiling for a source volume before it is fully decompressed into
/// memory. A pathologically large file would otherwise OOM the server (the read
/// alone, plus the f32 working buffers in pyramid/render). Generous enough for
/// real brain data (~800^3); overridable via NEUROVUE_MAX_SOURCE_VOXELS.
const DEFAULT_MAX_SOURCE_VOXELS: usize = 512 * 1024 * 1024;

fn max_source_voxels() -> usize {
    std::env::var("NEUROVUE_MAX_SOURCE_VOXELS")
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .filter(|&voxels| voxels > 0)
        .unwrap_or(DEFAULT_MAX_SOURCE_VOXELS)
}

fn is_gzipped_nifti(path: &FsPath) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".gz"))
}

/// Read just the 348-byte header without decompressing the whole volume.
fn peek_nifti_header(path: &FsPath) -> Option<NiftiHeader> {
    let mut header_bytes = [0u8; 348];
    if is_gzipped_nifti(path) {
        GzDecoder::new(File::open(path).ok()?)
            .read_exact(&mut header_bytes)
            .ok()?;
    } else {
        File::open(path).ok()?.read_exact(&mut header_bytes).ok()?;
    }
    parse_nifti_header(&header_bytes)
}

fn read_nifti_file(path: &FsPath) -> Option<(NiftiHeader, Vec<u8>)> {
    // Peek the header and enforce the voxel ceiling before the (potentially
    // huge) full read, so an oversized volume bails instead of OOMing.
    let header = peek_nifti_header(path)?;
    let voxels = usize::from(header.shape[0])
        .checked_mul(usize::from(header.shape[1]))?
        .checked_mul(usize::from(header.shape[2]))?;
    if voxels > max_source_voxels() {
        return None;
    }

    let bytes = if is_gzipped_nifti(path) {
        let mut bytes = Vec::new();
        GzDecoder::new(File::open(path).ok()?)
            .read_to_end(&mut bytes)
            .ok()?;
        bytes
    } else {
        fs::read(path).ok()?
    };

    if bytes.len() < 348 {
        return None;
    }
    Some((header, bytes))
}

fn parse_nifti_header(header: &[u8; 348]) -> Option<NiftiHeader> {
    let sizeof_hdr_le = i32::from_le_bytes(header[0..4].try_into().ok()?);
    let sizeof_hdr_be = i32::from_be_bytes(header[0..4].try_into().ok()?);
    let little_endian = if sizeof_hdr_le == 348 {
        true
    } else if sizeof_hdr_be == 348 {
        false
    } else {
        return None;
    };

    let read_i16 = |offset: usize| -> Option<i16> {
        let bytes: [u8; 2] = header.get(offset..offset + 2)?.try_into().ok()?;
        Some(if little_endian {
            i16::from_le_bytes(bytes)
        } else {
            i16::from_be_bytes(bytes)
        })
    };
    let read_f32 = |offset: usize| -> Option<f32> {
        let bytes: [u8; 4] = header.get(offset..offset + 4)?.try_into().ok()?;
        Some(if little_endian {
            f32::from_le_bytes(bytes)
        } else {
            f32::from_be_bytes(bytes)
        })
    };

    let dim_count = read_i16(40).unwrap_or(3).max(3) as usize;
    let shape = [
        read_i16(42).unwrap_or(1).max(1) as u16,
        read_i16(44).unwrap_or(1).max(1) as u16,
        if dim_count >= 3 {
            read_i16(46).unwrap_or(1).max(1) as u16
        } else {
            1
        },
    ];
    let spacing = [
        positive_or_one(read_f32(80).unwrap_or(1.0)),
        positive_or_one(read_f32(84).unwrap_or(1.0)),
        positive_or_one(read_f32(88).unwrap_or(1.0)),
    ];
    let datatype_code = read_i16(70).unwrap_or(0);
    let bitpix = read_i16(72).unwrap_or(0);
    let vox_offset = read_f32(108).unwrap_or(352.0).max(0.0).round() as usize;
    let scl_slope = read_f32(112).unwrap_or(1.0);
    let scl_inter = read_f32(116).unwrap_or(0.0);
    let dtype = nifti_datatype_name(datatype_code).to_string();

    Some(NiftiHeader {
        shape,
        spacing,
        dtype,
        little_endian,
        datatype_code,
        bitpix,
        vox_offset,
        scl_slope,
        scl_inter,
    })
}

fn positive_or_one(value: f32) -> f32 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        1.0
    }
}

fn nifti_datatype_name(datatype: i16) -> &'static str {
    match datatype {
        2 => "uint8",
        4 => "int16",
        8 => "int32",
        16 => "float32",
        64 => "float64",
        256 => "int8",
        512 => "uint16",
        768 => "uint32",
        1024 => "int64",
        1280 => "uint64",
        _ => "unknown",
    }
}

fn read_json_sidecar(path: &FsPath) -> Option<Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|body| serde_json::from_str(&body).ok())
}

fn find_volume(state: &AppState, vol_id: &str) -> Option<VolumeEntry> {
    lock_recover(&state.volumes)
        .iter()
        .find(|volume| volume.id == vol_id)
        .cloned()
}

/// The currently-open dataset root. Every volume in the store belongs to it, so
/// it scopes the per-dataset image cache directory.
fn current_dataset_root(state: &AppState) -> Option<PathBuf> {
    lock_recover(&state.dataset_root).clone()
}

fn preview_level_for_size(size: &str) -> u8 {
    let max_dimension = requested_size_bound(size).unwrap_or(96);
    match max_dimension {
        0..=96 => 2,
        97..=192 => 2,
        193..=384 => 1,
        _ => 0,
    }
}

fn requested_size_bound(size: &str) -> Option<usize> {
    if size == "full" || size == "max" {
        return None;
    }

    let size = size.strip_prefix('!').unwrap_or(size);
    let (width, height) = size.split_once(',').unwrap_or((size, ""));
    [width.parse::<usize>().ok(), height.parse::<usize>().ok()]
        .into_iter()
        .flatten()
        .max()
}

/// Resolve (creating on first use) the per-volume build lock for a source
/// signature, so same-volume builds serialize while different volumes run free.
fn pyramid_lock_for(locks: &PyramidLocks, signature: &str) -> Arc<Mutex<()>> {
    let mut map = lock_recover(locks);
    map.entry(signature.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn ensure_downsampled_nifti(
    volume: &VolumeEntry,
    level: u8,
    locks: &PyramidLocks,
    dataset_root: Option<&FsPath>,
) -> Option<PathBuf> {
    let cache_path = downsampled_nifti_cache_path(volume, level, dataset_root)?;
    if cache_path.is_file() {
        return Some(cache_path);
    }

    // One decode builds every missing level up to the max, so later coarse/fine
    // requests for this volume become warm cache hits.
    let targets: Vec<u8> = (1..=max_pyramid_level(volume.shape)).collect();
    build_pyramid_levels(volume, &targets, locks, dataset_root)?;

    cache_path.is_file().then_some(cache_path)
}

/// Decode the source NIfTI once and write any of `targets` not already cached.
/// Serialized per-volume via the signature lock; safe to call from request
/// handlers and the background warmer alike.
fn build_pyramid_levels(
    volume: &VolumeEntry,
    targets: &[u8],
    locks: &PyramidLocks,
    dataset_root: Option<&FsPath>,
) -> Option<()> {
    let signature = source_signature(volume)?;
    let lock = pyramid_lock_for(locks, &signature);
    let _guard = lock_recover(&lock);

    // Recompute pending under the lock so concurrent builders don't duplicate work.
    let pending: Vec<u8> = targets
        .iter()
        .copied()
        .filter(|&level| level >= 1)
        .filter(|&level| {
            downsampled_nifti_cache_path(volume, level, dataset_root)
                .map(|path| !path.is_file())
                .unwrap_or(false)
        })
        .collect();
    if pending.is_empty() {
        return Some(());
    }

    let source_path = volume.source_path.as_ref()?;
    let (header, bytes) = read_nifti_file(source_path)?;
    let source_header: [u8; 348] = bytes.get(..348)?.try_into().ok()?;
    let data = bytes.get(header.vox_offset..)?;
    let dim_x = usize::from(header.shape[0]);
    let dim_y = usize::from(header.shape[1]);
    let dim_z = usize::from(header.shape[2]);

    for level in pending {
        let cache_path = downsampled_nifti_cache_path(volume, level, dataset_root)?;
        let parent = cache_path.parent()?;
        fs::create_dir_all(parent).ok()?;
        let factor = pyramid_factor(level);
        let shape = downsampled_shape(header.shape, factor);
        let spacing = [
            header.spacing[0] * factor as f32,
            header.spacing[1] * factor as f32,
            header.spacing[2] * factor as f32,
        ];
        let output_x = usize::from(shape[0]);
        let output_y = usize::from(shape[1]);
        let output_z = usize::from(shape[2]);
        let mut voxels = Vec::with_capacity(output_x.checked_mul(output_y)?.checked_mul(output_z)?);

        for z in 0..output_z {
            let source_z = (z * factor).min(dim_z.saturating_sub(1));
            for y in 0..output_y {
                let source_y = (y * factor).min(dim_y.saturating_sub(1));
                for x in 0..output_x {
                    let source_x = (x * factor).min(dim_x.saturating_sub(1));
                    voxels.push(
                        average_nifti_block(
                            data, &header, source_x, source_y, source_z, factor, dim_x, dim_y,
                            dim_z,
                        )
                        .unwrap_or(0.0),
                    );
                }
            }
        }

        let temp_path = cache_path.with_extension(format!("nii.tmp.{}", std::process::id()));
        write_nifti_f32(&temp_path, &source_header, shape, spacing, &voxels)?;
        fs::rename(&temp_path, &cache_path)
            .or_else(|_| {
                fs::copy(&temp_path, &cache_path)?;
                fs::remove_file(&temp_path)
            })
            .ok()?;
    }

    Some(())
}

/// Background-build missing pyramid levels for each source volume. Cancels as
/// soon as a newer dataset opens (generation changed) and reports volume-level
/// progress while a bounded worker pool warms different volumes in parallel.
fn spawn_pyramid_warm(
    volumes: Vec<VolumeEntry>,
    dataset_root: Option<PathBuf>,
    locks: PyramidLocks,
    generation: Arc<AtomicU64>,
    progress: Arc<Mutex<WarmProgress>>,
    my_gen: u64,
) {
    let mut completed = 0;
    let queue = volumes
        .into_iter()
        .filter(|volume| volume.source_path.is_some())
        .filter_map(|volume| {
            if warm_pyramid_targets(&volume, dataset_root.as_deref()).is_empty() {
                completed += 1;
                None
            } else {
                Some(volume)
            }
        })
        .collect::<Vec<_>>();
    let total = completed + queue.len();
    {
        let mut next = lock_recover(&progress);
        next.generation = my_gen;
        next.active = !queue.is_empty();
        next.completed = completed;
        next.total = total;
    }
    if queue.is_empty() {
        return;
    }

    let queue = Arc::new(Mutex::new(VecDeque::from(queue)));
    let dataset_root = Arc::new(dataset_root);
    let worker_count = warm_worker_count().min(total).max(1);

    for _ in 0..worker_count {
        let queue = queue.clone();
        let dataset_root = dataset_root.clone();
        let locks = locks.clone();
        let generation = generation.clone();
        let progress = progress.clone();
        std::thread::spawn(move || loop {
            if generation.load(Ordering::SeqCst) != my_gen {
                return;
            }

            let Some(volume) = lock_recover(&queue).pop_front() else {
                return;
            };
            let root = dataset_root.as_ref().as_deref();
            let targets = warm_pyramid_targets(&volume, root);
            if !targets.is_empty() {
                let _ = build_pyramid_levels(&volume, &targets, &locks, root);
            }
            mark_warm_volume_finished(&progress, &generation, my_gen);
        });
    }
}

fn warm_worker_count() -> usize {
    std::thread::available_parallelism()
        .map(|threads| (threads.get() / 2).clamp(1, 4))
        .unwrap_or(1)
}

fn warm_pyramid_targets(volume: &VolumeEntry, dataset_root: Option<&FsPath>) -> Vec<u8> {
    (1..=max_pyramid_level(volume.shape))
        .filter(|&level| {
            downsampled_nifti_cache_path(volume, level, dataset_root)
                .map(|path| !path.is_file())
                .unwrap_or(false)
        })
        .collect()
}

fn mark_warm_volume_finished(
    progress: &Arc<Mutex<WarmProgress>>,
    generation: &AtomicU64,
    my_gen: u64,
) {
    if generation.load(Ordering::SeqCst) != my_gen {
        return;
    }
    let mut progress = lock_recover(progress);
    if progress.generation != my_gen {
        return;
    }
    progress.completed = progress.completed.saturating_add(1).min(progress.total);
    if progress.completed >= progress.total {
        progress.active = false;
    }
}

fn downsampled_nifti_cache_path(
    volume: &VolumeEntry,
    level: u8,
    dataset_root: Option<&FsPath>,
) -> Option<PathBuf> {
    let signature = source_signature(volume)?;
    Some(
        dataset_cache_dir(dataset_root)
            .join(PYRAMID_CACHE_NAME)
            .join(signature)
            .join(format!("level-{level}.nii")),
    )
}

/// Cache root scoped to a dataset: `<cache_root>/datasets/<root-segment>`. This
/// keeps each dataset's image caches grouped together (so they can be located or
/// cleared as a unit) while still living outside the dataset and out of git.
fn dataset_cache_dir(dataset_root: Option<&FsPath>) -> PathBuf {
    cache_root()
        .join("datasets")
        .join(dataset_segment(dataset_root))
}

/// Total on-disk cache budget across all dataset segments. Past this, the
/// oldest dataset caches are pruned. Overridable via NEUROVUE_CACHE_BUDGET_BYTES.
const DEFAULT_CACHE_BUDGET_BYTES: u64 = 4 * 1024 * 1024 * 1024;

fn cache_budget_bytes() -> u64 {
    std::env::var("NEUROVUE_CACHE_BUDGET_BYTES")
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|&bytes| bytes > 0)
        .unwrap_or(DEFAULT_CACHE_BUDGET_BYTES)
}

fn dir_size_bytes(path: &FsPath) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        total += if meta.is_dir() {
            dir_size_bytes(&entry.path())
        } else {
            meta.len()
        };
    }
    total
}

/// Best-effort prune of cached dataset directories once the total exceeds the
/// budget, removing oldest-modified first. The active dataset (`keep_segment`)
/// is never removed.
fn sweep_dataset_cache(keep_segment: &str) {
    let datasets_dir = cache_root().join("datasets");
    let Ok(entries) = fs::read_dir(&datasets_dir) else {
        return;
    };

    let mut segments: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    let mut total: u64 = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let size = dir_size_bytes(&path);
        let modified = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(UNIX_EPOCH);
        total += size;
        segments.push((path, size, modified));
    }

    let budget = cache_budget_bytes();
    if total <= budget {
        return;
    }

    segments.sort_by_key(|(_, _, modified)| *modified); // oldest first
    for (path, size, _) in segments {
        if total <= budget {
            break;
        }
        if path.file_name().and_then(|name| name.to_str()) == Some(keep_segment) {
            continue;
        }
        if fs::remove_dir_all(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

fn dataset_segment(dataset_root: Option<&FsPath>) -> String {
    match dataset_root {
        Some(root) => {
            let name = root
                .file_name()
                .and_then(|name| name.to_str())
                .map(sanitize_cache_component)
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| "dataset".to_string());
            format!("{}-{:016x}", name, stable_path_hash(root))
        }
        None => "default".to_string(),
    }
}

fn source_cache_signature(id: &str, source_path: &FsPath, header: &NiftiHeader) -> Option<String> {
    let metadata = fs::metadata(source_path).ok()?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let content_hash = file_content_hash(source_path)?;
    Some(format!(
        "{}-{}-{}-{:016x}-{}-{:016x}",
        sanitize_cache_component(id),
        metadata.len(),
        modified,
        content_hash,
        nifti_header_signature(header),
        stable_path_hash(source_path)
    ))
}

fn file_content_hash(path: &FsPath) -> Option<u64> {
    const FNV_OFFSET_BASIS: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;

    let mut file = File::open(path).ok()?;
    let mut hash = FNV_OFFSET_BASIS;
    let mut buffer = [0_u8; 64 * 1024];

    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        for byte in &buffer[..read] {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(FNV_PRIME);
        }
    }

    Some(hash)
}

fn nifti_header_signature(header: &NiftiHeader) -> String {
    format!(
        "{}x{}x{}-{:08x}-{:08x}-{:08x}-{}-{}-{}-{}-{:08x}-{:08x}",
        header.shape[0],
        header.shape[1],
        header.shape[2],
        header.spacing[0].to_bits(),
        header.spacing[1].to_bits(),
        header.spacing[2].to_bits(),
        if header.little_endian { "le" } else { "be" },
        header.datatype_code,
        header.bitpix,
        header.vox_offset,
        header.scl_slope.to_bits(),
        header.scl_inter.to_bits()
    )
}

fn source_signature(volume: &VolumeEntry) -> Option<String> {
    if let Some(signature) = &volume.cache_signature {
        return Some(signature.clone());
    }

    let source_path = volume.source_path.as_ref()?;
    let metadata = fs::metadata(source_path).ok()?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    Some(format!(
        "{}-{}-{}-{:016x}-{}x{}x{}-{}-{:016x}",
        sanitize_cache_component(&volume.id),
        metadata.len(),
        modified,
        file_content_hash(source_path)?,
        volume.shape[0],
        volume.shape[1],
        volume.shape[2],
        sanitize_cache_component(&volume.dtype),
        stable_path_hash(source_path)
    ))
}

#[allow(clippy::too_many_arguments)]
fn disk_preview_cache_path(
    volume: &VolumeEntry,
    axis: &str,
    slice: u16,
    region: &str,
    size: &str,
    rotation: &str,
    quality_format: &str,
    level: Option<u8>,
    version: &str,
    dataset_root: Option<&FsPath>,
) -> Option<PathBuf> {
    let signature = source_signature(volume)?;
    let level_part = level
        .map(|value| value.to_string())
        .unwrap_or_else(|| "auto".to_string());
    let version_part = if version.is_empty() {
        "v".to_string()
    } else {
        sanitize_cache_component(version)
    };
    let file_name = format!(
        "{}-{}-{}-{}-{}-{}-{}-{}.bmp",
        level_part,
        sanitize_cache_component(axis),
        slice,
        sanitize_cache_component(size),
        sanitize_cache_component(region),
        sanitize_cache_component(rotation),
        sanitize_cache_component(quality_format),
        version_part,
    );
    Some(
        dataset_cache_dir(dataset_root)
            .join(PREVIEW_DISK_CACHE_NAME)
            .join(signature)
            .join(file_name),
    )
}

fn write_preview_to_disk(path: &FsPath, bytes: &[u8]) {
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let temp_path = path.with_extension(format!("bmp.tmp.{}", std::process::id()));
    if fs::write(&temp_path, bytes).is_err() {
        return;
    }
    if fs::rename(&temp_path, path).is_err() {
        let _ = fs::remove_file(&temp_path);
    }
}

fn stable_path_hash(path: &FsPath) -> u64 {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    hasher.finish()
}

fn sanitize_cache_component(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn write_nifti_f32(
    path: &FsPath,
    source_header: &[u8; 348],
    shape: [u16; 3],
    spacing: [f32; 3],
    voxels: &[f32],
) -> Option<()> {
    let expected_len = usize::from(shape[0])
        .checked_mul(usize::from(shape[1]))?
        .checked_mul(usize::from(shape[2]))?;
    if voxels.len() != expected_len {
        return None;
    }

    let mut header = *source_header;
    write_i32_header(&mut header, 0, 348);
    write_i16_header(&mut header, 40, 3);
    write_i16_header(&mut header, 42, shape[0] as i16);
    write_i16_header(&mut header, 44, shape[1] as i16);
    write_i16_header(&mut header, 46, shape[2] as i16);
    write_i16_header(&mut header, 48, 1);
    write_i16_header(&mut header, 50, 1);
    write_i16_header(&mut header, 52, 1);
    write_i16_header(&mut header, 54, 1);
    write_i16_header(&mut header, 70, 16);
    write_i16_header(&mut header, 72, 32);
    if f32::from_le_bytes(header[76..80].try_into().ok()?) == 0.0 {
        write_f32_header(&mut header, 76, 1.0);
    }
    write_f32_header(&mut header, 80, spacing[0]);
    write_f32_header(&mut header, 84, spacing[1]);
    write_f32_header(&mut header, 88, spacing[2]);
    write_f32_header(&mut header, 108, 352.0);
    write_f32_header(&mut header, 112, 1.0);
    write_f32_header(&mut header, 116, 0.0);
    header[344..348].copy_from_slice(b"n+1\0");

    let mut bytes = Vec::with_capacity(352 + voxels.len() * 4);
    bytes.extend_from_slice(&header);
    bytes.extend_from_slice(&[0, 0, 0, 0]);
    for voxel in voxels {
        bytes.extend_from_slice(&voxel.to_le_bytes());
    }

    fs::write(path, bytes).ok()
}

fn write_i16_header(header: &mut [u8; 348], offset: usize, value: i16) {
    header[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn write_i32_header(header: &mut [u8; 348], offset: usize, value: i32) {
    header[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn write_f32_header(header: &mut [u8; 348], offset: usize, value: f32) {
    header[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn parse_image_region(region: &str, image_width: usize, image_height: usize) -> Option<ImageRegion> {
    if image_width == 0 || image_height == 0 {
        return None;
    }
    if region == "full" {
        return Some(ImageRegion {
            x: 0,
            y: 0,
            width: image_width,
            height: image_height,
        });
    }

    let mut parts = region.split(',');
    let x = parts.next()?.parse::<usize>().ok()?;
    let y = parts.next()?.parse::<usize>().ok()?;
    let width = parts.next()?.parse::<usize>().ok()?;
    let height = parts.next()?.parse::<usize>().ok()?;
    if parts.next().is_some() || width == 0 || height == 0 {
        return None;
    }

    let end_x = x.checked_add(width)?;
    let end_y = y.checked_add(height)?;
    if x >= image_width || y >= image_height || end_x > image_width || end_y > image_height {
        return None;
    }

    Some(ImageRegion {
        x,
        y,
        width,
        height,
    })
}

fn level_image_region(
    region: ImageRegion,
    factor: usize,
    level_width: usize,
    level_height: usize,
) -> Option<ImageRegion> {
    let factor = factor.max(1);
    let x = region.x / factor;
    let y = region.y / factor;
    let end_x = region
        .x
        .checked_add(region.width)?
        .div_ceil(factor)
        .min(level_width);
    let end_y = region
        .y
        .checked_add(region.height)?
        .div_ceil(factor)
        .min(level_height);
    let width = end_x.checked_sub(x)?;
    let height = end_y.checked_sub(y)?;
    if width == 0 || height == 0 || x >= level_width || y >= level_height {
        return None;
    }

    Some(ImageRegion {
        x,
        y,
        width,
        height,
    })
}

fn render_slice_bmp(
    volume: &VolumeEntry,
    axis: &str,
    slice: u16,
    region: ImageRegion,
    size: &str,
    requested_level: Option<u8>,
    pyramid_locks: &PyramidLocks,
    decoded_level_cache: &Arc<Mutex<DecodedLevelCache>>,
    dataset_root: Option<&FsPath>,
) -> Option<Vec<u8>> {
    let level = clamp_pyramid_level(
        requested_level.unwrap_or_else(|| preview_level_for_size(size)),
        volume.shape,
    );
    let factor = pyramid_factor(level);
    let path = if level == 0 {
        volume.source_path.clone()?
    } else {
        ensure_downsampled_nifti(volume, level, pyramid_locks, dataset_root)?
    };
    let decoded = read_render_level(volume, level, &path, decoded_level_cache)?;
    let header = &decoded.header;
    let data = decoded.data.as_slice();
    let dim_x = usize::from(header.shape[0]);
    let dim_y = usize::from(header.shape[1]);
    let dim_z = usize::from(header.shape[2]);
    let bytes_per_voxel = usize::try_from(header.bitpix.max(0)).ok()?.checked_div(8)?;
    if bytes_per_voxel == 0 {
        return None;
    }

    let (native_width, native_height) = match axis {
        "axial" => (dim_x, dim_y),
        "coronal" => (dim_x, dim_z),
        "sagittal" => (dim_y, dim_z),
        _ => return None,
    };
    let region = level_image_region(region, factor, native_width, native_height)?;
    let slice_index = usize::from(slice).checked_div(factor)?;
    let voxel_count = dim_x.checked_mul(dim_y)?.checked_mul(dim_z)?;
    let required_bytes = voxel_count.checked_mul(bytes_per_voxel)?;
    if data.len() < required_bytes {
        return None;
    }

    let mut values = Vec::with_capacity(region.width.checked_mul(region.height)?);
    for row in 0..region.height {
        let image_row = region.y.checked_add(row)?;
        for col in 0..region.width {
            let image_col = region.x.checked_add(col)?;
            let voxel_index = match axis {
                "axial" => {
                    let x = image_col;
                    let y = native_height - 1 - image_row;
                    let z = slice_index.min(dim_z.saturating_sub(1));
                    voxel_linear_index(x, y, z, dim_x, dim_y)?
                }
                "coronal" => {
                    let x = image_col;
                    let y = slice_index.min(dim_y.saturating_sub(1));
                    let z = native_height - 1 - image_row;
                    voxel_linear_index(x, y, z, dim_x, dim_y)?
                }
                "sagittal" => {
                    let x = slice_index.min(dim_x.saturating_sub(1));
                    let y = image_col;
                    let z = native_height - 1 - image_row;
                    voxel_linear_index(x, y, z, dim_x, dim_y)?
                }
                _ => return None,
            };
            values.push(sample_nifti_value(data, header, voxel_index)?);
        }
    }

    let gray = scale_slice_to_gray(&values);
    let (output_width, output_height) = requested_image_size(size, region.width, region.height);
    let resized = if should_letterbox_preview(size) {
        resize_gray_letterboxed(
            &gray,
            region.width,
            region.height,
            output_width,
            output_height,
        )
    } else {
        resize_gray_nearest(
            &gray,
            region.width,
            region.height,
            output_width,
            output_height,
        )
    }?;
    Some(gray_bmp(output_width, output_height, &resized))
}

fn read_render_level(
    volume: &VolumeEntry,
    level: u8,
    path: &FsPath,
    decoded_level_cache: &Arc<Mutex<DecodedLevelCache>>,
) -> Option<Arc<DecodedNifti>> {
    if level == 0 {
        return decode_nifti_voxels(path);
    }

    let cache_key = format!("{}:level-{level}", source_signature(volume)?);

    if let Some(decoded) = lock_recover(decoded_level_cache).get(&cache_key) {
        return Some(decoded);
    }

    let decoded = decode_nifti_voxels(path)?;
    lock_recover(decoded_level_cache).insert(cache_key, decoded.clone());
    Some(decoded)
}

fn decode_nifti_voxels(path: &FsPath) -> Option<Arc<DecodedNifti>> {
    let (header, bytes) = read_nifti_file(path)?;
    let data = bytes.get(header.vox_offset..)?.to_vec();
    Some(Arc::new(DecodedNifti { header, data }))
}

fn voxel_linear_index(x: usize, y: usize, z: usize, dim_x: usize, dim_y: usize) -> Option<usize> {
    z.checked_mul(dim_y)?
        .checked_add(y)?
        .checked_mul(dim_x)?
        .checked_add(x)
}

fn sample_nifti_value(data: &[u8], header: &NiftiHeader, voxel_index: usize) -> Option<f32> {
    let bytes_per_voxel = usize::try_from(header.bitpix.max(0)).ok()?.checked_div(8)?;
    let offset = voxel_index.checked_mul(bytes_per_voxel)?;
    let bytes = data.get(offset..offset + bytes_per_voxel)?;
    let little = header.little_endian;

    let raw = match header.datatype_code {
        2 => f32::from(*bytes.first()?),
        4 => f32::from(read_i16_value(bytes, little)?),
        8 => read_i32_value(bytes, little)? as f32,
        16 => read_f32_value(bytes, little)?,
        64 => read_f64_value(bytes, little)? as f32,
        256 => f32::from(i8::from_ne_bytes([*bytes.first()?])),
        512 => f32::from(read_u16_value(bytes, little)?),
        768 => read_u32_value(bytes, little)? as f32,
        1024 => read_i64_value(bytes, little)? as f32,
        1280 => read_u64_value(bytes, little)? as f32,
        _ => return None,
    };

    let slope = if header.scl_slope.is_finite() && header.scl_slope != 0.0 {
        header.scl_slope
    } else {
        1.0
    };
    Some(raw.mul_add(slope, header.scl_inter))
}

#[allow(clippy::too_many_arguments)]
fn average_nifti_block(
    data: &[u8],
    header: &NiftiHeader,
    start_x: usize,
    start_y: usize,
    start_z: usize,
    factor: usize,
    dim_x: usize,
    dim_y: usize,
    dim_z: usize,
) -> Option<f32> {
    let end_x = start_x.saturating_add(factor).min(dim_x);
    let end_y = start_y.saturating_add(factor).min(dim_y);
    let end_z = start_z.saturating_add(factor).min(dim_z);
    let mut sum = 0.0_f64;
    let mut count = 0_u32;

    for z in start_z..end_z {
        for y in start_y..end_y {
            for x in start_x..end_x {
                let voxel_index = voxel_linear_index(x, y, z, dim_x, dim_y)?;
                let value = sample_nifti_value(data, header, voxel_index)?;
                if value.is_finite() {
                    sum += f64::from(value);
                    count += 1;
                }
            }
        }
    }

    if count == 0 {
        Some(0.0)
    } else {
        Some((sum / f64::from(count)) as f32)
    }
}

fn read_i16_value(bytes: &[u8], little: bool) -> Option<i16> {
    let bytes: [u8; 2] = bytes.get(..2)?.try_into().ok()?;
    Some(if little {
        i16::from_le_bytes(bytes)
    } else {
        i16::from_be_bytes(bytes)
    })
}

fn read_u16_value(bytes: &[u8], little: bool) -> Option<u16> {
    let bytes: [u8; 2] = bytes.get(..2)?.try_into().ok()?;
    Some(if little {
        u16::from_le_bytes(bytes)
    } else {
        u16::from_be_bytes(bytes)
    })
}

fn read_i32_value(bytes: &[u8], little: bool) -> Option<i32> {
    let bytes: [u8; 4] = bytes.get(..4)?.try_into().ok()?;
    Some(if little {
        i32::from_le_bytes(bytes)
    } else {
        i32::from_be_bytes(bytes)
    })
}

fn read_u32_value(bytes: &[u8], little: bool) -> Option<u32> {
    let bytes: [u8; 4] = bytes.get(..4)?.try_into().ok()?;
    Some(if little {
        u32::from_le_bytes(bytes)
    } else {
        u32::from_be_bytes(bytes)
    })
}

fn read_i64_value(bytes: &[u8], little: bool) -> Option<i64> {
    let bytes: [u8; 8] = bytes.get(..8)?.try_into().ok()?;
    Some(if little {
        i64::from_le_bytes(bytes)
    } else {
        i64::from_be_bytes(bytes)
    })
}

fn read_u64_value(bytes: &[u8], little: bool) -> Option<u64> {
    let bytes: [u8; 8] = bytes.get(..8)?.try_into().ok()?;
    Some(if little {
        u64::from_le_bytes(bytes)
    } else {
        u64::from_be_bytes(bytes)
    })
}

fn read_f32_value(bytes: &[u8], little: bool) -> Option<f32> {
    let bytes: [u8; 4] = bytes.get(..4)?.try_into().ok()?;
    Some(if little {
        f32::from_le_bytes(bytes)
    } else {
        f32::from_be_bytes(bytes)
    })
}

fn read_f64_value(bytes: &[u8], little: bool) -> Option<f64> {
    let bytes: [u8; 8] = bytes.get(..8)?.try_into().ok()?;
    Some(if little {
        f64::from_le_bytes(bytes)
    } else {
        f64::from_be_bytes(bytes)
    })
}

fn scale_slice_to_gray(values: &[f32]) -> Vec<u8> {
    let mut finite = values
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    if finite.is_empty() {
        return vec![0; values.len()];
    }

    finite.sort_by(|left, right| left.total_cmp(right));
    let mut low = percentile(&finite, 0.01);
    let mut high = percentile(&finite, 0.995);
    if high <= low {
        low = *finite.first().unwrap_or(&0.0);
        high = *finite.last().unwrap_or(&1.0);
    }
    let range = (high - low).max(f32::EPSILON);

    values
        .iter()
        .map(|value| {
            if !value.is_finite() {
                return 0;
            }
            (((value - low) / range) * 255.0).clamp(0.0, 255.0) as u8
        })
        .collect()
}

fn percentile(sorted: &[f32], quantile: f32) -> f32 {
    if sorted.is_empty() {
        return 0.0;
    }
    let index = ((sorted.len() - 1) as f32 * quantile.clamp(0.0, 1.0)).round() as usize;
    sorted[index]
}

fn should_letterbox_preview(size: &str) -> bool {
    !size.starts_with('!') && requested_size_bound(size).is_some()
}

fn requested_image_size(size: &str, native_width: usize, native_height: usize) -> (usize, usize) {
    const MAX_PREVIEW_DIMENSION: usize = 1024;
    let native_width = native_width.max(1);
    let native_height = native_height.max(1);
    let aspect = native_height as f64 / native_width as f64;
    let clamp_dim = |value: usize| value.clamp(1, MAX_PREVIEW_DIMENSION);

    if size == "full" || size == "max" {
        return (clamp_dim(native_width), clamp_dim(native_height));
    }

    if let Some(rest) = size.strip_prefix('!') {
        let Some((max_width, max_height)) = parse_size_pair(rest) else {
            return (clamp_dim(native_width), clamp_dim(native_height));
        };
        let scale = (max_width as f64 / native_width as f64)
            .min(max_height as f64 / native_height as f64)
            .max(0.0);
        let width = (native_width as f64 * scale).round().max(1.0) as usize;
        let height = (native_height as f64 * scale).round().max(1.0) as usize;
        return (clamp_dim(width), clamp_dim(height));
    }

    let (width_text, height_text) = size.split_once(',').unwrap_or((size, ""));
    match (
        width_text.parse::<usize>().ok(),
        height_text.parse::<usize>().ok(),
    ) {
        (Some(width), Some(height)) => (clamp_dim(width), clamp_dim(height)),
        (Some(width), None) => {
            let height = (width as f64 * aspect).round().max(1.0) as usize;
            (clamp_dim(width), clamp_dim(height))
        }
        (None, Some(height)) => {
            let width = (height as f64 / aspect).round().max(1.0) as usize;
            (clamp_dim(width), clamp_dim(height))
        }
        _ => (clamp_dim(native_width), clamp_dim(native_height)),
    }
}

fn parse_size_pair(value: &str) -> Option<(usize, usize)> {
    let (width, height) = value.split_once(',')?;
    Some((width.parse().ok()?, height.parse().ok()?))
}

fn resize_gray_letterboxed(
    gray: &[u8],
    source_width: usize,
    source_height: usize,
    output_width: usize,
    output_height: usize,
) -> Option<Vec<u8>> {
    const PREVIEW_BACKGROUND_GRAY: u8 = 5;

    if source_width == 0 || source_height == 0 || output_width == 0 || output_height == 0 {
        return None;
    }

    if gray.len() != source_width.checked_mul(source_height)? {
        return None;
    }

    let mut output = vec![PREVIEW_BACKGROUND_GRAY; output_width.checked_mul(output_height)?];
    let padding = preview_canvas_padding(output_width, output_height);
    let inner_width = output_width.saturating_sub(padding * 2).max(1);
    let inner_height = output_height.saturating_sub(padding * 2).max(1);
    let scale = (inner_width as f64 / source_width.max(1) as f64)
        .min(inner_height as f64 / source_height.max(1) as f64)
        .max(f64::EPSILON);
    let target_width =
        ((source_width as f64 * scale).round() as usize).clamp(1, inner_width.max(1));
    let target_height =
        ((source_height as f64 * scale).round() as usize).clamp(1, inner_height.max(1));
    let offset_x = (output_width.saturating_sub(target_width)) / 2;
    let offset_y = (output_height.saturating_sub(target_height)) / 2;

    for y in 0..target_height {
        let source_y = y * source_height / target_height;
        for x in 0..target_width {
            let source_x = x * source_width / target_width;
            let target_x = offset_x + x;
            let target_y = offset_y + y;
            output[target_y * output_width + target_x] = gray[source_y * source_width + source_x];
        }
    }

    Some(output)
}

fn preview_canvas_padding(width: usize, height: usize) -> usize {
    let side = width.min(height);
    if side < 32 {
        return 0;
    }

    let max_padding = side.saturating_sub(1) / 2;
    ((side as f64 * 0.06).round() as usize)
        .max(2)
        .min(max_padding)
}

fn resize_gray_nearest(
    gray: &[u8],
    source_width: usize,
    source_height: usize,
    output_width: usize,
    output_height: usize,
) -> Option<Vec<u8>> {
    if gray.len() != source_width.checked_mul(source_height)? {
        return None;
    }

    let mut output = vec![0_u8; output_width.checked_mul(output_height)?];
    for y in 0..output_height {
        let source_y = y * source_height / output_height;
        for x in 0..output_width {
            let source_x = x * source_width / output_width;
            output[y * output_width + x] = gray[source_y * source_width + source_x];
        }
    }
    Some(output)
}

fn gray_bmp(width: usize, height: usize, gray: &[u8]) -> Vec<u8> {
    let row_stride = (width * 3).div_ceil(4) * 4;
    let pixel_bytes = row_stride * height;
    let file_size = 14 + 40 + pixel_bytes;
    let mut bytes = Vec::with_capacity(file_size);

    bytes.extend_from_slice(b"BM");
    bytes.extend_from_slice(&(file_size as u32).to_le_bytes());
    bytes.extend_from_slice(&[0, 0, 0, 0]);
    bytes.extend_from_slice(&(54_u32).to_le_bytes());
    bytes.extend_from_slice(&(40_u32).to_le_bytes());
    bytes.extend_from_slice(&(width as i32).to_le_bytes());
    bytes.extend_from_slice(&(height as i32).to_le_bytes());
    bytes.extend_from_slice(&(1_u16).to_le_bytes());
    bytes.extend_from_slice(&(24_u16).to_le_bytes());
    bytes.extend_from_slice(&(0_u32).to_le_bytes());
    bytes.extend_from_slice(&(pixel_bytes as u32).to_le_bytes());
    bytes.extend_from_slice(&(2835_i32).to_le_bytes());
    bytes.extend_from_slice(&(2835_i32).to_le_bytes());
    bytes.extend_from_slice(&(0_u32).to_le_bytes());
    bytes.extend_from_slice(&(0_u32).to_le_bytes());

    let padding = row_stride - width * 3;
    for y in (0..height).rev() {
        let row_start = y * width;
        for x in 0..width {
            let value = gray[row_start + x];
            bytes.extend_from_slice(&[value, value, value]);
        }
        bytes.extend(std::iter::repeat_n(0, padding));
    }

    bytes
}

fn slice_dims(volume: &VolumeEntry, axis: &str) -> Option<(u16, u16)> {
    match axis {
        "axial" => Some((volume.shape[0], volume.shape[1])),
        "coronal" => Some((volume.shape[0], volume.shape[2])),
        "sagittal" => Some((volume.shape[1], volume.shape[2])),
        _ => None,
    }
}

fn slice_count(volume: &VolumeEntry, axis: &str) -> Option<u16> {
    match axis {
        "axial" => Some(volume.shape[2]),
        "coronal" => Some(volume.shape[1]),
        "sagittal" => Some(volume.shape[0]),
        _ => None,
    }
}

fn preview_svg(
    volume: &VolumeEntry,
    axis: &str,
    slice: u16,
    width: u16,
    height: u16,
    path: &ImagePath,
) -> String {
    let seed = volume.id.bytes().fold(u32::from(slice), |acc, value| {
        acc.wrapping_add(u32::from(value))
    });
    let cx = 50 + (seed % 30);
    let cy = 50 + ((seed / 3) % 28);
    let rx = 28 + ((seed / 5) % 12);
    let ry = 34 + ((seed / 7) % 10);
    let path_summary = format!(
        "{} {} {} {}",
        path.region, path.size, path.rotation, path.quality_format
    );

    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 100 100">
  <defs>
    <radialGradient id="brain" cx="48%" cy="45%" r="58%">
      <stop offset="0" stop-color="#e9f2ef"/>
      <stop offset="0.48" stop-color="#8ca9a2"/>
      <stop offset="1" stop-color="#182625"/>
    </radialGradient>
  </defs>
  <rect width="100" height="100" fill="#050808"/>
  <ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" fill="url(#brain)" opacity="0.94"/>
  <path d="M28 53 C39 44, 48 63, 59 50 S77 56, 82 42" fill="none" stroke="#263d3a" stroke-width="2" opacity="0.55"/>
  <path d="M24 62 C36 72, 48 60, 62 72 S78 65, 84 72" fill="none" stroke="#d8e8e3" stroke-width="1.2" opacity="0.38"/>
  <text x="7" y="12" fill="#6ad3bd" font-size="5" font-family="monospace">{axis} {slice}</text>
  <text x="7" y="92" fill="#91a09e" font-size="4" font-family="monospace">{}</text>
</svg>"##,
        escape_xml(&path_summary)
    )
}

fn url_component(value: &str) -> String {
    value.replace('/', "%2F").replace(' ', "%20")
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
