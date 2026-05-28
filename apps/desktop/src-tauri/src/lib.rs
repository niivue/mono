mod volumetric_server;

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
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
}

struct NeuroVueState {
    server: volumetric_server::ServerHandle,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum NiimathOperation {
    Smooth,
    Threshold,
    UpperThreshold,
    Binarize,
    Mask,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NiimathTaskRequest {
    source_path: String,
    operation: NiimathOperation,
    operand: Option<f64>,
    mask_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NiimathTaskResult {
    operation: NiimathOperation,
    source_path: String,
    output_path: String,
    volume_id: String,
    argv: Vec<String>,
    stdout: String,
    stderr: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DatasetOpenResult {
    url: String,
    port: u16,
    volume_count: usize,
    dataset_root: String,
    cache_root: String,
}

#[tauri::command]
fn neurovue_server_info(state: tauri::State<'_, NeuroVueState>) -> NeuroVueServerInfo {
    NeuroVueServerInfo {
        url: state.server.url.clone(),
        port: state.server.port,
        volume_count: volumetric_server::volume_count(&state.server),
        dataset_root: volumetric_server::dataset_root(&state.server)
            .map(|path| path.display().to_string()),
        cache_root: volumetric_server::cache_root().display().to_string(),
    }
}

#[tauri::command]
async fn open_dataset_directory(
    state: tauri::State<'_, NeuroVueState>,
) -> Result<Option<DatasetOpenResult>, String> {
    let server = state.server.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(root) = choose_dataset_directory()? else {
            return Ok(None);
        };
        let volume_count = volumetric_server::open_dataset_root(&server, &root)?;
        let dataset_root = volumetric_server::dataset_root(&server)
            .unwrap_or(root)
            .display()
            .to_string();

        Ok(Some(DatasetOpenResult {
            url: server.url.clone(),
            port: server.port,
            volume_count,
            dataset_root,
            cache_root: volumetric_server::cache_root().display().to_string(),
        }))
    })
    .await
    .map_err(|error| format!("open_dataset_directory: join error: {error}"))?
}

#[tauri::command]
async fn run_niimath_task(
    state: tauri::State<'_, NeuroVueState>,
    request: NiimathTaskRequest,
) -> Result<NiimathTaskResult, String> {
    let server = state.server.clone();
    tauri::async_runtime::spawn_blocking(move || run_niimath_task_blocking(server, request))
        .await
        .map_err(|error| format!("run_niimath_task: join error: {error}"))?
}

fn run_niimath_task_blocking(
    server: volumetric_server::ServerHandle,
    request: NiimathTaskRequest,
) -> Result<NiimathTaskResult, String> {
    let source_path = validate_nifti_path("sourcePath", &request.source_path)?;
    let output_path = niimath_output_path(&source_path, request.operation)?;
    let mut argv = vec![source_path.display().to_string()];

    match request.operation {
        NiimathOperation::Smooth => {
            let operand = required_operand(request.operand, "smooth sigma")?;
            if !(0.0..=100.0).contains(&operand) {
                return Err("run_niimath_task: smooth sigma must be between 0 and 100".into());
            }
            argv.push("-s".into());
            argv.push(format_operand(operand));
        }
        NiimathOperation::Threshold => {
            let operand = required_operand(request.operand, "threshold value")?;
            argv.push("-thr".into());
            argv.push(format_operand(operand));
        }
        NiimathOperation::UpperThreshold => {
            let operand = required_operand(request.operand, "upper threshold value")?;
            argv.push("-uthr".into());
            argv.push(format_operand(operand));
        }
        NiimathOperation::Binarize => {
            argv.push("-bin".into());
        }
        NiimathOperation::Mask => {
            let mask_path = request
                .mask_path
                .as_deref()
                .ok_or_else(|| "run_niimath_task: maskPath is required for Apply Mask".to_string())
                .and_then(|path| validate_nifti_path("maskPath", path))?;
            argv.push("-mas".into());
            argv.push(mask_path.display().to_string());
        }
    }

    argv.push(output_path.display().to_string());

    let program = sidecar_binary("niimath")?;
    let output = Command::new(&program)
        .args(&argv)
        .output()
        .map_err(|error| format!("niimath: failed to spawn {}: {error}", program.display()))?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    if !output.status.success() {
        return Err(format!(
            "niimath exited with code {}: {}",
            output
                .status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "null".into()),
            if stderr.trim().is_empty() {
                "<no stderr>"
            } else {
                stderr.trim()
            }
        ));
    }

    if !output_path.is_file() {
        return Err(format!(
            "niimath completed but did not create {}",
            output_path.display()
        ));
    }

    write_niimath_sidecar(
        &output_path,
        &request,
        &source_path,
        &argv,
        &stdout,
        &stderr,
    )?;
    let volume_id = volumetric_server::register_derived_volume(
        &server,
        &source_path,
        &output_path,
        operation_file_label(request.operation),
    )?;

    Ok(NiimathTaskResult {
        operation: request.operation,
        source_path: source_path.display().to_string(),
        output_path: output_path.display().to_string(),
        volume_id,
        argv,
        stdout,
        stderr,
    })
}

fn required_operand(value: Option<f64>, label: &str) -> Result<f64, String> {
    let value = value.ok_or_else(|| format!("run_niimath_task: {label} is required"))?;
    if value.is_finite() {
        Ok(value)
    } else {
        Err(format!("run_niimath_task: {label} must be finite"))
    }
}

fn validate_nifti_path(label: &str, value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(format!(
            "run_niimath_task: {label} must be an absolute path"
        ));
    }
    let path = fs::canonicalize(&path)
        .map_err(|error| format!("run_niimath_task: {label} {}: {error}", path.display()))?;
    if !path.is_file() {
        return Err(format!(
            "run_niimath_task: {label} is not a file: {}",
            path.display()
        ));
    }
    if !is_nifti_path(&path) {
        return Err(format!(
            "run_niimath_task: {label} must be .nii or .nii.gz: {}",
            path.display()
        ));
    }
    Ok(path)
}

