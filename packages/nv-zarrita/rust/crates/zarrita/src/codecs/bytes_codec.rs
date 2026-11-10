//! `bytes` codec (port of `codecs/bytes.ts`).

use super::{ArrayToBytesCodec, ChunkMeta, CodecConfig, RawChunk};
use crate::dtype::Endian;
use crate::util::{byteswap_inplace, c_order, get_strides};
use crate::{Error, Result};
use bytes::Bytes;
use serde_json::Value;

pub struct BytesCodec {
    swap: bool,
    elem_size: usize,
    shape: Vec<usize>,
    stride: Vec<usize>,
}

const NATIVE: Endian = if cfg!(target_endian = "little") {
    Endian::Little
} else {
    Endian::Big
};

impl BytesCodec {
    pub fn new(endian: Option<Endian>, meta: &ChunkMeta) -> Result<Self> {
        let elem_size = meta
            .data_type
            .byte_size()
            .ok_or_else(|| Error::Unsupported(format!("bytes codec for {}", meta.data_type)))?;
        // Fixed-width UTF-32 strings swap per code point, not per element.
        let swap_size = if matches!(meta.data_type, crate::DataType::V2Unicode(_)) {
            4
        } else {
            elem_size
        };
        Ok(Self {
            swap: endian.is_some_and(|e| e != NATIVE) && swap_size > 1,
            elem_size: swap_size,
            shape: meta.shape.clone(),
            stride: get_strides(&meta.shape, &c_order(meta.shape.len())),
        })
    }

    pub fn from_config(c: &CodecConfig, meta: &ChunkMeta) -> Result<Self> {
        let endian = match c.get("endian").and_then(Value::as_str) {
            Some("big") => Some(Endian::Big),
            Some("little") => Some(Endian::Little),
            None => None,
            Some(other) => {
                return Err(Error::invalid_metadata(format!("invalid endian {other:?}")));
            }
        };
        Self::new(endian, meta)
    }

    fn maybe_swap(&self, b: Bytes) -> Bytes {
        if !self.swap {
            return b;
        }
        let mut v = b.to_vec();
        byteswap_inplace(&mut v, self.elem_size);
        Bytes::from(v)
    }
}

impl ArrayToBytesCodec for BytesCodec {
    fn encode(&self, chunk: RawChunk) -> Result<Bytes> {
        Ok(self.maybe_swap(chunk.data))
    }

    fn decode(&self, bytes: Bytes) -> Result<RawChunk> {
        Ok(RawChunk {
            data: self.maybe_swap(bytes),
            shape: self.shape.clone(),
            stride: self.stride.clone(),
        })
    }
}
