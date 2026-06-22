use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{hash_map::DefaultHasher, HashMap, HashSet},
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
use tower_http::cors::CorsLayer;

#[derive(Clone)]
pub struct ServerHandle {
    pub url: String,
    pub port: u16,
    pub volume_count: usize,
    volumes: VolumeStore,
    dataset_root: Arc<Mutex<Option<PathBuf>>>,
    preview_cache: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    pyramid_locks: PyramidLocks,
    warm_generation: Arc<AtomicU64>,
}

type VolumeStore = Arc<Mutex<Vec<VolumeEntry>>>;
/// Per-volume build locks keyed by source signature, so different volumes can
/// build their pyramids concurrently while same-volume builds stay serialized.
type PyramidLocks = Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>;

#[derive(Clone)]
struct AppState {
    base_url: String,
    volumes: VolumeStore,
    dataset_root: Arc<Mutex<Option<PathBuf>>>,
    preview_cache: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    pyramid_locks: PyramidLocks,
    patch: Arc<Mutex<Option<Value>>>,
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
    sidecar_paths: Vec<PathBuf>,
    derived_from: Option<String>,
    derivation: Option<VolumeDerivation>,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum VolumeRole {
    Source,
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
    let preview_cache = Arc::new(Mutex::new(HashMap::new()));
    let pyramid_locks: PyramidLocks = Arc::new(Mutex::new(HashMap::new()));
    let warm_generation = Arc::new(AtomicU64::new(0));
    let state = AppState {
        base_url: base_url.clone(),
        volumes: volumes.clone(),
        dataset_root: dataset_root.clone(),
        preview_cache: preview_cache.clone(),
        pyramid_locks: pyramid_locks.clone(),
        patch: Arc::new(Mutex::new(None)),
    };

    // Warm the coarsest pyramid level for the startup sample in the background.
    let my_gen = warm_generation.load(Ordering::SeqCst);
    spawn_coarse_warm(
        warm_volumes,
        warm_root,
        pyramid_locks.clone(),
        warm_generation.clone(),
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
                .layer(CorsLayer::permissive())
                .with_state(state);

            axum::serve(listener, app)
                .await
                .expect("serve NeuroVue local server");
        });
    });

    ServerHandle {
        url: base_url,
        port: addr.port(),
        volume_count,
        volumes,
        dataset_root,
        preview_cache,
        pyramid_locks,
        warm_generation,
    }
}

pub fn dataset_root(handle: &ServerHandle) -> Option<PathBuf> {
    handle
        .dataset_root
        .lock()
        .ok()
        .and_then(|root| root.clone())
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

    *handle
        .volumes
        .lock()
        .map_err(|_| "open_dataset_root: volume store is unavailable".to_string())? = volumes;
    *handle
        .dataset_root
        .lock()
        .map_err(|_| "open_dataset_root: dataset root is unavailable".to_string())? = Some(root);
    if let Ok(mut cache) = handle.preview_cache.lock() {
        cache.clear();
    }

    // Cancel any in-flight warming for the previous dataset, then warm the new one.
    let my_gen = handle.warm_generation.fetch_add(1, Ordering::SeqCst) + 1;
    spawn_coarse_warm(
        warm_volumes,
        warm_root,
        handle.pyramid_locks.clone(),
        handle.warm_generation.clone(),
        my_gen,
    );

    Ok(volume_count)
}

pub fn volume_count(handle: &ServerHandle) -> usize {
    handle
        .volumes
        .lock()
        .map(|volumes| volumes.len())
        .unwrap_or(handle.volume_count)
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
    let mut volumes = handle
        .volumes
        .lock()
        .map_err(|_| "register_derived_volume: volume store is unavailable".to_string())?;
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

    volumes.push(VolumeEntry {
        id: unique_id.clone(),
        label: format!("{source_label} / {operation}"),
        role: VolumeRole::Derived,
        format: "nifti".to_string(),
        shape: header.shape,
        spacing: header.spacing,
        dtype: header.dtype,
        source_path: Some(output_path.clone()),
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

async fn api_info(State(state): State<AppState>) -> Json<Value> {
    let volumes = state
        .volumes
        .lock()
        .map(|volumes| volumes.clone())
        .unwrap_or_default();
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
    let volumes = state
        .volumes
        .lock()
        .map(|volumes| volumes.clone())
        .unwrap_or_default();
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
        ensure_downsampled_nifti(&volume, level, &state.pyramid_locks, dataset_root.as_deref())
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
    if let Some(cached) = state
        .preview_cache
        .lock()
        .ok()
        .and_then(|cache| cache.get(&cache_key).cloned())
    {
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
            if let Ok(mut cache) = state.preview_cache.lock() {
                cache.insert(cache_key.clone(), bytes.clone());
            }
            headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/bmp"));
            return Ok((headers, bytes).into_response());
        }
    }

    if let Some(bmp) = render_slice_bmp(
        &volume,
        &path.axis,
        path.slice,
        &path.size,
        query.level,
        &state.pyramid_locks,
        dataset_root.as_deref(),
    ) {
        if let Ok(mut cache) = state.preview_cache.lock() {
            cache.insert(cache_key, bmp.clone());
        }
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
    let patch = state
        .patch
        .lock()
        .ok()
        .and_then(|value| value.clone())
        .unwrap_or_else(|| json!({ "status": "empty" }));
    Json(patch)
}

async fn write_patch(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    let mut patch = state
        .patch
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
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

    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z"
    )
}

const DEFAULT_MAX_VOLUMES: usize = 512;
const MAX_PYRAMID_LEVEL: u8 = 3;
const PYRAMID_CACHE_NAME: &str = "nifti-pyramid-v3";
const PREVIEW_DISK_CACHE_NAME: &str = "preview-cache-v1";

struct VolumeDiscovery {
    root: Option<PathBuf>,
    volumes: Vec<VolumeEntry>,
}

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

    Some(VolumeEntry {
        id: unique_volume_id(volumes, &format!("derived__{output_id}")),
        label: format!("{source_label} / {operation}"),
        role: VolumeRole::Derived,
        format: "nifti".to_string(),
        shape: header.shape,
        spacing: header.spacing,
        dtype: header.dtype,
        source_path: Some(output_path.clone()),
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
        sidecar_paths: find_json_sidecars(path, root),
        derived_from: None,
        derivation: None,
    })
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

fn read_nifti_file(path: &FsPath) -> Option<(NiftiHeader, Vec<u8>)> {
    let bytes = if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".gz"))
    {
        let file = File::open(path).ok()?;
        let mut decoder = GzDecoder::new(file);
        let mut bytes = Vec::new();
        decoder.read_to_end(&mut bytes).ok()?;
        bytes
    } else {
        fs::read(path).ok()?
    };

    let header_bytes: [u8; 348] = bytes.get(..348)?.try_into().ok()?;
    let header = parse_nifti_header(&header_bytes)?;
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
    state
        .volumes
        .lock()
        .ok()
        .and_then(|volumes| volumes.iter().find(|volume| volume.id == vol_id).cloned())
}