fn niimath_output_path(source_path: &Path, operation: NiimathOperation) -> Result<PathBuf, String> {
    let output_dir = volumetric_server::working_derivatives_dir();
    fs::create_dir_all(&output_dir).map_err(|error| {
        format!(
            "run_niimath_task: create output directory {}: {error}",
            output_dir.display()
        )
    })?;
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("run_niimath_task: system clock error: {error}"))?
        .as_millis();
    let stem = source_path
        .file_name()
        .and_then(|name| name.to_str())
        .map(strip_nifti_suffix)
        .map(sanitize_file_component)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "volume".to_string());
    Ok(output_dir.join(format!(
        "{}-{}-{}.nii.gz",
        stem,
        operation_file_label(operation),
        timestamp_ms
    )))
}

fn write_niimath_sidecar(
    output_path: &Path,
    request: &NiimathTaskRequest,
    source_path: &Path,
    argv: &[String],
    stdout: &str,
    stderr: &str,
) -> Result<(), String> {
    let sidecar_path = nifti_json_sidecar_path(output_path);
    let payload = json!({
        "NeuroVueGenerated": true,
        "DerivativeType": "working",
        "SourceImage": source_path.display().to_string(),
        "GeneratedBy": [{
            "Name": "niimath",
            "Description": "NeuroVue interactive operation preview"
        }],
        "NeuroVueOperation": request.operation,
        "NeuroVueOperand": request.operand,
        "NeuroVueMask": request.mask_path,
        "NeuroVueArgv": argv,
        "NeuroVueStdout": stdout,
        "NeuroVueStderr": stderr,
        "CreatedAt": match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(duration) => format!("unix-ms:{}", duration.as_millis()),
            Err(_) => "unix-ms:0".to_string()
        }
    });

    fs::write(
        &sidecar_path,
        serde_json::to_string_pretty(&payload)
            .map_err(|error| format!("run_niimath_task: serialize sidecar: {error}"))?,
    )
    .map_err(|error| {
        format!(
            "run_niimath_task: write sidecar {}: {error}",
            sidecar_path.display()
        )
    })
}

fn nifti_json_sidecar_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("volume.nii.gz");
    let stem = strip_nifti_suffix(file_name);
    path.with_file_name(format!("{stem}.json"))
}

