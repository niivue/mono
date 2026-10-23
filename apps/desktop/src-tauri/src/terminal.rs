use std::{
    collections::HashSet,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::volumetric_server;
use crate::NeuroVueState;

/// One-line bump whenever the bundled helper changes so older copies get rewritten.
const HELPER_VERSION: u32 = 1;

static SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct TerminalState {
    sessions: Mutex<std::collections::HashMap<String, TerminalSession>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStartOptions {
    /// Absolute path to the Python interpreter the user picked, if any.
    interpreter_path: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalChunk {
    id: String,
    data: Vec<u8>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalExit {
    id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonInterpreter {
    path: String,
    version: String,
    label: String,
    /// One of: "path", "venv", "pyenv", "conda", "manual".
    source: String,
}

#[tauri::command]
pub fn terminal_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, TerminalState>,
    server_state: tauri::State<'_, NeuroVueState>,
    options: TerminalStartOptions,
) -> Result<String, String> {
    let rows = options.rows.filter(|value| *value > 0).unwrap_or(24);
    let cols = options.cols.filter(|value| *value > 0).unwrap_or(80);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("terminal_start: openpty: {error}"))?;

    let shell = login_shell();
    let mut cmd = CommandBuilder::new(&shell);
    // Login + interactive so the user's normal profile (PATH, prompt, aliases) loads.
    if shell_is_posix(&shell) {
        cmd.arg("-l");
    }

    let dataset_root = volumetric_server::dataset_root(&server_state.server);
    let cache_root = volumetric_server::cache_root();
    let server_url = server_state.server.url.clone();

    let working_dir = dataset_root
        .clone()
        .filter(|path| path.is_dir())
        .unwrap_or_else(|| cache_root.clone());
    cmd.cwd(&working_dir);

    apply_terminal_env(
        &mut cmd,
        options.interpreter_path.as_deref(),
        dataset_root.as_deref(),
        &cache_root,
        &server_url,
    )?;

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|error| format!("terminal_start: spawn {}: {error}", shell.display()))?;
    // The slave handle is only needed for spawning; dropping it lets EOF propagate.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("terminal_start: clone reader: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("terminal_start: take writer: {error}"))?;

    let id = format!("term-{}", SESSION_COUNTER.fetch_add(1, Ordering::Relaxed));

    {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "terminal_start: session store is unavailable".to_string())?;
        sessions.insert(
            id.clone(),
            TerminalSession {
                master: pair.master,
                writer,
                child,
            },
        );
    }

    let reader_id = id.clone();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match std::io::Read::read(&mut reader, &mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let chunk = TerminalChunk {
                        id: reader_id.clone(),
                        data: buffer[..count].to_vec(),
                    };
                    if app.emit("terminal://data", chunk).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app.emit("terminal://exit", TerminalExit { id: reader_id });
    });

    Ok(id)
}

#[tauri::command]
pub fn terminal_write(
    state: tauri::State<'_, TerminalState>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "terminal_write: session store is unavailable".to_string())?;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("terminal_write: unknown session {id}"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|error| format!("terminal_write: {error}"))?;
    session
        .writer
        .flush()
        .map_err(|error| format!("terminal_write: flush: {error}"))
}

#[tauri::command]
pub fn terminal_resize(
    state: tauri::State<'_, TerminalState>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "terminal_resize: session store is unavailable".to_string())?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| format!("terminal_resize: unknown session {id}"))?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("terminal_resize: {error}"))
}

#[tauri::command]
pub fn terminal_kill(state: tauri::State<'_, TerminalState>, id: String) -> Result<(), String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "terminal_kill: session store is unavailable".to_string())?;
    if let Some(mut session) = sessions.remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}

#[tauri::command]
pub fn discover_python_interpreters(
    server_state: tauri::State<'_, NeuroVueState>,
) -> Vec<PythonInterpreter> {
    let dataset_root = volumetric_server::dataset_root(&server_state.server);
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut interpreters = Vec::new();

    for (candidate, source) in candidate_python_paths(dataset_root.as_deref()) {
        push_interpreter(&candidate, source, &mut seen, &mut interpreters);
    }

    interpreters
}

