use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    net::TcpListener,
    path::PathBuf,
    sync::{Arc, Mutex},
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
    sidecar_path: Option<PathBuf>,
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

pub fn spawn_default() -> ServerHandle {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind NeuroVue local server");
    let addr = listener.local_addr().expect("read NeuroVue local server addr");
    listener
        .set_nonblocking(true)
        .expect("set NeuroVue listener nonblocking");

    let base_url = format!("http://{}", addr);
    let volumes = discover_volumes();
    let state = AppState {
        base_url: base_url.clone(),
        volumes: Arc::new(volumes),
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
                .route("/iiif/image/:vol_id/:axis/:slice/info.json", get(image_info))
                .route(
                    "/iiif/image/:vol_id/:axis/:slice/:region/:size/:rotation/:quality_format",
                    get(image_tile),
                )
                .route("/session/correction.patch.json", get(read_patch).post(write_patch))
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
            json!({
                "id": volume.id,
                "format": volume.format,
                "shape": volume.shape,
                "spacing": volume.spacing,
                "dtype": volume.dtype,
                "metadata": format!("{}/volumes/{}/metadata", state.base_url, url_component(&volume.id)),
                "raw": format!("{}/volumes/{}/raw.nii.gz", state.base_url, url_component(&volume.id)),
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
    let rows = ((state.volumes.len() as f64) / f64::from(columns)).ceil().max(1.0) as u32;
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
                    "image": format!("{}/full/384,/0/default.png", preview_service)
                },
                "levels": [{
                    "level": 0,
                    "shape": volume.shape,
                    "spacing": volume.spacing,
                    "ready": volume.source_path.is_some(),
                    "bytes": null,
                    "raw": format!("{}/volumes/{}/raw.nii.gz", state.base_url, encoded)
                }],
                "brickTemplate": format!("{}/volumes/{}/raw.nii.gz?level={{level}}&bbox={{bbox}}", state.base_url, encoded),
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
        .sidecar_path
        .as_ref()
        .and_then(|path| read_json_sidecar(path).map(|metadata| (path, metadata)))
        .map(|(path, metadata)| {
            json!({
                "kind": "json",
                "name": path.file_name().and_then(|name| name.to_str()).unwrap_or("sidecar.json"),
                "path": path.display().to_string(),
                "metadata": metadata
            })
        })
        .into_iter()
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
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/x.nifti+gzip"),
    );
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
    State(state): State<AppState>,
) -> Result<Response, StatusCode> {
    let volume = find_volume(&state, &path.vol_id).ok_or(StatusCode::NOT_FOUND)?;
    let (width, height) = slice_dims(volume, &path.axis).ok_or(StatusCode::BAD_REQUEST)?;
    let svg = preview_svg(volume, &path.axis, path.slice, width, height, &path);

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("image/svg+xml; charset=utf-8"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=300"),
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

fn discover_volumes() -> Vec<VolumeEntry> {
    let source_path = find_mni152();
    let sidecar_path = source_path.as_ref().and_then(find_json_sidecar);

    vec![VolumeEntry {
        id: "mni152".to_string(),
        label: "MNI152 reference".to_string(),
        format: "nifti".to_string(),
        shape: [197, 233, 189],
        spacing: [1.0, 1.0, 1.0],
        dtype: "uint8".to_string(),
        source_path,
        sidecar_path,
    }]
}

fn find_mni152() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/Users/chrisdrake"));
    let candidates = [
        home.join("Dev/mono/packages/dev-images/images/volumes/mni152.nii.gz"),
        home.join("Dev/mono/apps/medgfx/medgfx/mni152.nii.gz"),
        home.join("Dev/niivue/niivue/packages/niivue-desktop/resources/images/standard/mni152.nii.gz"),
        home.join("Dev/niivue/niivue/packages/niivue/demos/images/mni152.nii.gz"),
        home.join("Dev/niivue-demo-images/mni152.nii.gz"),
    ];
    candidates.into_iter().find(|path| path.is_file())
}

fn find_json_sidecar(path: &PathBuf) -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(file_name) = path.file_name().and_then(|name| name.to_str()) {
        candidates.push(path.with_file_name(format!("{file_name}.json")));

        if let Some(stem) = file_name
            .strip_suffix(".nii.gz")
            .or_else(|| file_name.strip_suffix(".nii"))
        {
            candidates.push(path.with_file_name(format!("{stem}.json")));
        }
    }

    candidates.push(path.with_extension("json"));
    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn read_json_sidecar(path: &PathBuf) -> Option<Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|body| serde_json::from_str(&body).ok())
}

fn find_volume<'a>(state: &'a AppState, vol_id: &str) -> Option<&'a VolumeEntry> {
    state.volumes.iter().find(|volume| volume.id == vol_id)
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
    let seed = volume
        .id
        .bytes()
        .fold(u32::from(slice), |acc, value| acc.wrapping_add(u32::from(value)));
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
