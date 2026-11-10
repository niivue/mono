//! Codec registry and pipeline (port of `codecs.ts` and `codecs/*`).
//!
//! Chunks travel through the pipeline as raw bytes plus shape/stride
//! ([`RawChunk`]); typed views are only created at the very end, by `get`.
//!
//! Ported: `bytes`, `transpose`, `gzip`, `zlib`, `zstd`, `crc32c`, `blosc`
//! (c-blosc via `blosc-src`), `shuffle`, `delta`,
//! `sharding_indexed` (see `crate::sharding`).
//! Not supported on purpose: the standalone numcodecs `lz4` codec.
//! TODO: `vlen-utf8`, `json2`, `bitround`, `scale_offset`,
//! `cast_value`.

pub mod blosc_rs;
mod bytes_codec;
mod compress;
mod crc32c_codec;
mod numcodecs;
mod transpose;

use crate::dtype::DataType;
use crate::error::Direction;
use crate::metadata::CodecMetadata;
use crate::{Error, Result};
use bytes::Bytes;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};

pub use bytes_codec::BytesCodec;
pub use compress::{GzipCodec, ZlibCodec, ZstdCodec};
pub use crc32c_codec::Crc32cCodec;
pub use numcodecs::{BloscCodec, DeltaCodec, ShuffleCodec};
pub use transpose::TransposeCodec;

/// A decoded (or about-to-be-encoded) chunk: raw native-endian element bytes
/// plus shape and element strides (TS `Chunk<D>`).
#[derive(Debug, Clone)]
pub struct RawChunk {
    pub data: Bytes,
    pub shape: Vec<usize>,
    pub stride: Vec<usize>,
}

/// What a codec knows about the chunks it will see (TS `ChunkMetadata`).
#[derive(Debug, Clone)]
pub struct ChunkMeta {
    pub data_type: DataType,
    pub shape: Vec<usize>,
}

pub trait ArrayToArrayCodec: Send + Sync {
    fn encode(&self, chunk: RawChunk) -> Result<RawChunk>;
    fn decode(&self, chunk: RawChunk) -> Result<RawChunk>;
    /// Metadata seen by the next codec (e.g. transpose permutes the shape).
    fn encoded_meta(&self, meta: &ChunkMeta) -> ChunkMeta {
        meta.clone()
    }
}

pub trait ArrayToBytesCodec: Send + Sync {
    fn encode(&self, chunk: RawChunk) -> Result<Bytes>;
    fn decode(&self, bytes: Bytes) -> Result<RawChunk>;
}

pub trait BytesToBytesCodec: Send + Sync {
    fn encode(&self, bytes: Bytes) -> Result<Bytes>;
    fn decode(&self, bytes: Bytes) -> Result<Bytes>;
}

pub enum Codec {
    ArrayToArray(Box<dyn ArrayToArrayCodec>),
    ArrayToBytes(Box<dyn ArrayToBytesCodec>),
    BytesToBytes(Box<dyn BytesToBytesCodec>),
}

pub type CodecConfig = Map<String, Value>;
pub type CodecFactory = fn(&CodecConfig, &ChunkMeta) -> Result<Codec>;

static REGISTRY: LazyLock<RwLock<HashMap<String, CodecFactory>>> = LazyLock::new(|| {
    let mut m: HashMap<String, CodecFactory> = HashMap::new();
    m.insert("bytes".into(), |c, m| {
        Ok(Codec::ArrayToBytes(Box::new(BytesCodec::from_config(
            c, m,
        )?)))
    });
    m.insert("transpose".into(), |c, m| {
        Ok(Codec::ArrayToArray(Box::new(TransposeCodec::from_config(
            c, m,
        )?)))
    });
    for name in ["gzip", "numcodecs.gzip"] {
        m.insert(name.into(), |c, _| {
            Ok(Codec::BytesToBytes(Box::new(GzipCodec::from_config(c))))
        });
    }
    for name in ["zlib", "numcodecs.zlib"] {
        m.insert(name.into(), |c, _| {
            Ok(Codec::BytesToBytes(Box::new(ZlibCodec::from_config(c))))
        });
    }
    for name in ["zstd", "numcodecs.zstd"] {
        m.insert(name.into(), |c, _| {
            Ok(Codec::BytesToBytes(Box::new(ZstdCodec::from_config(c))))
        });
    }
    for name in ["blosc", "numcodecs.blosc"] {
        m.insert(name.into(), |c, m| {
            Ok(Codec::BytesToBytes(Box::new(BloscCodec::from_config(
                c, m,
            )?)))
        });
    }
    m.insert("numcodecs.shuffle".into(), |c, m| {
        Ok(Codec::BytesToBytes(Box::new(ShuffleCodec::from_config(
            c, m,
        ))))
    });
    m.insert("numcodecs.delta".into(), |_, m| {
        Ok(Codec::ArrayToArray(Box::new(DeltaCodec::new(m)?)))
    });
    m.insert("crc32c".into(), |_, _| {
        Ok(Codec::BytesToBytes(Box::new(Crc32cCodec)))
    });
    RwLock::new(m)
});

