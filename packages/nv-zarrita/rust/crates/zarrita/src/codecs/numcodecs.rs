//! numcodecs-compatible codecs: `blosc`, `shuffle`, `delta`.
//! The standalone numcodecs `lz4` codec is intentionally not supported (a
//! legacy format); blosc's internal lz4 compressor is.
//! zarrita.js loads blosc from numcodecs' wasm build of c-blosc;
//! here blosc links the same C library natively.

// Compression levels are only read when encoding.
#![cfg_attr(not(feature = "encode"), allow(dead_code))]

use super::{ArrayToArrayCodec, BytesToBytesCodec, ChunkMeta, CodecConfig, RawChunk, config_i64};
use crate::dtype::DataType;
use crate::{Error, Result};
use bytes::Bytes;
use serde_json::Value;
use std::ffi::CString;
#[cfg(feature = "native-blosc")]
use std::ffi::c_void;

/// Data that fails to decode.
fn codec_err(name: &str, msg: impl std::fmt::Display) -> Error {
    Error::Corrupt(format!("{name}: {msg}"))
}

/// A codec configuration this decoder does not accept.
fn config_err(name: &str, msg: impl std::fmt::Display) -> Error {
    Error::invalid_metadata(format!("{name}: {msg}"))
}

// ---------------------------------------------------------------- blosc

pub struct BloscCodec {
    cname: CString,
    clevel: i32,
    shuffle: i32,
    typesize: usize,
    blocksize: usize,
}

impl BloscCodec {
    pub fn from_config(c: &CodecConfig, meta: &ChunkMeta) -> Result<Self> {
        let cname = c.get("cname").and_then(Value::as_str).unwrap_or("lz4");
        // v2 (numcodecs): shuffle is -1/0/1/2. v3: "noshuffle" | "shuffle" | "bitshuffle".
        let shuffle = match c.get("shuffle") {
            Some(Value::String(s)) => match s.as_str() {
                "noshuffle" => 0,
                "shuffle" => 1,
                "bitshuffle" => 2,
                other => return Err(config_err("blosc", format!("bad shuffle {other:?}"))),
            },
            Some(v) => v.as_i64().unwrap_or(1) as i32,
            None => 1,
        };
        let elem = meta.data_type.byte_size().unwrap_or(1);
        Ok(Self {
            cname: CString::new(cname).map_err(|e| config_err("blosc", e))?,
            clevel: config_i64(c, "clevel").unwrap_or(5) as i32,
            shuffle: if shuffle < 0 {
                if elem > 1 { 1 } else { 2 }
            } else {
                shuffle
            },
            typesize: config_i64(c, "typesize")
                .map(|t| t as usize)
                .unwrap_or(elem),
            blocksize: config_i64(c, "blocksize").unwrap_or(0) as usize,
        })
    }
}

impl BytesToBytesCodec for BloscCodec {
    #[cfg(all(feature = "native-blosc", feature = "encode"))]
    fn encode(&self, b: Bytes) -> Result<Bytes> {
        let mut out = vec![0u8; b.len() + blosc_src::BLOSC_MAX_OVERHEAD as usize];
        // SAFETY: buffers are valid for the given lengths; the _ctx API is thread-safe.
        let n = unsafe {
            blosc_src::blosc_compress_ctx(
                self.clevel,
                self.shuffle,
                self.typesize,
                b.len(),
                b.as_ptr() as *const c_void,
                out.as_mut_ptr() as *mut c_void,
                out.len(),
                self.cname.as_ptr(),
                self.blocksize,
                1,
            )
        };
        if n <= 0 {
            return Err(codec_err("blosc", format!("compression failed ({n})")));
        }
        out.truncate(n as usize);
        Ok(out.into())
    }

    #[cfg(all(feature = "native-blosc", not(feature = "encode")))]
    fn encode(&self, _b: Bytes) -> Result<Bytes> {
        Err(Error::Unsupported(
            "encoding requires the `encode` feature".into(),
        ))
    }

    #[cfg(not(feature = "native-blosc"))]
    fn encode(&self, _b: Bytes) -> Result<Bytes> {
        let _ = (
            &self.cname,
            self.clevel,
            self.shuffle,
            self.typesize,
            self.blocksize,
        );
        Err(codec_err(
            "blosc",
            "encoding requires the native-blosc feature",
        ))
    }

