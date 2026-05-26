mod volumetric_server;

use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NeuroVueServerInfo {
    url: String,
    port: u16,
    volume_count: usize,
}

struct NeuroVueState {
    server: volumetric_server::ServerHandle,
}

#[tauri::command]
fn neurovue_server_info(state: tauri::State<'_, NeuroVueState>) -> NeuroVueServerInfo {
    NeuroVueServerInfo {
        url: state.server.url.clone(),
        port: state.server.port,
        volume_count: state.server.volume_count,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let server = volumetric_server::spawn_default();

    tauri::Builder::default()
        .manage(NeuroVueState { server })
        .invoke_handler(tauri::generate_handler![neurovue_server_info])
        .run(tauri::generate_context!())
        .expect("error while running NeuroVue");
}

