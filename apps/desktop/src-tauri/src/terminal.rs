use std::{
    collections::HashSet,
    io::{Read, Write},
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

/// Async + `spawn_blocking` so probing interpreters (one `--version` subprocess each)
/// never runs on, and freezes, the main thread.
#[tauri::command]
pub async fn discover_python_interpreters(
    server_state: tauri::State<'_, NeuroVueState>,
) -> Result<Vec<PythonInterpreter>, String> {
    let dataset_root = volumetric_server::dataset_root(&server_state.server);
    tauri::async_runtime::spawn_blocking(move || discover_interpreters(dataset_root.as_deref()))
        .await
        .map_err(|error| format!("discover_python_interpreters: join error: {error}"))
}

fn discover_interpreters(dataset_root: Option<&Path>) -> Vec<PythonInterpreter> {
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut interpreters = Vec::new();

    // Project venvs first (most relevant). These can live inside an untrusted dataset,
    // so they are identified from pyvenv.cfg and never executed.
    for venv in venv_dirs(dataset_root) {
        if let Some(interpreter) = venv_interpreter(&venv) {
            if seen.insert(PathBuf::from(&interpreter.path)) {
                interpreters.push(interpreter);
            }
        }
    }

    let mut clt = CltProbe::default();
    for (candidate, source) in candidate_python_paths() {
        // Check the resolved path too: e.g. /usr/local/bin/python3 -> /usr/bin/python3.
        let shim = is_xcrun_shim(&candidate)
            || std::fs::canonicalize(&candidate).is_ok_and(|path| is_xcrun_shim(&path));
        if shim && !clt.installed() {
            continue;
        }
        push_interpreter(&candidate, source, &mut seen, &mut interpreters);
    }

    interpreters
}

/// Validate a manually chosen interpreter path (from the cross-platform file
/// dialog) and return its details. Keeping discovery of the path in the frontend
/// dialog plugin lets the picker work on macOS, Windows, and Linux alike.
#[tauri::command]
pub async fn inspect_python_interpreter(path: String) -> Result<PythonInterpreter, String> {
    tauri::async_runtime::spawn_blocking(move || inspect_interpreter(&path))
        .await
        .map_err(|error| format!("inspect_python_interpreter: join error: {error}"))?
}

fn inspect_interpreter(path: &str) -> Result<PythonInterpreter, String> {
    let candidate = PathBuf::from(path);
    let canonical = std::fs::canonicalize(&candidate).map_err(|error| {
        format!(
            "inspect_python_interpreter: {}: {error}",
            candidate.display()
        )
    })?;
    if is_xcrun_shim(&canonical) && !CltProbe::default().installed() {
        return Err(format!(
            "inspect_python_interpreter: {} needs the Xcode Command Line Tools \
             (install with `xcode-select --install`)",
            canonical.display()
        ));
    }
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

/// `.venv` / `venv` directories under the dataset root and the process cwd.
fn venv_dirs(dataset_root: Option<&Path>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(root) = dataset_root {
        roots.push(root.to_path_buf());
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    roots
        .iter()
        .flat_map(|root| [root.join(".venv"), root.join("venv")])
        .collect()
}

/// Describe a venv from its pyvenv.cfg without running anything inside it. The path is
/// kept uncanonicalized: resolving the symlink would point at the base interpreter, and
/// the terminal would then put the base `bin/` (not the venv's) on PATH.
fn venv_interpreter(venv: &Path) -> Option<PythonInterpreter> {
    let python = venv.join("bin").join("python");
    if !python.is_file() {
        return None;
    }
    let mut text = String::new();
    std::fs::File::open(venv.join("pyvenv.cfg"))
        .ok()?
        .take(64 * 1024)
        .read_to_string(&mut text)
        .ok()?;
    let version = pyvenv_version(&text)?;
    Some(PythonInterpreter {
        label: interpreter_label(&python, &version, "venv"),
        path: python.display().to_string(),
        version,
        source: "venv".to_string(),
    })
}

/// Python version from pyvenv.cfg: `version` (CPython venv) or `version_info`
/// (uv / virtualenv, e.g. `3.12.1.final.0`, trimmed to its numeric prefix).
fn pyvenv_version(text: &str) -> Option<String> {
    let mut version = None;
    let mut version_info = None;
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        match key.trim() {
            "version" => version = Some(value.to_string()),
            "version_info" => {
                let numeric: Vec<&str> = value
                    .split('.')
                    .take_while(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
                    .collect();
                if !numeric.is_empty() {
                    version_info = Some(numeric.join("."));
                }
            }
            _ => {}
        }
    }
    version.or(version_info)
}

/// Ordered candidate list outside any project: PATH, then pyenv/conda.
fn candidate_python_paths() -> Vec<(PathBuf, &'static str)> {
    let mut candidates: Vec<(PathBuf, &'static str)> = Vec::new();

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

/// On macOS, `/usr/bin/python3` is an xcrun shim: running it without the Command Line
/// Tools pops the "install developer tools" dialog instead of printing a version.
fn is_xcrun_shim(path: &Path) -> bool {
    cfg!(target_os = "macos") && path.parent() == Some(Path::new("/usr/bin"))
}

/// Lazily answers "are the Xcode Command Line Tools (or Xcode) installed?" at most once.
#[derive(Default)]
struct CltProbe(Option<bool>);

impl CltProbe {
    fn installed(&mut self) -> bool {
        *self.0.get_or_insert_with(|| {
            // Cheap filesystem check first; `xcode-select -p` covers Xcode.app-only setups
            // and just exits non-zero (no dialog) when nothing is installed.
            Path::new("/Library/Developer/CommandLineTools").is_dir()
                || Command::new("xcode-select")
                    .arg("-p")
                    .output()
                    .map(|output| output.status.success())
                    .unwrap_or(false)
        })
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pyvenv_version_reads_cpython_version_key() {
        let cfg = "home = /usr/local/bin\ninclude-system-site-packages = false\nversion = 3.11.4\n";
        assert_eq!(pyvenv_version(cfg).as_deref(), Some("3.11.4"));
    }

    #[test]
    fn pyvenv_version_trims_version_info() {
        assert_eq!(
            pyvenv_version("home=/opt/py/bin\nversion_info=3.12.1.final.0\n").as_deref(),
            Some("3.12.1")
        );
        assert_eq!(
            pyvenv_version("version_info = 3.12.4\n").as_deref(),
            Some("3.12.4")
        );
    }

    #[test]
    fn pyvenv_version_prefers_version_over_version_info() {
        let cfg = "version_info = 3.12.1.final.0\nversion = 3.12.1rc1\n";
        assert_eq!(pyvenv_version(cfg).as_deref(), Some("3.12.1rc1"));
    }

    #[test]
    fn pyvenv_version_none_without_version_keys() {
        assert_eq!(pyvenv_version("home = /usr/bin\nversion =\n"), None);
        assert_eq!(pyvenv_version(""), None);
    }

    #[cfg(unix)]
    #[test]
    fn venv_interpreter_never_executes_the_venv_python() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!(
            "neurovue-venv-test-{}-{}",
            std::process::id(),
            SESSION_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let venv = root.join(".venv");
        let bin = venv.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let marker = root.join("executed");
        let python = bin.join("python");
        std::fs::write(
            &python,
            format!(
                "#!/bin/sh\ntouch '{}'\necho Python 9.9.9\n",
                marker.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&python, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(venv.join("pyvenv.cfg"), "version = 3.10.2\n").unwrap();

        let found = discover_interpreters(Some(&root));
        let venv_entry = found
            .iter()
            .find(|entry| entry.path == python.display().to_string())
            .expect("dataset venv is listed");
        assert_eq!(venv_entry.version, "3.10.2");
        assert_eq!(venv_entry.source, "venv");
        assert!(!marker.exists(), "discovery must not execute dataset code");

        // No pyvenv.cfg: not treated as a venv at all.
        std::fs::remove_file(venv.join("pyvenv.cfg")).unwrap();
        assert!(venv_interpreter(&venv).is_none());

        let _ = std::fs::remove_dir_all(&root);
    }
}
