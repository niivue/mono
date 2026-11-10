//! `transpose` codec (port of `codecs/transpose.ts`). Decoding is free: it
//! only changes the chunk's strides, exactly like the TS version.

use super::{ArrayToArrayCodec, ChunkMeta, CodecConfig, RawChunk};
use crate::util::{c_order, f_order, get_strides};
use crate::{Error, Result};
use bytes::Bytes;
use serde_json::Value;

pub struct TransposeCodec {
    order: Vec<usize>,
    elem_size: usize,
}

impl TransposeCodec {
    pub fn from_config(c: &CodecConfig, meta: &ChunkMeta) -> Result<Self> {
        let rank = meta.shape.len();
        let order = match c.get("order") {
            None => c_order(rank),
            Some(Value::String(s)) if s == "C" => c_order(rank),
            Some(Value::String(s)) if s == "F" => f_order(rank),
            Some(Value::Array(a)) => {
                let order: Vec<usize> = a
                    .iter()
                    .filter_map(|v| v.as_u64().map(|x| x as usize))
                    .collect();
                let mut seen = vec![false; rank];
                if order.len() != rank
                    || order
                        .iter()
                        .any(|&x| x >= rank || std::mem::replace(&mut seen[x], true))
                {
                    return Err(Error::invalid_metadata(format!(
                        "Invalid permutation: {a:?}"
                    )));
                }
                order
            }
            Some(v) => {
                return Err(Error::invalid_metadata(format!(
                    "Invalid transpose order: {v}"
                )));
            }
        };
        let elem_size = meta.data_type.byte_size().unwrap_or(1);
        Ok(Self { order, elem_size })
    }
}

/// Axis order implied by a stride vector (largest stride first).
fn order_of(stride: &[usize]) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..stride.len()).collect();
    idx.sort_by(|&a, &b| stride[b].cmp(&stride[a]));
    idx
}

#[allow(clippy::needless_range_loop)]
/// Copy `src` into a new buffer laid out in `order` (TS `convertArrayOrder`).
fn convert_order(src: &RawChunk, order: &[usize], es: usize) -> RawChunk {
    let out_stride = get_strides(&src.shape, order);
    let size: usize = src.shape.iter().product();
    let mut out = vec![0u8; size * es];
    let nd = src.shape.len();
    let mut index = vec![0usize; nd];
    for _ in 0..size {
        let (mut s, mut o) = (0, 0);
        for d in 0..nd {
            s += index[d] * src.stride[d];
            o += index[d] * out_stride[d];
        }
        out[o * es..(o + 1) * es].copy_from_slice(&src.data[s * es..(s + 1) * es]);
        for d in 0..nd {
            index[d] += 1;
            if index[d] < src.shape[d] || d + 1 == nd {
                break;
            }
            index[d] = 0;
        }
    }
    RawChunk {
        data: Bytes::from(out),
        shape: src.shape.clone(),
        stride: out_stride,
    }
}

impl ArrayToArrayCodec for TransposeCodec {
    fn encode(&self, chunk: RawChunk) -> Result<RawChunk> {
        if order_of(&chunk.stride) == self.order {
            return Ok(chunk);
        }
        Ok(convert_order(&chunk, &self.order, self.elem_size))
    }

    fn decode(&self, chunk: RawChunk) -> Result<RawChunk> {
        let stride = get_strides(&chunk.shape, &self.order);
        Ok(RawChunk { stride, ..chunk })
    }
}
