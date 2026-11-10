//! WebAssembly decode core for the `zarrita-wasm` npm package.
//!
//! A deliberately tiny C-style ABI (no wasm-bindgen): the JS side copies
//! compressed bytes into linear memory, calls `zw_decode`, and copies the
//! decoded chunk back out. Each Web Worker owns one instance, so no state is
//! shared between threads.
//!
//! All functions return 0 / null on failure; `zw_error_ptr`/`zw_error_len`
//! then describe the error.

use bytes::Bytes;
use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashMap;
use zarrita::DataType;
use zarrita::codecs::{ChunkMeta, CodecPipeline};
use zarrita::metadata::CodecMetadata;

struct State {
    pipelines: HashMap<u32, CodecPipeline>,
    next_id: u32,
    error: String,
    result: Bytes,
    stride: Vec<u32>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State {
        pipelines: HashMap::new(),
        next_id: 1,
        error: String::new(),
        result: Bytes::new(),
        stride: Vec::new(),
    });
}

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    STATE.with(|s| f(&mut s.borrow_mut()))
}

/// Allocate `len` bytes for the caller to fill. Ownership passes back on `zw_decode`/`zw_free`.
#[unsafe(no_mangle)]
pub extern "C" fn zw_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// Free a buffer from `zw_alloc` that was not handed to `zw_decode`.
///
/// # Safety
/// `ptr`/`len` must come from `zw_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zw_free(ptr: *mut u8, len: usize) {
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len.max(1)) });
}

/// Create a decode pipeline from JSON `{"data_type", "chunk_shape", "codecs"}`
/// (v3 codec list, as zarrita.js holds it after v2 conversion). Returns a handle or 0.
///
/// # Safety
/// `ptr`/`len` must describe a buffer from `zw_alloc`; it is freed here.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zw_pipeline_new(ptr: *mut u8, len: usize) -> u32 {
    let json = unsafe { Vec::from_raw_parts(ptr, len, len.max(1)) };
    let result = (|| -> Result<CodecPipeline, String> {
        let v: Value = serde_json::from_slice(&json).map_err(|e| e.to_string())?;
        let data_type =
            DataType::from_v3(v["data_type"].as_str().unwrap_or("")).map_err(|e| e.to_string())?;
        let shape: Vec<usize> =
            serde_json::from_value(v["chunk_shape"].clone()).map_err(|e| e.to_string())?;
        let codecs: Vec<CodecMetadata> =
            serde_json::from_value(v["codecs"].clone()).map_err(|e| e.to_string())?;
        CodecPipeline::new(&ChunkMeta { data_type, shape }, &codecs).map_err(|e| e.to_string())
    })();
    with(|s| match result {
        Ok(p) => {
            let id = s.next_id;
            s.next_id += 1;
            s.pipelines.insert(id, p);
            id
        }
        Err(e) => {
            s.error = e;
            0
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn zw_pipeline_free(handle: u32) {
    with(|s| s.pipelines.remove(&handle));
}

/// Decode one chunk. Takes ownership of `ptr` (from `zw_alloc`). Returns 1 on
/// success; the decoded bytes are then at `zw_result_ptr`/`zw_result_len` and
/// the element strides at `zw_stride_ptr` (u32 × rank) until the next call.
///
/// # Safety
/// `ptr`/`len` must describe a buffer from `zw_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn zw_decode(handle: u32, ptr: *mut u8, len: usize) -> u32 {
    let input = Bytes::from(unsafe { Vec::from_raw_parts(ptr, len, len.max(1)) });
    with(|s| {
        let Some(p) = s.pipelines.get(&handle) else {
            s.error = format!("unknown pipeline handle {handle}");
            return 0;
        };
        match p.decode(input, None) {
            Ok(chunk) => {
                s.stride = chunk.stride.iter().map(|&x| x as u32).collect();
                s.result = chunk.data;
                1
            }
            Err(e) => {
                s.error = error_chain(&e);
                0
            }
        }
    })
}

fn error_chain(e: &dyn std::error::Error) -> String {
    let mut msg = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        msg.push_str(": ");
        msg.push_str(&s.to_string());
        src = s.source();
    }
    msg
}

#[unsafe(no_mangle)]
pub extern "C" fn zw_result_ptr() -> *const u8 {
    with(|s| s.result.as_ptr())
}
#[unsafe(no_mangle)]
pub extern "C" fn zw_result_len() -> usize {
    with(|s| s.result.len())
}
#[unsafe(no_mangle)]
pub extern "C" fn zw_stride_ptr() -> *const u32 {
    with(|s| s.stride.as_ptr())
}
#[unsafe(no_mangle)]
pub extern "C" fn zw_stride_len() -> usize {
    with(|s| s.stride.len())
}
/// Release the last result's memory early.
#[unsafe(no_mangle)]
pub extern "C" fn zw_result_clear() {
    with(|s| s.result = Bytes::new());
}
#[unsafe(no_mangle)]
pub extern "C" fn zw_error_ptr() -> *const u8 {
    with(|s| s.error.as_ptr())
}
#[unsafe(no_mangle)]
pub extern "C" fn zw_error_len() -> usize {
    with(|s| s.error.len())
}
