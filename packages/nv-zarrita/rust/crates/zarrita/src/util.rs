//! Helpers ported from `util.ts`: strides, chunk keys, v2 -> v3 metadata, fill values.

use crate::dtype::{DataType, Endian};
use crate::metadata::{
    ArrayMetadata, ArrayMetadataV2, Attributes, ChunkGrid, ChunkKeyEncoding,
    ChunkKeyEncodingConfig, ChunkKeyEncodingName, CodecMetadata, Order, RegularChunkGridConfig,
    Separator,
};
use crate::{Error, Result};
use serde_json::{Map, Value, json};

/// Row-major axis order `[0, 1, ..., rank-1]`.
pub fn c_order(rank: usize) -> Vec<usize> {
    (0..rank).collect()
}

/// Column-major axis order `[rank-1, ..., 0]`.
pub fn f_order(rank: usize) -> Vec<usize> {
    (0..rank).rev().collect()
}

/// Element strides for `shape` laid out in `order` (TS `getStrides`).
pub fn get_strides(shape: &[usize], order: &[usize]) -> Vec<usize> {
    assert_eq!(
        shape.len(),
        order.len(),
        "Order length must match the number of dimensions."
    );
    let mut step = 1;
    let mut stride = vec![0; shape.len()];
    for &axis in order.iter().rev() {
        stride[axis] = step;
        step *= shape[axis];
    }
    stride
}

/// Builds chunk keys from chunk coordinates (TS `createChunkKeyEncoder`).
#[derive(Debug, Clone)]
pub struct ChunkKeyEncoder {
    v2: bool,
    sep: char,
}

impl ChunkKeyEncoder {
    pub fn new(enc: &ChunkKeyEncoding) -> Self {
        let sep = enc.configuration.as_ref().and_then(|c| c.separator);
        match enc.name {
            ChunkKeyEncodingName::Default => Self {
                v2: false,
                sep: if sep == Some(Separator::Dot) {
                    '.'
                } else {
                    '/'
                },
            },
            ChunkKeyEncodingName::V2 => Self {
                v2: true,
                sep: if sep == Some(Separator::Slash) {
                    '/'
                } else {
                    '.'
                },
            },
        }
    }

    pub fn encode(&self, coords: &[usize]) -> String {
        use std::fmt::Write;
        let mut s = String::with_capacity(4 + coords.len() * 4);
        if !self.v2 {
            s.push('c');
        }
        for (i, c) in coords.iter().enumerate() {
            if i > 0 || !self.v2 {
                s.push(self.sep);
            }
            write!(s, "{c}").unwrap();
        }
        if self.v2 && coords.is_empty() {
            s.push('0');
        }
        s
    }
}

/// Convert v2 metadata (`.zarray` + `.zattrs`) to the v3 model (TS `v2ToV3ArrayMetadata`).
pub fn v2_to_v3_array_metadata(
    meta: &ArrayMetadataV2,
    attributes: Attributes,
) -> Result<ArrayMetadata> {
    let (dtype, endian) = DataType::from_v2(&meta.dtype)?;
    let mut codecs = Vec::new();
    if meta.order == Order::F {
        codecs.push(codec("transpose", json!({ "order": "F" })));
    }
    for filter in meta.filters.iter().flatten() {
        if filter.id == "fixedscaleoffset" || filter.id == "numcodecs.fixedscaleoffset" {
            return Err(Error::Unsupported("fixedscaleoffset filter".into()));
        }
        codecs.push(CodecMetadata {
            name: format!("numcodecs.{}", filter.id),
            configuration: Some(filter.config.clone()),
        });
    }
    if endian == Some(Endian::Big) {
        codecs.push(codec("bytes", json!({ "endian": "big" })));
    }
    if let Some(c) = &meta.compressor {
        codecs.push(CodecMetadata {
            name: format!("numcodecs.{}", c.id),
            configuration: Some(c.config.clone()),
        });
    }
    let dimension_names = attributes
        .get("_ARRAY_DIMENSIONS")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|v| v.as_str().map(String::from)).collect());
    Ok(ArrayMetadata {
        zarr_format: 3,
        node_type: "array".into(),
        shape: meta.shape.clone(),
        dimension_names,
        data_type: dtype.to_string(),
        chunk_grid: ChunkGrid::Regular(RegularChunkGridConfig {
            chunk_shape: meta.chunks.clone(),
        }),
        chunk_key_encoding: ChunkKeyEncoding {
            name: ChunkKeyEncodingName::V2,
            configuration: Some(ChunkKeyEncodingConfig {
                separator: Some(meta.dimension_separator.unwrap_or(Separator::Dot)),
            }),
        },
        codecs,
        fill_value: meta.fill_value.clone(),
        attributes,
        storage_transformers: vec![],
    })
}