    #[cfg(feature = "native-blosc")]
    fn decode(&self, b: Bytes) -> Result<Bytes> {
        let mut nbytes = 0usize;
        // SAFETY: validate checks the header against the real buffer length first.
        if unsafe {
            blosc_src::blosc_cbuffer_validate(b.as_ptr() as *const c_void, b.len(), &mut nbytes)
        } != 0
        {
            return Err(codec_err("blosc", "invalid blosc buffer"));
        }
        let mut out = vec![0u8; nbytes];
        let n = unsafe {
            blosc_src::blosc_decompress_ctx(
                b.as_ptr() as *const c_void,
                out.as_mut_ptr() as *mut c_void,
                nbytes,
                1,
            )
        };
        if n < 0 || n as usize != nbytes {
            return Err(codec_err("blosc", format!("decompression failed ({n})")));
        }
        Ok(out.into())
    }

    #[cfg(not(feature = "native-blosc"))]
    fn decode(&self, b: Bytes) -> Result<Bytes> {
        Ok(super::blosc_rs::decompress(&b)?.into())
    }
}

// ---------------------------------------------------------------- shuffle

pub struct ShuffleCodec {
    elem: usize,
}

impl ShuffleCodec {
    pub fn from_config(c: &CodecConfig, meta: &ChunkMeta) -> Self {
        let elem = meta
            .data_type
            .byte_size()
            .or_else(|| config_i64(c, "elementsize").map(|e| e as usize))
            .unwrap_or(4);
        Self { elem }
    }
}

impl BytesToBytesCodec for ShuffleCodec {
    fn encode(&self, b: Bytes) -> Result<Bytes> {
        let n = b.len() / self.elem;
        let mut out = vec![0u8; b.len()];
        for byte in 0..self.elem {
            for i in 0..n {
                out[byte * n + i] = b[i * self.elem + byte];
            }
        }
        Ok(out.into())
    }
    fn decode(&self, b: Bytes) -> Result<Bytes> {
        let n = b.len() / self.elem;
        let mut out = vec![0u8; b.len()];
        for byte in 0..self.elem {
            for i in 0..n {
                out[i * self.elem + byte] = b[byte * n + i];
            }
        }
        Ok(out.into())
    }
}

// ---------------------------------------------------------------- delta

pub struct DeltaCodec {
    dtype: DataType,
}

impl DeltaCodec {
    pub fn new(meta: &ChunkMeta) -> Result<Self> {
        use DataType::*;
        match meta.data_type {
            Int8 | Int16 | Int32 | Int64 | Uint8 | Uint16 | Uint32 | Uint64 | Float16 | Float32
            | Float64 => Ok(Self {
                dtype: meta.data_type.clone(),
            }),
            ref other => Err(Error::invalid_metadata(format!(
                "Delta codec does not support data type: {other}"
            ))),
        }
    }

    fn apply(&self, chunk: RawChunk, decode: bool) -> Result<RawChunk> {
        let mut v = chunk.data.to_vec();
        macro_rules! int {
            ($t:ty) => {{
                let s: &mut [$t] =
                    bytemuck::try_cast_slice_mut(&mut v).map_err(|e| codec_err("delta", e))?;
                if decode {
                    for i in 1..s.len() {
                        s[i] = s[i - 1].wrapping_add(s[i]);
                    }
                } else {
                    for i in (1..s.len()).rev() {
                        s[i] = s[i].wrapping_sub(s[i - 1]);
                    }
                }
            }};
        }
        macro_rules! float {
            ($t:ty, $to:expr, $from:expr) => {{
                let s: &mut [$t] =
                    bytemuck::try_cast_slice_mut(&mut v).map_err(|e| codec_err("delta", e))?;
                if decode {
                    for i in 1..s.len() {
                        s[i] = $from($to(s[i - 1]) + $to(s[i]));
                    }
                } else {
                    for i in (1..s.len()).rev() {
                        s[i] = $from($to(s[i]) - $to(s[i - 1]));
                    }
                }
            }};
        }
        use DataType::*;
        match self.dtype {
            Int8 => int!(i8),
            Int16 => int!(i16),
            Int32 => int!(i32),
            Int64 => int!(i64),
            Uint8 => int!(u8),
            Uint16 => int!(u16),
            Uint32 => int!(u32),
            Uint64 => int!(u64),
            Float16 => float!(half::f16, |x: half::f16| x.to_f64(), half::f16::from_f64),
            Float32 => float!(f32, |x: f32| x, |x: f32| x),
            Float64 => float!(f64, |x: f64| x, |x: f64| x),
            _ => unreachable!(),
        }
        Ok(RawChunk {
            data: v.into(),
            ..chunk
        })
    }
}

impl ArrayToArrayCodec for DeltaCodec {
    fn encode(&self, chunk: RawChunk) -> Result<RawChunk> {
        self.apply(chunk, false)
    }
    fn decode(&self, chunk: RawChunk) -> Result<RawChunk> {
        self.apply(chunk, true)
    }
}