fn sidecar_binary(name: &str) -> Result<PathBuf, String> {
    for dir in runtime_binary_dirs()? {
        for candidate in sidecar_name_candidates(name) {
            let path = dir.join(&candidate);
            if path.is_file() {
                return Ok(path);
            }
            let nested = dir.join("binaries").join(&candidate);
            if nested.is_file() {
                return Ok(nested);
            }
        }
    }
    Err(format!(
        "sidecar_binary: could not find bundled sidecar \"{name}\""
    ))
}

fn runtime_binary_dirs() -> Result<Vec<PathBuf>, String> {
    let exe = std::env::current_exe().map_err(|error| format!("current_exe: {error}"))?;
    let mut dirs = Vec::new();
    if let Some(parent) = exe.parent() {
        dirs.push(parent.to_path_buf());
        if parent
            .file_name()
            .is_some_and(|name| name == std::ffi::OsStr::new("deps"))
        {
            if let Some(grandparent) = parent.parent() {
                dirs.push(grandparent.to_path_buf());
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        dirs.push(cwd.join("binaries"));
        dirs.push(cwd.join("src-tauri").join("binaries"));
        dirs.push(cwd.join("..").join("src-tauri").join("binaries"));
    }
    Ok(dirs)
}

fn sidecar_name_candidates(name: &str) -> Vec<String> {
    let mut names = vec![name.to_string(), format!("{name}-{}", target_triple())];
    if cfg!(windows) {
        names.push(format!("{name}.exe"));
        names.push(format!("{name}-{}.exe", target_triple()));
    }
    names
}

fn target_triple() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "aarch64-apple-darwin"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "x86_64-apple-darwin"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "x86_64-unknown-linux-gnu"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "aarch64-unknown-linux-gnu"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "x86_64-pc-windows-msvc"
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        "aarch64-pc-windows-msvc"
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "aarch64")
    )))]
    {
        "unknown"
    }
}

fn is_nifti_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".nii") || name.ends_with(".nii.gz"))
}

fn strip_nifti_suffix(value: &str) -> &str {
    value
        .strip_suffix(".nii.gz")
        .or_else(|| value.strip_suffix(".nii"))
        .unwrap_or(value)
}

fn sanitize_file_component(value: &str) -> String {
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

fn operation_file_label(operation: NiimathOperation) -> &'static str {
    match operation {
        NiimathOperation::Smooth => "smooth",
        NiimathOperation::Threshold => "thr",
        NiimathOperation::UpperThreshold => "uthr",
        NiimathOperation::Binarize => "bin",
        NiimathOperation::Mask => "mask",
    }
}

fn format_operand(value: f64) -> String {
    let mut text = format!("{value:.6}");
    while text.contains('.') && text.ends_with('0') {
        text.pop();
    }
    if text.ends_with('.') {
        text.pop();
    }
    text
}

fn choose_dataset_directory() -> Result<Option<PathBuf>, String> {
    choose_dataset_directory_platform()
}

#[cfg(target_os = "macos")]
fn choose_dataset_directory_platform() -> Result<Option<PathBuf>, String> {
    let output = Command::new("osascript")
        .arg("-e")
        .arg(r#"POSIX path of (choose folder with prompt "Open NeuroVue dataset folder")"#)
        .output()
        .map_err(|error| format!("open_dataset_directory: launch folder picker: {error}"))?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok((!path.is_empty()).then(|| PathBuf::from(path)));
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("User canceled") || stderr.contains("-128") {
        return Ok(None);
    }

    Err(format!(
        "open_dataset_directory: folder picker failed: {}",
        stderr.trim()
    ))
}

#[cfg(not(target_os = "macos"))]
fn choose_dataset_directory_platform() -> Result<Option<PathBuf>, String> {
    Err("open_dataset_directory: native folder picker is not available on this platform yet".into())
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

    tauri::Builder::default()
        .menu(neurovue_menu)
        .on_menu_event(|app, event| {
            if event.id().as_ref() == OPEN_DIRECTORY_MENU_ID {
                let _ = app.emit("neurovue-open-directory", ());
            }
        })
        .manage(NeuroVueState { server })
        .invoke_handler(tauri::generate_handler![
            neurovue_server_info,
            open_dataset_directory,
            run_niimath_task
        ])
        .run(tauri::generate_context!())
        .expect("error while running NeuroVue");
}