/// Validate a manually chosen interpreter path (from the cross-platform file
/// dialog) and return its details. Keeping discovery of the path in the frontend
/// dialog plugin lets the picker work on macOS, Windows, and Linux alike.
#[tauri::command]
pub fn inspect_python_interpreter(path: String) -> Result<PythonInterpreter, String> {
    let candidate = PathBuf::from(&path);
    let canonical = std::fs::canonicalize(&candidate)
        .map_err(|error| format!("inspect_python_interpreter: {}: {error}", candidate.display()))?;
    let version = python_version(&canonical).ok_or_else(|| {
        format!(
            "inspect_python_interpreter: not a runnable Python: {}",
            canonical.display()
        )
    })?;
    Ok(PythonInterpreter {
        label: interpreter_label(&canonical, &version, "manual"),
        path: canonical.display().to_string(),
        version,
        source: "manual".to_string(),
    })
}

fn push_interpreter(
    candidate: &Path,
    source: &str,
    seen: &mut HashSet<PathBuf>,
    interpreters: &mut Vec<PythonInterpreter>,
) {
    if !candidate.is_file() {
        return;
    }
    let canonical = match std::fs::canonicalize(candidate) {
        Ok(path) => path,
        Err(_) => return,
    };
    if !seen.insert(canonical.clone()) {
        return;
    }
    let Some(version) = python_version(&canonical) else {
        return;
    };
    interpreters.push(PythonInterpreter {
        label: interpreter_label(&canonical, &version, source),
        path: canonical.display().to_string(),
        version,
        source: source.to_string(),
    });
}

/// Ordered candidate list: project venvs first (most relevant), then PATH, then pyenv/conda.
fn candidate_python_paths(dataset_root: Option<&Path>) -> Vec<(PathBuf, &'static str)> {
    let mut candidates: Vec<(PathBuf, &'static str)> = Vec::new();

    let mut venv_roots: Vec<PathBuf> = Vec::new();
    if let Some(root) = dataset_root {
        venv_roots.push(root.to_path_buf());
    }
    if let Ok(cwd) = std::env::current_dir() {
        venv_roots.push(cwd);
    }
    for root in venv_roots {
        for name in [".venv", "venv"] {
            candidates.push((root.join(name).join("bin").join("python"), "venv"));
        }
    }

    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            for exe in ["python3", "python"] {
                candidates.push((dir.join(exe), "path"));
            }
        }
    }

    if let Some(home) = home_dir() {
        if let Ok(entries) = std::fs::read_dir(home.join(".pyenv").join("versions")) {
            for entry in entries.flatten() {
                candidates.push((entry.path().join("bin").join("python"), "pyenv"));
            }
        }
        for base in ["miniconda3", "anaconda3", "miniforge3"] {
            let conda = home.join(base);
            candidates.push((conda.join("bin").join("python"), "conda"));
            if let Ok(entries) = std::fs::read_dir(conda.join("envs")) {
                for entry in entries.flatten() {
                    candidates.push((entry.path().join("bin").join("python"), "conda"));
                }
            }
        }
    }

    candidates
}

fn python_version(path: &Path) -> Option<String> {
    let output = Command::new(path).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    // Python 3.4+ prints to stdout; older builds use stderr.
    let mut text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        text = String::from_utf8_lossy(&output.stderr).trim().to_string();
    }
    let version = text.trim_start_matches("Python").trim().to_string();
    (!version.is_empty()).then_some(version)
}

fn interpreter_label(path: &Path, version: &str, source: &str) -> String {
    let tag = match source {
        "venv" => " (venv)",
        "pyenv" => " (pyenv)",
        "conda" => " (conda)",
        "manual" => " (custom)",
        _ => "",
    };
    format!("Python {version}{tag} \u{2014} {}", path.display())
}

fn apply_terminal_env(
    cmd: &mut CommandBuilder,
    interpreter_path: Option<&str>,
    dataset_root: Option<&Path>,
    cache_root: &Path,
    server_url: &str,
) -> Result<(), String> {
    let helper_dir = ensure_helper(cache_root)?;

    // xterm.js renders a 256-color terminal; advertise it so programs emit rich output.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");

    if let Some(interpreter) = interpreter_path.filter(|value| !value.is_empty()) {
        cmd.env("NEUROVUE_PYTHON", interpreter);
        if let Some(bin) = Path::new(interpreter).parent() {
            let existing = std::env::var("PATH").unwrap_or_default();
            let joined = if existing.is_empty() {
                bin.display().to_string()
            } else {
                format!("{}:{}", bin.display(), existing)
            };
            cmd.env("PATH", joined);
        }
    }

    if let Some(root) = dataset_root {
        cmd.env("NEUROVUE_DATASET_ROOT", root.display().to_string());
    }
    cmd.env("NEUROVUE_CACHE_ROOT", cache_root.display().to_string());
    cmd.env("NEUROVUE_SERVER_URL", server_url);

    let pythonpath = match std::env::var("PYTHONPATH") {
        Ok(existing) if !existing.is_empty() => {
            format!("{}:{}", helper_dir.display(), existing)
        }
        _ => helper_dir.display().to_string(),
    };
    cmd.env("PYTHONPATH", pythonpath);
    cmd.env("PYTHONSTARTUP", helper_dir.join("neurovue_startup.py"));

    Ok(())
}

