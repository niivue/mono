//! `sharding_indexed` reads (port of `codecs/sharding.ts`, plus `index_location`).
//!
//! As in zarrita.js, a sharded array is indexed by its *inner* chunks: `get`
//! asks for inner chunk coordinates, and this module finds the shard holding
//! each one, reads (and caches) the shard's index with a range request, then
//! range-reads just that inner chunk. Inner chunks then go through the normal
//! codec pipeline built from the sharding codec's inner `codecs`.

use crate::codecs::{ChunkMeta, CodecPipeline};
use crate::dtype::DataType;
use crate::metadata::CodecMetadata;
use crate::{AbsolutePath, Error, RangeQuery, Readable, Result};
use bytes::Bytes;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Offset/length pair marking an inner chunk that is not stored.
const MISSING: u64 = u64::MAX;

#[derive(Debug, Clone, Deserialize)]
pub struct ShardingConfig {
    pub chunk_shape: Vec<u64>,
    pub codecs: Vec<CodecMetadata>,
    pub index_codecs: Vec<CodecMetadata>,
    #[serde(default = "default_location")]
    pub index_location: String,
}

fn default_location() -> String {
    "end".into()
}

/// Shard index entries, `[offset, length]` per inner chunk in C order, or
/// `None` when the whole shard is missing.
type Index = Option<Arc<Vec<u64>>>;

pub struct Sharding {
    /// Inner chunks per shard along each axis.
    pub chunks_per_shard: Vec<usize>,
    index_pipeline: CodecPipeline,
    index_size: u64,
    index_at_start: bool,
    cache: Mutex<HashMap<Vec<usize>, Index>>,
}

impl Sharding {
    /// Build from the sharding codec's configuration and the outer (shard) shape.
    pub fn new(config: &ShardingConfig, shard_shape: &[usize]) -> Result<Self> {
        let inner: Vec<usize> = config.chunk_shape.iter().map(|&x| x as usize).collect();
        if inner.len() != shard_shape.len() {
            return Err(Error::invalid_metadata(
                "sharding chunk_shape rank does not match",
            ));
        }
        let mut chunks_per_shard = Vec::with_capacity(inner.len());
        for (&s, &c) in shard_shape.iter().zip(&inner) {
            if c == 0 || s % c != 0 {
                return Err(Error::invalid_metadata(format!(
                    "shard shape {shard_shape:?} is not a multiple of inner chunk shape {inner:?}"
                )));
            }
            chunks_per_shard.push(s / c);
        }
        let n: usize = chunks_per_shard.iter().product();
        // On-disk index size: 16 bytes per entry, plus what the index codecs add.
        let mut index_size = 16 * n as u64;
        for c in &config.index_codecs {
            match c.name.as_str() {
                "bytes" => {}
                "crc32c" => index_size += 4,
                other => {
                    return Err(Error::Unsupported(format!(
                        "shard index codec {other:?} (only bytes and crc32c have a fixed size)"
                    )));
                }
            }
        }
        let mut index_shape = chunks_per_shard.clone();
        index_shape.push(2);
        let index_pipeline = CodecPipeline::new(
            &ChunkMeta {
                data_type: DataType::Uint64,
                shape: index_shape,
            },
            &config.index_codecs,
        )?;
        let index_at_start = match config.index_location.as_str() {
            "start" => true,
            "end" => false,
            other => {
                return Err(Error::invalid_metadata(format!(
                    "invalid index_location {other:?}"
                )));
            }
        };
        Ok(Self {
            chunks_per_shard,
            index_pipeline,
            index_size,
            index_at_start,
            cache: Mutex::new(HashMap::new()),
        })
    }

    pub fn inner_meta(config: &ShardingConfig, data_type: &DataType) -> ChunkMeta {
        ChunkMeta {
            data_type: data_type.clone(),
            shape: config.chunk_shape.iter().map(|&x| x as usize).collect(),
        }
    }

