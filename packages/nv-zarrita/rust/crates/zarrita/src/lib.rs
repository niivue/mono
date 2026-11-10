//! A minimal, modular Zarr implementation for Rust. Port of [zarrita.js](https://github.com/manzt/zarrita.js).
//!
//! ```no_run
//! # async fn demo() -> zarrita::Result<()> {
//! use zarrita::{FileSystemStore, GetOptions, root, open_array, get, slice};
//! let arr = open_array(&root(FileSystemStore::new("data.zarr"))).await?;
//! let region = get::<i16, _>(&arr, &[slice(0, 10).into(), (..).into()], GetOptions::default()).await?;
//! println!("{:?} {}", region.shape, region.data.len());
//! # Ok(()) }
//! ```
//!
//! See `PORTING.md` for what is and isn't ported yet.

pub mod codecs;
pub mod dtype;
pub mod error;
pub mod extension;
pub mod hierarchy;
pub mod indexing;
pub mod metadata;
pub mod open;
pub mod sharding;
pub mod util;

pub use dtype::DataType;
pub use error::{Error, Result};
pub use hierarchy::{Array, Group, Location, root};
#[cfg(feature = "parallel")]
pub use indexing::get_par;
pub use indexing::{DimSelection, Element, GetOptions, NdArray, Slice, get, slice};
pub use open::{
    CreateArrayOptions, Node, create_array, create_group, open, open_array, open_group, open_v2,
    open_v3,
};
pub use zarrita_storage as storage;
#[cfg(feature = "fetch")]
pub use zarrita_storage::FetchStore;
#[cfg(feature = "fs")]
pub use zarrita_storage::FileSystemStore;
pub use zarrita_storage::{
    AbsolutePath, Listable, MemoryStore, Mutable, RangeQuery, Readable, Writable,
};