/// Write the importable `neurovue` helper + interactive startup banner into the cache
/// root and return the directory to add to PYTHONPATH.
fn ensure_helper(cache_root: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(cache_root)
        .map_err(|error| format!("terminal helper: create {}: {error}", cache_root.display()))?;

    write_if_stale(&cache_root.join("neurovue.py"), HELPER_MODULE)?;
    write_if_stale(&cache_root.join("neurovue_startup.py"), HELPER_STARTUP)?;
    Ok(cache_root.to_path_buf())
}

/// Overwrite only when the existing file lacks the current version marker, so we don't
/// clobber on every launch but still refresh when HELPER_VERSION bumps.
fn write_if_stale(path: &Path, body: &str) -> Result<(), String> {
    let marker = format!("# neurovue-helper-version: {HELPER_VERSION}");
    if let Ok(existing) = std::fs::read_to_string(path) {
        if existing.contains(&marker) {
            return Ok(());
        }
    }
    let contents = format!("{marker}\n{body}");
    std::fs::write(path, contents)
        .map_err(|error| format!("terminal helper: write {}: {error}", path.display()))
}

fn login_shell() -> PathBuf {
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.is_empty() {
            return PathBuf::from(shell);
        }
    }
    for fallback in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
        if Path::new(fallback).exists() {
            return PathBuf::from(fallback);
        }
    }
    PathBuf::from("/bin/sh")
}

fn shell_is_posix(shell: &Path) -> bool {
    matches!(
        shell.file_name().and_then(|name| name.to_str()),
        Some("zsh") | Some("bash") | Some("sh")
    )
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

const HELPER_MODULE: &str = r#""""NeuroVue Python helper.

Auto-generated by NeuroVue. Import it from the integrated terminal:

    >>> import neurovue
    >>> neurovue.volumes()
    >>> img = neurovue.load(neurovue.volumes()[0])

It reads the active dataset/server from the NEUROVUE_* environment variables that
NeuroVue injects into the terminal.
"""
import os
import glob

dataset_root = os.environ.get("NEUROVUE_DATASET_ROOT", "")
cache_root = os.environ.get("NEUROVUE_CACHE_ROOT", "")
server = os.environ.get("NEUROVUE_SERVER_URL", "")


def _files():
    if not dataset_root:
        return []
    matches = []
    for pattern in ("**/*.nii", "**/*.nii.gz"):
        matches.extend(glob.glob(os.path.join(dataset_root, pattern), recursive=True))
    return sorted(set(matches))


def _stem(filename):
    base = os.path.basename(filename)
    for suffix in (".nii.gz", ".nii"):
        if base.endswith(suffix):
            return base[: -len(suffix)]
    return base


def volumes():
    """Return the stems of every NIfTI volume under the active dataset root."""
    return [_stem(path) for path in _files()]


def path(name):
    """Resolve a volume stem (or filename) to its absolute path on disk."""
    target = _stem(name)
    for candidate in _files():
        if _stem(candidate) == target:
            return candidate
    raise FileNotFoundError(
        "No volume named %r under %s" % (name, dataset_root or "<no dataset open>")
    )


def load(name):
    """Load a volume by stem with nibabel. Requires `pip install nibabel`."""
    try:
        import nibabel
    except ImportError as error:
        raise ImportError(
            "neurovue.load needs nibabel. Install it in this interpreter: "
            "pip install nibabel"
        ) from error
    return nibabel.load(path(name))
"#;

const HELPER_STARTUP: &str = r#"# Interactive banner shown when this interpreter starts inside the NeuroVue terminal.
import os as _os

if _os.environ.get("NEUROVUE_DATASET_ROOT"):
    print(
        "NeuroVue: `import neurovue` then neurovue.volumes() / neurovue.load(name). "
        "Dataset: " + _os.environ["NEUROVUE_DATASET_ROOT"]
    )
"#;
