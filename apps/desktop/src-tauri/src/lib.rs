// niimath (a native sidecar) and the integrated terminal (a PTY/shell) both
// spawn subprocesses, which iOS/Android forbid, so both modules are desktop-only.
#[cfg(desktop)]
mod niimath;
#[cfg(desktop)]
mod terminal;
mod share;
mod volumetric_server;

use serde::Serialize;
use std::path::Path;
// The app menu bar is a desktop-only concept; iOS/Android have no `tauri::menu`.
#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem, Submenu};
#[cfg(desktop)]
use tauri::Emitter;

#[cfg(desktop)]
const OPEN_DIRECTORY_MENU_ID: &str = "neurovue-open-directory";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NeuroVueServerInfo {
    url: String,
    port: u16,
    volume_count: usize,
    dataset_root: Option<String>,
    cache_root: String,
    bids_name: Option<String>,
    bids_version: Option<String>,
    bids_dataset_doi: Option<String>,
    warm_progress: volumetric_server::WarmProgressSnapshot,
}

pub(crate) struct NeuroVueState {
    pub(crate) server: volumetric_server::ServerHandle,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DatasetOpenResult {
    url: String,
    port: u16,
    volume_count: usize,
    dataset_root: String,
    cache_root: String,
    bids_name: Option<String>,
    bids_version: Option<String>,
    bids_dataset_doi: Option<String>,
    warm_progress: volumetric_server::WarmProgressSnapshot,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayAddResult {
    id: String,
    label: String,
    volume_count: usize,
    warm_progress: volumetric_server::WarmProgressSnapshot,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportBundleResult {
    bundle_path: String,
    volume_count: usize,
    total_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeCapabilities {
    terminal_available: bool,
    native_niimath_available: bool,
    airdrop_available: bool,
}

#[tauri::command]
fn neurovue_runtime_capabilities() -> RuntimeCapabilities {
    RuntimeCapabilities {
        terminal_available: cfg!(desktop),
        native_niimath_available: cfg!(desktop),
        airdrop_available: cfg!(target_os = "macos"),
    }
}

#[tauri::command]
fn neurovue_server_info(state: tauri::State<'_, NeuroVueState>) -> NeuroVueServerInfo {
    let bids = volumetric_server::bids_dataset_info(&state.server);
    NeuroVueServerInfo {
        url: state.server.url.clone(),
        port: state.server.port,
        volume_count: volumetric_server::volume_count(&state.server),
        dataset_root: volumetric_server::dataset_root(&state.server)
            .map(|path| path.display().to_string()),
        cache_root: volumetric_server::cache_root().display().to_string(),
        bids_name: bids.as_ref().and_then(|info| info.name.clone()),
        bids_version: bids.as_ref().and_then(|info| info.bids_version.clone()),
        bids_dataset_doi: bids.as_ref().and_then(|info| info.dataset_doi.clone()),
        warm_progress: volumetric_server::warm_progress(&state.server),
    }
}

#[tauri::command]
async fn open_dataset_path(
    state: tauri::State<'_, NeuroVueState>,
    path: String,
) -> Result<DatasetOpenResult, String> {
    let server = state.server.clone();
    tauri::async_runtime::spawn_blocking(move || open_dataset_at_path(&server, Path::new(&path)))
        .await
        .map_err(|error| format!("open_dataset_path: join error: {error}"))?
}

#[tauri::command]
async fn add_overlay_volume_path(
    state: tauri::State<'_, NeuroVueState>,
    path: String,
) -> Result<OverlayAddResult, String> {
    let server = state.server.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let registered = volumetric_server::register_overlay_volume(&server, Path::new(&path))?;
        Ok(OverlayAddResult {
            id: registered.id,
            label: registered.label,
            volume_count: volumetric_server::volume_count(&server),
            warm_progress: volumetric_server::warm_progress(&server),
        })
    })
    .await
    .map_err(|error| format!("add_overlay_volume_path: join error: {error}"))?
}

#[tauri::command]
async fn export_dataset_bundle(
    state: tauri::State<'_, NeuroVueState>,
    dest_path: String,
    volume_ids: Vec<String>,
    view: serde_json::Value,
    created_at: String,
) -> Result<ExportBundleResult, String> {
    let server = state.server.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = volumetric_server::export_bundle(
            &server,
            Path::new(&dest_path),
            &volume_ids,
            &view,
            &created_at,
        )?;
        Ok(ExportBundleResult {
            bundle_path: result.bundle_path,
            volume_count: result.volume_count,
            total_bytes: result.total_bytes,
        })
    })
    .await
    .map_err(|error| format!("export_dataset_bundle: join error: {error}"))?
}