/// The currently-open dataset root. Every volume in the store belongs to it, so
/// it scopes the per-dataset image cache directory.
fn current_dataset_root(state: &AppState) -> Option<PathBuf> {
    state.dataset_root.lock().ok().and_then(|root| root.clone())
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
fn pyramid_lock_for(locks: &PyramidLocks, signature: &str) -> Option<Arc<Mutex<()>>> {
    let mut map = locks.lock().ok()?;
    Some(
        map.entry(signature.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone(),
    )
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
    let lock = pyramid_lock_for(locks, &signature)?;
    let _guard = lock.lock().ok()?;

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
        let mut voxels =
            Vec::with_capacity(output_x.checked_mul(output_y)?.checked_mul(output_z)?);

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

/// Background-build the coarsest pyramid level for each source volume so the
/// first paint is instant everywhere. Cancels as soon as a newer dataset opens
/// (generation changed) and skips volumes whose coarse level is already cached.
fn spawn_coarse_warm(
    volumes: Vec<VolumeEntry>,
    dataset_root: Option<PathBuf>,
    locks: PyramidLocks,
    generation: Arc<AtomicU64>,
    my_gen: u64,
) {
    std::thread::spawn(move || {
        let dataset_root = dataset_root.as_deref();
        for volume in volumes {
            if generation.load(Ordering::SeqCst) != my_gen {
                return;
            }
            if volume.source_path.is_none() {
                continue;
            }
            let max_level = max_pyramid_level(volume.shape);
            if max_level == 0 {
                continue;
            }
            if downsampled_nifti_cache_path(&volume, max_level, dataset_root)
                .map(|path| path.is_file())
                .unwrap_or(false)
            {
                continue;
            }
            let _ = build_pyramid_levels(&volume, &[max_level], &locks, dataset_root);
        }
    });
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
    cache_root().join("datasets").join(dataset_segment(dataset_root))
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

fn source_signature(volume: &VolumeEntry) -> Option<String> {
    let source_path = volume.source_path.as_ref()?;
    let metadata = fs::metadata(source_path).ok()?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    Some(format!(
        "{}-{}-{}-{:016x}",
        sanitize_cache_component(&volume.id),
        metadata.len(),
        modified,
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

fn render_slice_bmp(
    volume: &VolumeEntry,
    axis: &str,
    slice: u16,
    size: &str,
    requested_level: Option<u8>,
    pyramid_locks: &PyramidLocks,
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
    let (header, bytes) = read_nifti_file(&path)?;
    let data = bytes.get(header.vox_offset..)?;
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
    let slice_index = usize::from(slice).checked_div(factor)?;
    let voxel_count = dim_x.checked_mul(dim_y)?.checked_mul(dim_z)?;
    let required_bytes = voxel_count.checked_mul(bytes_per_voxel)?;
    if data.len() < required_bytes {
        return None;
    }

    let mut values = Vec::with_capacity(native_width.checked_mul(native_height)?);
    for row in 0..native_height {
        for col in 0..native_width {
            let voxel_index = match axis {
                "axial" => {
                    let x = col;
                    let y = native_height - 1 - row;
                    let z = slice_index.min(dim_z.saturating_sub(1));
                    voxel_linear_index(x, y, z, dim_x, dim_y)?
                }
                "coronal" => {
                    let x = col;
                    let y = slice_index.min(dim_y.saturating_sub(1));
                    let z = native_height - 1 - row;
                    voxel_linear_index(x, y, z, dim_x, dim_y)?
                }
                "sagittal" => {
                    let x = slice_index.min(dim_x.saturating_sub(1));
                    let y = col;
                    let z = native_height - 1 - row;
                    voxel_linear_index(x, y, z, dim_x, dim_y)?
                }
                _ => return None,
            };
            values.push(sample_nifti_value(data, &header, voxel_index)?);
        }
    }

    let gray = scale_slice_to_gray(&values);
    let (output_width, output_height) = requested_image_size(size, native_width, native_height);
    let resized = if should_letterbox_preview(size) {
        resize_gray_letterboxed(
            &gray,
            native_width,
            native_height,
            output_width,
            output_height,
        )
    } else {
        resize_gray_nearest(
            &gray,
            native_width,
            native_height,
            output_width,
            output_height,
        )
    }?;
    Some(gray_bmp(output_width, output_height, &resized))
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