    /// The shard holding an inner chunk.
    pub fn shard_coords(&self, inner: &[usize]) -> Vec<usize> {
        inner
            .iter()
            .zip(&self.chunks_per_shard)
            .map(|(c, n)| c / n)
            .collect()
    }

    async fn index<S: Readable>(
        &self,
        store: &S,
        shard: &[usize],
        path: &AbsolutePath,
    ) -> Result<Index> {
        if let Some(hit) = self.cache.lock().unwrap().get(shard) {
            return Ok(hit.clone());
        }
        let range = if self.index_at_start {
            RangeQuery::Range {
                offset: 0,
                length: self.index_size,
            }
        } else {
            RangeQuery::Suffix {
                suffix_length: self.index_size,
            }
        };
        let index = match store.get_range(path, range).await? {
            None => None,
            Some(bytes) => {
                let chunk = self.index_pipeline.decode(bytes, Some(path.as_str()))?;
                // The `bytes` codec gives native-endian u64s in C order.
                let entries = chunk
                    .data
                    .chunks_exact(8)
                    .map(|b| u64::from_ne_bytes(b.try_into().unwrap()))
                    .collect();
                Some(Arc::new(entries))
            }
        };
        // Concurrent readers of the same shard may both fetch it; either result is fine.
        self.cache
            .lock()
            .unwrap()
            .insert(shard.to_vec(), index.clone());
        Ok(index)
    }

    /// Bytes of one inner chunk, or `None` when it (or its shard) is not stored.
    pub async fn chunk_bytes<S: Readable>(
        &self,
        store: &S,
        inner: &[usize],
        shard_path: &AbsolutePath,
    ) -> Result<Option<Bytes>> {
        let shard = self.shard_coords(inner);
        let Some(index) = self.index(store, &shard, shard_path).await? else {
            return Ok(None);
        };
        let mut linear = 0;
        for (c, n) in inner.iter().zip(&self.chunks_per_shard) {
            linear = linear * n + c % n;
        }
        let (offset, length) = (index[2 * linear], index[2 * linear + 1]);
        if offset == MISSING && length == MISSING {
            return Ok(None);
        }
        let bytes = store
            .get_range(shard_path, RangeQuery::Range { offset, length })
            .await?
            .ok_or_else(|| {
                Error::Corrupt(format!(
                    "{shard_path}: shard vanished after its index was read"
                ))
            })?;
        if bytes.len() as u64 != length {
            return Err(Error::Corrupt(format!(
                "{shard_path}: inner chunk at {offset} should be {length} bytes, got {}",
                bytes.len()
            )));
        }
        Ok(Some(bytes))
    }

    /// Forget cached shard indexes (e.g. after the store changed).
    pub fn clear_cache(&self) {
        self.cache.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        AbsolutePath, Error, GetOptions, MemoryStore, RangeQuery, Readable, Result, Writable, get,
        open_array,
    };
    use bytes::Bytes;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// MemoryStore that counts whole-object and ranged reads.
    #[derive(Default)]
    struct Counting {
        inner: MemoryStore,
        gets: AtomicUsize,
        ranges: AtomicUsize,
    }
    impl Readable for Counting {
        async fn get(&self, key: &AbsolutePath) -> zarrita_storage::Result<Option<Bytes>> {
            if key.as_str().contains("/c/") {
                self.gets.fetch_add(1, Ordering::Relaxed);
            }
            self.inner.get(key).await
        }
        async fn get_range(
            &self,
            key: &AbsolutePath,
            range: RangeQuery,
        ) -> zarrita_storage::Result<Option<Bytes>> {
            self.ranges.fetch_add(1, Ordering::Relaxed);
            self.inner.get_range(key, range).await
        }
    }

