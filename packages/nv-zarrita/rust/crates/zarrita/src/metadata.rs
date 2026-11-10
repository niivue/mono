//! Zarr v2/v3 metadata documents (port of `metadata.ts`).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub type Attributes = Map<String, Value>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodecMetadata {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RegularChunkGridConfig {
    pub chunk_shape: Vec<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "name", content = "configuration", rename_all = "lowercase")]
pub enum ChunkGrid {
    Regular(RegularChunkGridConfig),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum Separator {
    #[serde(rename = ".")]
    Dot,
    #[default]
    #[serde(rename = "/")]
    Slash,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ChunkKeyEncodingConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub separator: Option<Separator>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChunkKeyEncodingName {
    Default,
    V2,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChunkKeyEncoding {
    pub name: ChunkKeyEncodingName,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration: Option<ChunkKeyEncodingConfig>,
}

/// Zarr v3 array metadata (`zarr.json`, `node_type: "array"`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArrayMetadata {
    pub zarr_format: u8,
    pub node_type: String,
    pub shape: Vec<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dimension_names: Option<Vec<Option<String>>>,
    pub data_type: String,
    pub chunk_grid: ChunkGrid,
    pub chunk_key_encoding: ChunkKeyEncoding,
    pub codecs: Vec<CodecMetadata>,
    pub fill_value: Value,
    #[serde(default)]
    pub attributes: Attributes,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub storage_transformers: Vec<Value>,
}

/// Zarr v3 group metadata (`zarr.json`, `node_type: "group"`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GroupMetadata {
    pub zarr_format: u8,
    pub node_type: String,
    #[serde(default)]
    pub attributes: Attributes,
    /// Inline consolidated metadata, if present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consolidated_metadata: Option<Value>,
}

/// Either kind of v3 node document.
#[derive(Debug, Clone, PartialEq)]
pub enum NodeMetadata {
    Array(ArrayMetadata),
    Group(GroupMetadata),
}

impl NodeMetadata {
    pub fn from_json(bytes: &[u8]) -> crate::Result<Self> {
        let v: Value = serde_json::from_slice(bytes)?;
        if v.get("zarr_format").and_then(Value::as_u64) != Some(3) {
            return Err(crate::Error::invalid_metadata("expected zarr_format 3"));
        }
        match v.get("node_type").and_then(Value::as_str) {
            Some("array") => Ok(Self::Array(serde_json::from_value(v)?)),
            Some("group") => Ok(Self::Group(serde_json::from_value(v)?)),
            other => Err(crate::Error::invalid_metadata(format!(
                "invalid node_type {other:?}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct V2CodecConfiguration {
    pub id: String,
    #[serde(flatten)]
    pub config: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum Order {
    #[default]
    C,
    F,
}

/// Zarr v2 array metadata (`.zarray`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArrayMetadataV2 {
    pub zarr_format: u8,
    pub shape: Vec<u64>,
    pub chunks: Vec<u64>,
    pub dtype: String,
    pub compressor: Option<V2CodecConfiguration>,
    pub fill_value: Value,
    #[serde(default)]
    pub order: Order,
    pub filters: Option<Vec<V2CodecConfiguration>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dimension_separator: Option<Separator>,
}

/// Zarr v2 group metadata (`.zgroup`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GroupMetadataV2 {
    pub zarr_format: u8,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixtures() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures")
    }

    /// Every zarr.json / .zarray / .zgroup in the fixtures should parse.
    #[test]
    fn parse_all_fixture_metadata() {
        let mut n = 0;
        let mut stack = vec![fixtures()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).unwrap() {
                let p = e.unwrap().path();
                if p.is_dir() {
                    stack.push(p);
                    continue;
                }
                let bytes = std::fs::read(&p).unwrap();
                match p.file_name().unwrap().to_str().unwrap() {
                    "zarr.json" => {
                        NodeMetadata::from_json(&bytes).unwrap_or_else(|e| panic!("{p:?}: {e}"));
                    }
                    ".zarray" => {
                        let m: ArrayMetadataV2 =
                            serde_json::from_slice(&bytes).unwrap_or_else(|e| panic!("{p:?}: {e}"));
                        crate::DataType::from_v2(&m.dtype).unwrap_or_else(|e| panic!("{p:?}: {e}"));
                    }
                    ".zgroup" => {
                        serde_json::from_slice::<GroupMetadataV2>(&bytes).unwrap();
                    }
                    _ => continue,
                }
                n += 1;
            }
        }
        assert!(n > 50, "only parsed {n} metadata files");
    }
}
