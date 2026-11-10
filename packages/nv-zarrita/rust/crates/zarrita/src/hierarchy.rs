//! `Location`, `Array`, `Group` and `root()` (port of `hierarchy.ts`).

use crate::codecs::{ChunkMeta, CodecPipeline, RawChunk};
use crate::dtype::DataType;
use crate::metadata::{ArrayMetadata, Attributes, ChunkGrid, GroupMetadata};
use crate::sharding::{Sharding, ShardingConfig};
use crate::util::{ChunkKeyEncoder, c_order, fill_value_bytes, get_strides};
use crate::{AbsolutePath, Error, Readable, Result, Writable};
use bytes::Bytes;
use std::sync::Arc;

/// A store plus a path within it.
#[derive(Debug)]
pub struct Location<S> {
    pub store: Arc<S>,
    pub path: AbsolutePath,
}

impl<S> Clone for Location<S> {
    fn clone(&self) -> Self {
        Self {
            store: self.store.clone(),
            path: self.path.clone(),
        }
    }
}

impl<S> Location<S> {
    pub fn new(store: Arc<S>, path: AbsolutePath) -> Self {
        Self { store, path }
    }

    /// Resolve a relative path (`"foo/bar"`, `"zarr.json"`) against this location.
    pub fn resolve(&self, rel: &str) -> Result<Location<S>> {
        let mut parts: Vec<&str> = self
            .path
            .as_str()
            .split('/')
            .filter(|s| !s.is_empty())
            .collect();
        for seg in rel.split('/') {
            match seg {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                s => parts.push(s),
            }
        }
        Ok(Location {
            store: self.store.clone(),
            path: AbsolutePath::new(format!("/{}", parts.join("/")))?,
        })
    }
}

/// The root location of a store (TS `zarr.root(store)`).
pub fn root<S>(store: S) -> Location<S> {
    Location {
        store: Arc::new(store),
        path: AbsolutePath::root(),
    }
}

/// A Zarr group.
#[derive(Debug, Clone)]
pub struct Group<S> {
    pub location: Location<S>,
    pub metadata: GroupMetadata,
}

impl<S> Group<S> {
    pub fn attrs(&self) -> &Attributes {
        &self.metadata.attributes
    }
}

/// A Zarr array (v2 arrays are converted to the v3 model on open, as in TS).
pub struct Array<S> {
    pub location: Location<S>,
    metadata: ArrayMetadata,
    dtype: DataType,
    shape: Vec<usize>,
    chunk_shape: Vec<usize>,
    elem_size: usize,
    fill: Vec<u8>,
    key_encoder: ChunkKeyEncoder,
    pipeline: Arc<CodecPipeline>,
    /// Set for `sharding_indexed` arrays; `chunk_shape` is then the inner chunk shape.
    sharding: Option<Arc<Sharding>>,
}

impl<S> std::fmt::Debug for Array<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Array")
            .field("path", &self.location.path)
            .field("dtype", &self.dtype)
            .field("shape", &self.shape)
            .field("chunks", &self.chunk_shape)
            .finish()
    }
}

impl<S> Array<S> {
    pub fn new(location: Location<S>, metadata: ArrayMetadata) -> Result<Self> {
        let dtype = DataType::from_v3(&metadata.data_type)
            .or_else(|_| parse_v2_style(&metadata.data_type))?;
        let elem_size = dtype
            .byte_size()
            .ok_or_else(|| Error::Unsupported(format!("variable-length data type {dtype}")))?;
        let ChunkGrid::Regular(grid) = &metadata.chunk_grid;
        let grid_shape: Vec<usize> = grid.chunk_shape.iter().map(|&x| x as usize).collect();
        let shape: Vec<usize> = metadata.shape.iter().map(|&x| x as usize).collect();
        if grid_shape.len() != shape.len() {
            return Err(Error::invalid_metadata(
                "chunk_shape rank does not match shape rank",
            ));
        }
        let sharded = metadata
            .codecs
            .iter()
            .position(|c| c.name == "sharding_indexed");
        let (chunk_shape, pipeline, sharding) = match sharded {
            None => {
                let meta = ChunkMeta {
                    data_type: dtype.clone(),
                    shape: grid_shape.clone(),
                };
                (
                    grid_shape,
                    CodecPipeline::new(&meta, &metadata.codecs)?,
                    None,
                )
            }
            Some(0) if metadata.codecs.len() == 1 => {
                let config: ShardingConfig = serde_json::from_value(serde_json::Value::Object(
                    metadata.codecs[0].configuration.clone().unwrap_or_default(),
                ))?;
                let sharding = Sharding::new(&config, &grid_shape)?;
                let meta = Sharding::inner_meta(&config, &dtype);
                let pipeline = CodecPipeline::new(&meta, &config.codecs)?;
                (meta.shape, pipeline, Some(Arc::new(sharding)))
            }
            Some(_) => {
                return Err(Error::Unsupported(
                    "codecs before or after sharding_indexed".into(),
                ));
            }
        };
        Ok(Self {
            fill: fill_value_bytes(&dtype, &metadata.fill_value)?,
            key_encoder: ChunkKeyEncoder::new(&metadata.chunk_key_encoding),
            pipeline: Arc::new(pipeline),
            sharding,
            location,
            metadata,
            dtype,
            shape,
            chunk_shape,
            elem_size,
        })
    }