fn codec(name: &str, config: Value) -> CodecMetadata {
    let configuration = match config {
        Value::Object(m) => Some(m),
        _ => Some(Map::new()),
    };
    CodecMetadata {
        name: name.into(),
        configuration,
    }
}

/// Encode a JSON fill value as one native-endian element of `dtype`.
/// `null` becomes all zeros (TS leaves the zero-initialized buffer as is).
pub fn fill_value_bytes(dtype: &DataType, v: &Value) -> Result<Vec<u8>> {
    use DataType::*;
    let size = dtype
        .byte_size()
        .ok_or_else(|| Error::Unsupported(format!("fill value for {dtype}")))?;
    if v.is_null() {
        return Ok(vec![0; size]);
    }
    let bad = || Error::invalid_metadata(format!("invalid fill_value {v} for {dtype}"));
    let as_f64 = || -> Result<f64> {
        match v {
            Value::Number(n) => n.as_f64().ok_or_else(bad),
            Value::String(s) => match s.as_str() {
                "NaN" => Ok(f64::NAN),
                "Infinity" => Ok(f64::INFINITY),
                "-Infinity" => Ok(f64::NEG_INFINITY),
                _ => Err(bad()),
            },
            Value::Bool(b) => Ok(*b as u8 as f64),
            _ => Err(bad()),
        }
    };
    let as_i128 = || -> Result<i128> {
        match v {
            Value::Number(n) => n
                .as_i64()
                .map(i128::from)
                .or_else(|| n.as_u64().map(i128::from))
                .or_else(|| n.as_f64().map(|f| f as i128))
                .ok_or_else(bad),
            Value::Bool(b) => Ok(*b as i128),
            _ => Err(bad()),
        }
    };
    Ok(match dtype {
        Bool => vec![as_i128()? as u8],
        Int8 => (as_i128()? as i8).to_ne_bytes().to_vec(),
        Int16 => (as_i128()? as i16).to_ne_bytes().to_vec(),
        Int32 => (as_i128()? as i32).to_ne_bytes().to_vec(),
        Int64 => (as_i128()? as i64).to_ne_bytes().to_vec(),
        Uint8 => (as_i128()? as u8).to_ne_bytes().to_vec(),
        Uint16 => (as_i128()? as u16).to_ne_bytes().to_vec(),
        Uint32 => (as_i128()? as u32).to_ne_bytes().to_vec(),
        Uint64 => (as_i128()? as u64).to_ne_bytes().to_vec(),
        Float16 => half::f16::from_f64(as_f64()?).to_ne_bytes().to_vec(),
        Float32 => (as_f64()? as f32).to_ne_bytes().to_vec(),
        Float64 => as_f64()?.to_ne_bytes().to_vec(),
        V2Bytes(_) | V2Unicode(_) => vec![0; size],
        String | V2Object => unreachable!(),
    })
}

/// Swap the byte order of each `elem_size`-byte element in place (TS `byteswapInplace`).
pub fn byteswap_inplace(buf: &mut [u8], elem_size: usize) {
    if elem_size > 1 {
        for chunk in buf.chunks_exact_mut(elem_size) {
            chunk.reverse();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strides() {
        assert_eq!(get_strides(&[2, 3, 4], &c_order(3)), vec![12, 4, 1]);
        assert_eq!(get_strides(&[2, 3, 4], &f_order(3)), vec![1, 2, 6]);
    }

    #[test]
    fn chunk_keys() {
        let v3 = ChunkKeyEncoder::new(&ChunkKeyEncoding {
            name: ChunkKeyEncodingName::Default,
            configuration: None,
        });
        assert_eq!(v3.encode(&[1, 2]), "c/1/2");
        assert_eq!(v3.encode(&[]), "c");
        let v2 = ChunkKeyEncoder::new(&ChunkKeyEncoding {
            name: ChunkKeyEncodingName::V2,
            configuration: None,
        });
        assert_eq!(v2.encode(&[1, 2]), "1.2");
        assert_eq!(v2.encode(&[]), "0");
    }
}
