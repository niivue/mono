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
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::Read,
    net::TcpListener,
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex},
    time::UNIX_EPOCH,
};
use tokio::runtime::Builder;
use tower_http::cors::CorsLayer;

#[derive(Clone)]
pub struct ServerHandle {
    pub url: String,
    pub port: u16,
    pub volume_count: usize,
}

#[derive(Clone)]
struct AppState {
    base_url: String,
    volumes: Arc<Vec<VolumeEntry>>,
    preview_cache: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    pyramid_lock: Arc<Mutex<()>>,
    patch: Arc<Mutex<Option<Value>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VolumeEntry {
    id: String,
    label: String,
    format: String,
    shape: [u16; 3],
    spacing: [f32; 3],
    dtype: String,
    source_path: Option<PathBuf>,
    sidecar_paths: Vec<PathBuf>,
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
    let volumes = discover_volumes();
    let state = AppState {
        base_url: base_url.clone(),
        volumes: Arc::new(volumes),
        preview_cache: Arc::new(Mutex::new(HashMap::new())),
        pyramid_lock: Arc::new(Mutex::new(())),
        patch: Arc::new(Mutex::new(None)),
    };
    let volume_count = state.volumes.len();

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
    }
}

async fn api_info(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "service": "neurovue-volumetric-server",
        "version": "0.1.0",
        "desktop": format!("{}/iiif/desktop/neuro/manifest", state.base_url),
        "volumes": state.volumes.iter().map(|volume| {
            let encoded = url_component(&volume.id);
            json!({
                "id": volume.id,
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

async fn desktop_manifest(
    Path(desktop_id): Path<String>,
    State(state): State<AppState>,
) -> Json<Value> {
    let tile_size = 1024_u32;
    let gap = 96_u32;
    let columns = (state.volumes.len() as f64).sqrt().ceil().max(1.0) as u32;
    let rows = ((state.volumes.len() as f64) / f64::from(columns))
        .ceil()
        .max(1.0) as u32;
    let pitch = tile_size + gap;

    let items = state
        .volumes
        .iter()
        .enumerate()
        .map(|(index, volume)| {
            let encoded = url_component(&volume.id);
            let col = index as u32 % columns;
            let row = index as u32 / columns;
            let preview_slice = volume.shape[2] / 2;
            let preview_service = format!(
                "{}/iiif/image/{}/axial/{}",
                state.base_url, encoded, preview_slice
            );

            json!({
                "id": volume.id,
                "type": "NiftiVolumeItem",
                "label": volume.label,
                "index": index,
                "bounds": {
                    "x": col * pitch,
                    "y": row * pitch,
                    "width": tile_size,
                    "height": tile_size
                },
                "format": volume.format,
                "shape": volume.shape,
                "spacing": volume.spacing,
                "dtype": volume.dtype,
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
            "width": columns * tile_size + columns.saturating_sub(1) * gap,
            "height": rows * tile_size + rows.saturating_sub(1) * gap,
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
        "format": volume.format,
        "shape": volume.shape,
        "spacing": volume.spacing,
        "dtype": volume.dtype,
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
    let level = clamp_pyramid_level(path.level, volume.shape);
    let path = if level == 0 {
        volume.source_path.clone().ok_or(StatusCode::NOT_FOUND)?
    } else {
        ensure_downsampled_nifti(volume, level, &state.pyramid_lock)
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
    let (width, height) = slice_dims(volume, &path.axis).ok_or(StatusCode::BAD_REQUEST)?;
    let max_slice = slice_count(volume, &path.axis).ok_or(StatusCode::BAD_REQUEST)?;
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
    let (width, height) = slice_dims(volume, &path.axis).ok_or(StatusCode::BAD_REQUEST)?;
    let max_slice = slice_count(volume, &path.axis).ok_or(StatusCode::BAD_REQUEST)?;
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

    if let Some(bmp) = render_slice_bmp(
        volume,
        &path.axis,
        path.slice,
        &path.size,
        query.level,
        &state.pyramid_lock,
    ) {
        if let Ok(mut cache) = state.preview_cache.lock() {
            cache.insert(cache_key, bmp.clone());
        }
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/bmp"));
        return Ok((headers, bmp).into_response());
    }

    let svg = preview_svg(volume, &path.axis, path.slice, width, height, &path);
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
    Ok(Json(json!({
        "ok": true,
        "path": "session://neurovue/correction.patch.json",
        "patch": payload
    })))
}

const DEFAULT_MAX_VOLUMES: usize = 512;
const MAX_PYRAMID_LEVEL: u8 = 3;
const PYRAMID_CACHE_NAME: &str = "neurovue-nifti-pyramid-v3";

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

fn discover_volumes() -> Vec<VolumeEntry> {
    let max_volumes = std::env::var("NEUROVUE_MAX_VOLUMES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_VOLUMES);

    for root in discovery_roots() {
        let volumes = discover_volumes_in_root(&root, max_volumes);
        if !volumes.is_empty() {
            return volumes;
        }
    }

    fallback_mni152_volume().into_iter().collect()
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
        format: "nifti".to_string(),
        shape: header.shape,
        spacing: header.spacing,
        dtype: header.dtype,
        source_path: Some(path.to_path_buf()),
        sidecar_paths: find_json_sidecars(path, root),
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
        format: "nifti".to_string(),
        shape: header.shape,
        spacing: header.spacing,
        dtype: header.dtype,
        sidecar_paths: source_path
            .as_ref()
            .map(|path| find_json_sidecars(path, path.parent().unwrap_or_else(|| FsPath::new(""))))
            .unwrap_or_default(),
        source_path,
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

fn find_volume<'a>(state: &'a AppState, vol_id: &str) -> Option<&'a VolumeEntry> {
    state.volumes.iter().find(|volume| volume.id == vol_id)
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

fn ensure_downsampled_nifti(
    volume: &VolumeEntry,
    level: u8,
    pyramid_lock: &Mutex<()>,
) -> Option<PathBuf> {
    let cache_path = downsampled_nifti_cache_path(volume, level)?;
    if cache_path.is_file() {
        return Some(cache_path);
    }

    let _guard = pyramid_lock.lock().ok()?;
    if cache_path.is_file() {
        return Some(cache_path);
    }

    let parent = cache_path.parent()?;
    fs::create_dir_all(parent).ok()?;
    let source_path = volume.source_path.as_ref()?;
    let (header, bytes) = read_nifti_file(source_path)?;
    let source_header: [u8; 348] = bytes.get(..348)?.try_into().ok()?;
    let data = bytes.get(header.vox_offset..)?;
    let factor = pyramid_factor(level);
    let shape = downsampled_shape(header.shape, factor);
    let spacing = [
        header.spacing[0] * factor as f32,
        header.spacing[1] * factor as f32,
        header.spacing[2] * factor as f32,
    ];
    let dim_x = usize::from(header.shape[0]);
    let dim_y = usize::from(header.shape[1]);
    let dim_z = usize::from(header.shape[2]);
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
                        data, &header, source_x, source_y, source_z, factor, dim_x, dim_y, dim_z,
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

    Some(cache_path)
}

fn downsampled_nifti_cache_path(volume: &VolumeEntry, level: u8) -> Option<PathBuf> {
    let source_path = volume.source_path.as_ref()?;
    let metadata = fs::metadata(source_path).ok()?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let source_key = format!(
        "{}-{}-{}",
        sanitize_cache_component(&volume.id),
        metadata.len(),
        modified
    );

    Some(
        std::env::temp_dir()
            .join(PYRAMID_CACHE_NAME)
            .join(source_key)
            .join(format!("level-{level}.nii")),
    )
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
    pyramid_lock: &Mutex<()>,
) -> Option<Vec<u8>> {
    let level = clamp_pyramid_level(
        requested_level.unwrap_or_else(|| preview_level_for_size(size)),
        volume.shape,
    );
    let factor = pyramid_factor(level);
    let path = if level == 0 {
        volume.source_path.clone()?
    } else {
        ensure_downsampled_nifti(volume, level, pyramid_lock)?
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
    let target_width = ((source_width as f64 * scale).round() as usize)
        .clamp(1, inner_width.max(1));
    let target_height = ((source_height as f64 * scale).round() as usize)
        .clamp(1, inner_height.max(1));
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