    pub fn shape(&self) -> &[usize] {
        &self.shape
    }
    pub fn chunks(&self) -> &[usize] {
        &self.chunk_shape
    }
    pub fn dtype(&self) -> &DataType {
        &self.dtype
    }
    pub fn attrs(&self) -> &Attributes {
        &self.metadata.attributes
    }
    pub fn metadata(&self) -> &ArrayMetadata {
        &self.metadata
    }
    pub fn dimension_names(&self) -> Option<&[Option<String>]> {
        self.metadata.dimension_names.as_deref()
    }
    pub fn elem_size(&self) -> usize {
        self.elem_size
    }

    /// Store key of the object holding a chunk: the chunk itself, or for a
    /// sharded array the shard containing this inner chunk.
    pub fn chunk_path(&self, coords: &[usize]) -> Result<AbsolutePath> {
        let key = match &self.sharding {
            Some(s) => self.key_encoder.encode(&s.shard_coords(coords)),
            None => self.key_encoder.encode(coords),
        };
        Ok(self.location.resolve(&key)?.path)
    }

    /// Whether this array uses `sharding_indexed` (chunks are then inner chunks).
    pub fn is_sharded(&self) -> bool {
        self.sharding.is_some()
    }

    /// Decode stored bytes, or synthesize a fill-value chunk when the key is missing.
    pub fn decode_chunk(&self, bytes: Option<Bytes>, path: Option<&str>) -> Result<RawChunk> {
        match bytes {
            Some(b) => self.pipeline.decode(b, path),
            None => {
                let n: usize = self.chunk_shape.iter().product();
                let data = if self.fill.iter().all(|&b| b == 0) {
                    vec![0u8; n * self.elem_size]
                } else {
                    self.fill.repeat(n)
                };
                Ok(RawChunk {
                    data: data.into(),
                    shape: self.chunk_shape.clone(),
                    stride: get_strides(&self.chunk_shape, &c_order(self.chunk_shape.len())),
                })
            }
        }
    }

    pub(crate) fn fill_bytes(&self) -> &[u8] {
        &self.fill
    }
}

impl<S: Readable> Array<S> {
    pub async fn get_chunk_bytes(&self, coords: &[usize]) -> Result<Option<Bytes>> {
        let path = self.chunk_path(coords)?;
        match &self.sharding {
            Some(s) => s.chunk_bytes(&*self.location.store, coords, &path).await,
            None => Ok(self.location.store.get(&path).await?),
        }
    }

    /// Read and decode one chunk (TS `arr.getChunk`).
    pub async fn get_chunk(&self, coords: &[usize]) -> Result<RawChunk> {
        let path = self.chunk_path(coords)?;
        let bytes = self.get_chunk_bytes(coords).await?;
        self.decode_chunk(bytes, Some(path.as_str()))
    }
}

impl<S: Writable> Array<S> {
    /// Encode and store one full chunk given as C-order native-endian bytes.
    pub async fn set_chunk(&self, coords: &[usize], data: Bytes) -> Result<()> {
        if self.sharding.is_some() {
            return Err(Error::Unsupported("writing sharded arrays".into()));
        }
        let n: usize = self.chunk_shape.iter().product();
        if data.len() != n * self.elem_size {
            return Err(Error::InvalidSelection(format!(
                "chunk has {} bytes, expected {}",
                data.len(),
                n * self.elem_size
            )));
        }
        let path = self.chunk_path(coords)?;
        let chunk = RawChunk {
            data,
            shape: self.chunk_shape.clone(),
            stride: get_strides(&self.chunk_shape, &c_order(self.chunk_shape.len())),
        };
        let encoded = self.pipeline.encode(chunk, Some(path.as_str()))?;
        Ok(self.location.store.set(&path, encoded).await?)
    }
}

fn parse_v2_style(s: &str) -> Result<DataType> {
    // `v2:U13`, `v2:S7`, `v2:object` (produced by v2 -> v3 conversion).
    let rest = s
        .strip_prefix("v2:")
        .ok_or_else(|| Error::Unsupported(format!("data_type {s:?}")))?;
    if rest == "object" {
        return Ok(DataType::V2Object);
    }
    Ok(DataType::from_v2(&format!("|{rest}"))?.0)
}
