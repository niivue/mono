//! Storage backends for zarrita-rs. Port of `@zarrita/storage`.
//!
//! The TS package distinguishes sync and async stores; in Rust every store
//! implements the async traits below. Synchronous backends (e.g. [`MemoryStore`])
//! simply return ready futures.

#[cfg(feature = "fetch")]
mod fetch;
#[cfg(feature = "fs")]
mod fs;
mod memory;
mod path;
mod util;

#[cfg(feature = "fetch")]
pub use fetch::FetchStore;
#[cfg(feature = "fs")]
pub use fs::FileSystemStore;
pub use memory::MemoryStore;
pub use path::AbsolutePath;
pub use util::resolve_uri;

pub use bytes::Bytes;
use std::future::Future;

/// Errors raised by stores. A missing key is *not* an error: `get` returns `Ok(None)`.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid path {0:?}: {1}")]
    InvalidPath(String, &'static str),
    #[error("unexpected response status {0}")]
    HttpStatus(u16),
    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, StoreError>;

/// Byte range request (mirrors TS `RangeQuery`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeQuery {
    /// `length` bytes starting at `offset`.
    Range { offset: u64, length: u64 },
    /// The last `suffix_length` bytes.
    Suffix { suffix_length: u64 },
}

impl RangeQuery {
    /// Resolve to a concrete `[start, end)` given the total object size.
    pub fn resolve(&self, size: u64) -> (u64, u64) {
        match *self {
            RangeQuery::Range { offset, length } => {
                let start = offset.min(size);
                (start, (offset + length).min(size))
            }
            RangeQuery::Suffix { suffix_length } => (size.saturating_sub(suffix_length), size),
        }
    }
}

/// A readable key/value store (TS `AsyncReadable`).
pub trait Readable: Send + Sync {
    fn get(&self, key: &AbsolutePath) -> impl Future<Output = Result<Option<Bytes>>> + Send;

    /// Read a byte range. The default implementation reads the whole value and slices it.
    fn get_range(
        &self,
        key: &AbsolutePath,
        range: RangeQuery,
    ) -> impl Future<Output = Result<Option<Bytes>>> + Send {
        async move {
            Ok(self.get(key).await?.map(|b| {
                let (s, e) = range.resolve(b.len() as u64);
                b.slice(s as usize..e as usize)
            }))
        }
    }
}

/// A writable key/value store (TS `AsyncWritable`).
pub trait Writable: Send + Sync {
    fn set(&self, key: &AbsolutePath, value: Bytes) -> impl Future<Output = Result<()>> + Send;
}

/// Readable + writable (TS `AsyncMutable`).
pub trait Mutable: Readable + Writable {}
impl<T: Readable + Writable> Mutable for T {}

/// Stores that can enumerate their keys (needed for consolidation / hierarchy walks).
pub trait Listable: Send + Sync {
    fn list(&self, prefix: &AbsolutePath)
    -> impl Future<Output = Result<Vec<AbsolutePath>>> + Send;
}