/// Register (or replace) a codec factory, like `zarr.registry.set(...)` in TS.
pub fn register_codec(name: impl Into<String>, factory: CodecFactory) {
    REGISTRY.write().unwrap().insert(name.into(), factory);
}

type Named<T> = (String, T);

/// The ordered chain of codecs for one array (TS `createCodecPipeline`).
pub struct CodecPipeline {
    array_to_array: Vec<Named<Box<dyn ArrayToArrayCodec>>>,
    array_to_bytes: Named<Box<dyn ArrayToBytesCodec>>,
    bytes_to_bytes: Vec<Named<Box<dyn BytesToBytesCodec>>>,
}

fn step_err(
    direction: Direction,
    codec: &str,
    chunk_path: Option<&str>,
) -> impl FnOnce(Error) -> Error {
    let codec = codec.to_string();
    let chunk_path = chunk_path.map(String::from);
    move |e| Error::CodecPipeline {
        direction,
        codec: Some(codec),
        chunk_path,
        source: Box::new(e),
    }
}

impl CodecPipeline {
    pub fn new(meta: &ChunkMeta, codecs: &[CodecMetadata]) -> Result<Self> {
        let registry = REGISTRY.read().unwrap();
        let empty = Map::new();
        let mut array_to_array = Vec::new();
        let mut array_to_bytes = None;
        let mut bytes_to_bytes = Vec::new();
        let mut current = meta.clone();
        for cm in codecs {
            let factory = registry
                .get(&cm.name)
                .ok_or_else(|| Error::UnknownCodec(cm.name.clone()))?;
            match factory(cm.configuration.as_ref().unwrap_or(&empty), &current)? {
                Codec::ArrayToArray(c) => {
                    current = c.encoded_meta(&current);
                    array_to_array.push((cm.name.clone(), c));
                }
                Codec::ArrayToBytes(c) => array_to_bytes = Some((cm.name.clone(), c)),
                Codec::BytesToBytes(c) => bytes_to_bytes.push((cm.name.clone(), c)),
            }
        }
        let array_to_bytes = match array_to_bytes {
            Some(c) => c,
            None => {
                if current.data_type.byte_size().is_none() {
                    return Err(Error::invalid_metadata(format!(
                        "Cannot encode {} to bytes without a codec",
                        current.data_type
                    )));
                }
                let c: Box<dyn ArrayToBytesCodec> = Box::new(BytesCodec::new(None, &current)?);
                ("bytes".to_string(), c)
            }
        };
        Ok(Self {
            array_to_array,
            array_to_bytes,
            bytes_to_bytes,
        })
    }

    pub fn decode(&self, mut bytes: Bytes, chunk_path: Option<&str>) -> Result<RawChunk> {
        for (name, c) in self.bytes_to_bytes.iter().rev() {
            bytes = c
                .decode(bytes)
                .map_err(step_err(Direction::Decode, name, chunk_path))?;
        }
        let (name, c) = &self.array_to_bytes;
        let mut chunk = c
            .decode(bytes)
            .map_err(step_err(Direction::Decode, name, chunk_path))?;
        for (name, c) in self.array_to_array.iter().rev() {
            chunk = c
                .decode(chunk)
                .map_err(step_err(Direction::Decode, name, chunk_path))?;
        }
        Ok(chunk)
    }

    pub fn encode(&self, mut chunk: RawChunk, chunk_path: Option<&str>) -> Result<Bytes> {
        for (name, c) in &self.array_to_array {
            chunk = c
                .encode(chunk)
                .map_err(step_err(Direction::Encode, name, chunk_path))?;
        }
        let (name, c) = &self.array_to_bytes;
        let mut bytes = c
            .encode(chunk)
            .map_err(step_err(Direction::Encode, name, chunk_path))?;
        for (name, c) in &self.bytes_to_bytes {
            bytes = c
                .encode(bytes)
                .map_err(step_err(Direction::Encode, name, chunk_path))?;
        }
        Ok(bytes)
    }
}

pub(crate) fn config_i64(c: &CodecConfig, key: &str) -> Option<i64> {
    c.get(key).and_then(Value::as_i64)
}
