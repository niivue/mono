// niimath (a native sidecar) and the integrated terminal (a PTY/shell) both
// spawn subprocesses, which iOS/Android forbid, so both modules are desktop-only.
#[cfg(desktop)]
mod niimath;
#[cfg(desktop)]
mod terminal;
mod volumetric_server;

use serde::Serialize;
use std::path::Path;
use tauri::{
    menu::{Menu, MenuItem, Submenu},
    Emitter,
};

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
struct RuntimeCapabilities {
    terminal_available: bool,
    native_niimath_available: bool,
}

#[tauri::command]
fn neurovue_runtime_capabilities() -> RuntimeCapabilities {
    RuntimeCapabilities {
        terminal_available: cfg!(desktop),
        native_niimath_available: cfg!(desktop),
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

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .menu(neurovue_menu)
        .on_menu_event(|app, event| {
            if event.id().as_ref() == OPEN_DIRECTORY_MENU_ID {
                let _ = app.emit("neurovue-open-directory", ());
            }
        })
        .manage(NeuroVueState { server });

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
        add_overlay_volume_path
    ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running NeuroVue");
}