#[tauri::command]
async fn share_view_via_airdrop(
    app: tauri::AppHandle,
    state: tauri::State<'_, NeuroVueState>,
    volume_ids: Vec<String>,
    view: serde_json::Value,
    created_at: String,
    name: String,
) -> Result<ExportBundleResult, String> {
    let server = state.server.clone();
    // Export the bundle to a cache location off the main thread; the user picks
    // no destination for a share (unlike Save), so we stage it under the app
    // cache and hand the finished bundle to AirDrop.
    let (result, dest) = tauri::async_runtime::spawn_blocking(move || {
        let dest = volumetric_server::cache_root()
            .join("shares")
            .join(format!("{}.nvbundle", sanitize_share_name(&name)));
        let result =
            volumetric_server::export_bundle(&server, &dest, &volume_ids, &view, &created_at)?;
        Ok::<_, String>((result, dest))
    })
    .await
    .map_err(|error| format!("share_view_via_airdrop: join error: {error}"))??;

    share::share_via_airdrop(&app, vec![dest.display().to_string()])?;

    Ok(ExportBundleResult {
        bundle_path: result.bundle_path,
        volume_count: result.volume_count,
        total_bytes: result.total_bytes,
    })
}

/// Keep a share bundle's directory name to a safe single path segment.
fn sanitize_share_name(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        "neurovue-bundle".to_string()
    } else {
        trimmed.to_string()
    }
}

#[tauri::command]
async fn read_bundle_manifest(path: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        volumetric_server::read_bundle(Path::new(&path))
    })
    .await
    .map_err(|error| format!("read_bundle_manifest: join error: {error}"))?
}

fn open_dataset_at_path(
    server: &volumetric_server::ServerHandle,
    root: &Path,
) -> Result<DatasetOpenResult, String> {
    let volume_count = volumetric_server::open_dataset_root(server, root)?;
    let dataset_root = volumetric_server::dataset_root(server)
        .unwrap_or_else(|| root.to_path_buf())
        .display()
        .to_string();
    let bids = volumetric_server::bids_dataset_info(server);

    Ok(DatasetOpenResult {
        url: server.url.clone(),
        port: server.port,
        volume_count,
        dataset_root,
        cache_root: volumetric_server::cache_root().display().to_string(),
        bids_name: bids.as_ref().and_then(|info| info.name.clone()),
        bids_version: bids.as_ref().and_then(|info| info.bids_version.clone()),
        bids_dataset_doi: bids.as_ref().and_then(|info| info.dataset_doi.clone()),
        warm_progress: volumetric_server::warm_progress(server),
    })
}

#[cfg(desktop)]
fn neurovue_menu<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(handle)?;
    let open_directory = MenuItem::with_id(
        handle,
        OPEN_DIRECTORY_MENU_ID,
        "Open Directory...",
        true,
        Some("CmdOrCtrl+O"),
    )?;
    let dataset_menu = Submenu::with_items(handle, "Dataset", true, &[&open_directory])?;
    menu.insert(&dataset_menu, 1)?;
    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let server = volumetric_server::spawn_default();

    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());

    // The menu bar (and its "Open Directory" item) is desktop-only; on mobile
    // the frontend opens datasets through an on-screen control instead.
    #[cfg(desktop)]
    let builder = builder.menu(neurovue_menu).on_menu_event(|app, event| {
        if event.id().as_ref() == OPEN_DIRECTORY_MENU_ID {
            let _ = app.emit("neurovue-open-directory", ());
        }
    });

    let builder = builder.manage(NeuroVueState { server });

    // niimath (sidecar) and terminal (PTY) commands are desktop-only; mobile
    // registers only the portable commands.
    #[cfg(desktop)]
    let builder = builder
        .manage(terminal::TerminalState::default())
        .invoke_handler(tauri::generate_handler![
            neurovue_runtime_capabilities,
            neurovue_server_info,
            open_dataset_path,
            add_overlay_volume_path,
            export_dataset_bundle,
            read_bundle_manifest,
            share_view_via_airdrop,
            niimath::validate_niimath_mask_path,
            niimath::run_niimath_task,
            terminal::terminal_start,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_kill,
            terminal::discover_python_interpreters,
            terminal::inspect_python_interpreter
        ]);
    #[cfg(not(desktop))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        neurovue_runtime_capabilities,
        neurovue_server_info,
        open_dataset_path,
        add_overlay_volume_path,
        export_dataset_bundle,
        read_bundle_manifest
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running NeuroVue");
}