    /// A 2x4 int16 array (values 0..8) in 2x2 shards of 1x2 inner chunks.
    /// Shard c/0/1 is absent, and in shard c/0/0 inner chunk (1,0) is marked missing.
    async fn store(index_location: &str, corrupt_crc: bool) -> Counting {
        let s = Counting::default();
        let meta = json!({
            "zarr_format": 3, "node_type": "array", "shape": [2, 4], "data_type": "int16",
            "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": [2, 2]}},
            "chunk_key_encoding": {"name": "default", "configuration": {"separator": "/"}},
            "fill_value": -1, "attributes": {},
            "codecs": [{"name": "sharding_indexed", "configuration": {
                "chunk_shape": [1, 2],
                "codecs": [{"name": "bytes", "configuration": {"endian": "little"}}],
                "index_codecs": [{"name": "bytes", "configuration": {"endian": "little"}}, {"name": "crc32c"}],
                "index_location": index_location}}]
        });
        s.inner
            .set(
                &AbsolutePath::new("/a/zarr.json").unwrap(),
                serde_json::to_vec(&meta).unwrap().into(),
            )
            .await
            .unwrap();
        // Inner chunk (0,0) holds 0,1. The bytes for (1,0) are stored but unreferenced.
        let c00: Vec<u8> = [0i16, 1].iter().flat_map(|v| v.to_le_bytes()).collect();
        let c10: Vec<u8> = [4i16, 5].iter().flat_map(|v| v.to_le_bytes()).collect();
        let index_len = 2 * 16 + 4; // 2 inner chunks (2x1) per shard
        let base = if index_location == "start" {
            index_len as u64
        } else {
            0
        };
        let entries = [base, 4, u64::MAX, u64::MAX]; // (0,0) stored, (1,0) missing
        let mut index: Vec<u8> = entries.iter().flat_map(|v| v.to_le_bytes()).collect();
        let mut crc = crc32c::crc32c(&index);
        if corrupt_crc {
            crc ^= 1;
        }
        index.extend_from_slice(&crc.to_le_bytes());
        let mut shard = Vec::new();
        if index_location == "start" {
            shard.extend_from_slice(&index);
        }
        shard.extend_from_slice(&c00);
        shard.extend_from_slice(&c10);
        if index_location == "end" {
            shard.extend_from_slice(&index);
        }
        s.inner
            .set(&AbsolutePath::new("/a/c/0/0").unwrap(), shard.into())
            .await
            .unwrap();
        s
    }

    async fn read(s: Counting) -> (Result<Vec<i16>>, usize, usize) {
        let s = std::sync::Arc::new(s);
        let loc = crate::Location::new(s.clone(), AbsolutePath::new("/a").unwrap());
        let out = match open_array(&loc).await {
            Ok(arr) => get::<i16, _>(&arr, &[], GetOptions::default())
                .await
                .map(|r| r.data),
            Err(e) => Err(e),
        };
        (
            out,
            s.gets.load(Ordering::Relaxed),
            s.ranges.load(Ordering::Relaxed),
        )
    }

    #[tokio::test]
    async fn reads_inner_chunks_by_range_with_fill_for_missing() {
        for loc in ["end", "start"] {
            let (data, gets, ranges) = read(store(loc, false).await).await;
            // Row 0: 0 1 (inner 0,0) | fill (shard c/0/1 missing)
            // Row 1: fill (inner 1,0 marked missing) | fill
            assert_eq!(
                data.unwrap(),
                vec![0, 1, -1, -1, -1, -1, -1, -1],
                "index_location {loc}"
            );
            assert_eq!(gets, 0, "no whole-shard reads");
            // One index read per shard (one of them missing), then one inner chunk.
            assert_eq!(ranges, 3, "index_location {loc}");
        }
    }

    #[tokio::test]
    async fn corrupt_shard_index_is_reported() {
        let (data, _, _) = read(store("end", true).await).await;
        let err = data.unwrap_err();
        let msg = format!("{err} {:?}", std::error::Error::source(&err));
        assert!(
            matches!(err, Error::CodecPipeline { .. }) && msg.contains("crc32c"),
            "{msg}"
        );
    }
}
