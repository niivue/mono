//! Selection, slicing and chunk iteration (port of `indexing/*`).

mod copy;
mod indexer;

pub use indexer::{BasicIndexer, ChunkProjection, Projection};

use crate::dtype::DataType;
use crate::hierarchy::Array;
use crate::util::{c_order, get_strides};
use crate::{Error, Readable, Result};
use futures::stream::{self, StreamExt, TryStreamExt};

/// A Python-style slice (TS `zarr.slice`). `None` means "from the start/to the end".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Slice {
    pub start: Option<i64>,
    pub stop: Option<i64>,
    pub step: Option<i64>,
}

/// `slice(start, stop)`, e.g. `slice(10, 20)` or `slice(None, Some(-1))`.
pub fn slice(start: impl Into<Option<i64>>, stop: impl Into<Option<i64>>) -> Slice {
    Slice {
        start: start.into(),
        stop: stop.into(),
        step: None,
    }
}

/// One dimension of a selection: `null`, an integer, or a slice in TS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DimSelection {
    All,
    Index(i64),
    Slice(Slice),
}

impl From<i64> for DimSelection {
    fn from(i: i64) -> Self {
        DimSelection::Index(i)
    }
}
impl From<Slice> for DimSelection {
    fn from(s: Slice) -> Self {
        DimSelection::Slice(s)
    }
}
impl From<std::ops::Range<i64>> for DimSelection {
    fn from(r: std::ops::Range<i64>) -> Self {
        DimSelection::Slice(slice(r.start, r.end))
    }
}
impl From<std::ops::RangeFull> for DimSelection {
    fn from(_: std::ops::RangeFull) -> Self {
        DimSelection::All
    }
}

/// Plain-old-data element types that can be read out of an array.
pub trait Element: bytemuck::Pod + Send + Sync {
    fn matches(dtype: &DataType) -> bool;
}

macro_rules! element {
    ($t:ty, $($dt:pat),+) => {
        impl Element for $t {
            fn matches(dtype: &DataType) -> bool {
                matches!(dtype, $($dt)|+)
            }
        }
    };
}
element!(i8, DataType::Int8);
element!(i16, DataType::Int16);
element!(i32, DataType::Int32);
element!(i64, DataType::Int64);
element!(u8, DataType::Uint8, DataType::Bool, DataType::V2Bytes(_));
element!(u16, DataType::Uint16);
element!(u32, DataType::Uint32, DataType::V2Unicode(_));
element!(u64, DataType::Uint64);
element!(half::f16, DataType::Float16);
element!(f32, DataType::Float32);
element!(f64, DataType::Float64);

/// A strided n-dimensional result (TS `Chunk<D>`). Data is C-order.
#[derive(Debug, Clone, PartialEq)]
pub struct NdArray<T> {
    pub data: Vec<T>,
    pub shape: Vec<usize>,
    pub stride: Vec<usize>,
}

/// Options for [`get`].
#[derive(Debug, Clone, Copy)]
pub struct GetOptions {
    /// Max chunk requests in flight. TS starts all requests at once.
    pub concurrency: usize,
}

impl Default for GetOptions {
    fn default() -> Self {
        Self { concurrency: 64 }
    }
}

fn check_dtype<T: Element, S>(arr: &Array<S>) -> Result<()> {
    if !T::matches(arr.dtype()) || std::mem::size_of::<T>() != arr.elem_size() {
        return Err(Error::InvalidSelection(format!(
            "cannot read {} array as {}",
            arr.dtype(),
            std::any::type_name::<T>()
        )));
    }
    Ok(())
}

fn alloc_out<T: Element>(indexer: &BasicIndexer) -> NdArray<T> {
    let size: usize = indexer.shape.iter().product();
    let stride = get_strides(&indexer.shape, &c_order(indexer.shape.len()));
    NdArray {
        data: vec![T::zeroed(); size],
        shape: indexer.shape.clone(),
        stride,
    }
}

/// Read a selection into a new [`NdArray`] (TS `zarr.get`).
///
/// Chunk requests run concurrently (up to `opts.concurrency`); decoding and
/// copying happen on the calling task, matching zarrita.js's single-threaded model.
pub async fn get<T: Element, S: Readable>(
    arr: &Array<S>,
    selection: &[DimSelection],
    opts: GetOptions,
) -> Result<NdArray<T>> {
    check_dtype::<T, S>(arr)?;
    let indexer = BasicIndexer::new(selection, arr.shape(), arr.chunks())?;
    let mut out = alloc_out::<T>(&indexer);
    let es = arr.elem_size();
    let out_stride = out.stride.clone();
    let dest: &mut [u8] = bytemuck::cast_slice_mut(&mut out.data);
    let mut results = stream::iter(indexer.iter())
        .map(|p| async move {
            let bytes = arr.get_chunk_bytes(&p.chunk_coords).await?;
            Ok::<_, Error>((p, bytes))
        })
        .buffer_unordered(opts.concurrency.max(1));
    while let Some((p, bytes)) = results.try_next().await? {
        let chunk = arr.decode_chunk(bytes, None)?;
        copy::set_from_chunk(
            dest,
            0,
            &out_stride,
            &chunk.data,
            0,
            &chunk.stride,
            es,
            &p.mapping,
        );
    }
    Ok(out)
}

/// Like [`get`], but decodes and copies chunks in parallel on the rayon pool.
#[cfg(feature = "parallel")]
pub async fn get_par<T: Element, S: Readable>(
    arr: &Array<S>,
    selection: &[DimSelection],
    opts: GetOptions,
) -> Result<NdArray<T>> {
    use rayon::prelude::*;
    check_dtype::<T, S>(arr)?;
    let indexer = BasicIndexer::new(selection, arr.shape(), arr.chunks())?;
    let mut out = alloc_out::<T>(&indexer);
    let es = arr.elem_size();
    let fetched: Vec<_> = stream::iter(indexer.iter())
        .map(|p| async move {
            let bytes = arr.get_chunk_bytes(&p.chunk_coords).await?;
            Ok::<_, Error>((p, bytes))
        })
        .buffer_unordered(opts.concurrency.max(1))
        .try_collect()
        .await?;

    struct SyncPtr(*mut u8, usize);
    unsafe impl Sync for SyncPtr {}
    impl SyncPtr {
        /// SAFETY: callers must only write disjoint regions.
        #[allow(clippy::mut_from_ref)]
        unsafe fn slice(&self) -> &mut [u8] {
            unsafe { std::slice::from_raw_parts_mut(self.0, self.1) }
        }
    }
    let dest: &mut [u8] = bytemuck::cast_slice_mut(&mut out.data);
    let ptr = SyncPtr(dest.as_mut_ptr(), dest.len());
    let out_stride = &out.stride;
    fetched.into_par_iter().try_for_each(|(p, bytes)| {
        let chunk = arr.decode_chunk(bytes, None)?;
        // SAFETY: the indexer maps each chunk to a disjoint region of `out`, so
        // concurrent writers never touch the same bytes.
        let dest = unsafe { ptr.slice() };
        copy::set_from_chunk(
            dest,
            0,
            out_stride,
            &chunk.data,
            0,
            &chunk.stride,
            es,
            &p.mapping,
        );
        Ok::<_, Error>(())
    })?;
    Ok(out)
}

/// Fill every element of a selection with the array's fill value; used by tests.
#[doc(hidden)]
pub fn _fill_bytes<S>(arr: &Array<S>) -> &[u8] {
    arr.fill_bytes()
}
