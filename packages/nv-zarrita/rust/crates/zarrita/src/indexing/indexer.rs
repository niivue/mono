//! Port of `indexing/indexer.ts` and `sliceIndices` from `indexing/util.ts`.

use super::{DimSelection, Slice};
use crate::{Error, Result};

/// `(start, stop, step)` in element units (TS `Indices`).
pub type Indices = (i64, i64, i64);

/// How one dimension of a chunk maps to the output (TS `Projection`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Projection {
    /// Integer selection: a single chunk index, the dimension is dropped from the output.
    Int { from: usize },
    /// Slice selection: chunk range `from` maps to output range `to`.
    Slice { from: Indices, to: Indices },
}

#[derive(Debug, Clone)]
pub struct ChunkProjection {
    pub chunk_coords: Vec<usize>,
    pub mapping: Vec<Projection>,
}

/// Python `slice.indices(length)` (TS `sliceIndices`).
pub fn slice_indices(s: Slice, length: usize) -> Result<Indices> {
    let len = length as i64;
    let step = s.step.unwrap_or(1);
    if step == 0 {
        return Err(Error::InvalidSelection("slice step cannot be zero".into()));
    }
    let neg = step < 0;
    let (lower, upper) = if neg { (-1, len - 1) } else { (0, len) };
    let clamp = |v: Option<i64>, default: i64| match v {
        None => default,
        Some(mut x) if x < 0 => {
            x += len;
            x.max(lower)
        }
        Some(x) => x.min(upper),
    };
    Ok((
        clamp(s.start, if neg { upper } else { lower }),
        clamp(s.stop, if neg { lower } else { upper }),
        step,
    ))
}

#[derive(Debug, Clone)]
enum DimIndexer {
    Int {
        sel: usize,
        chunk_len: usize,
    },
    Slice {
        start: usize,
        stop: usize,
        step: usize,
        len: usize,
        chunk_len: usize,
        nitems: usize,
    },
}

impl DimIndexer {
    fn projections(&self) -> Vec<(usize, Projection)> {
        match *self {
            DimIndexer::Int { sel, chunk_len } => {
                let ix = sel / chunk_len;
                vec![(
                    ix,
                    Projection::Int {
                        from: sel - ix * chunk_len,
                    },
                )]
            }
            DimIndexer::Slice {
                start,
                stop,
                step,
                len,
                chunk_len,
                ..
            } => {
                let mut out = Vec::new();
                if stop <= start {
                    return out;
                }
                for ix in start / chunk_len..stop.div_ceil(chunk_len) {
                    let offset = ix * chunk_len;
                    let limit = len.min((ix + 1) * chunk_len);
                    let this_len = limit - offset;
                    let (sel_start, out_offset) = if start < offset {
                        let rem = (offset - start) % step;
                        (
                            if rem > 0 { step - rem } else { 0 },
                            (offset - start).div_ceil(step),
                        )
                    } else {
                        (start - offset, 0)
                    };
                    let sel_stop = if stop > limit {
                        this_len
                    } else {
                        stop - offset
                    };
                    if sel_start >= sel_stop {
                        continue;
                    }
                    let n = (sel_stop - sel_start).div_ceil(step);
                    out.push((
                        ix,
                        Projection::Slice {
                            from: (sel_start as i64, sel_stop as i64, step as i64),
                            to: (out_offset as i64, (out_offset + n) as i64, 1),
                        },
                    ));
                }
                out
            }
        }
    }
}

/// Iterates the chunks touched by a selection (TS `BasicIndexer`).
#[derive(Debug, Clone)]
pub struct BasicIndexer {
    dims: Vec<DimIndexer>,
    /// Output shape (integer-selected dimensions are dropped).
    pub shape: Vec<usize>,
}

impl BasicIndexer {
    pub fn new(selection: &[DimSelection], shape: &[usize], chunk_shape: &[usize]) -> Result<Self> {
        if selection.len() > shape.len() {
            return Err(Error::InvalidSelection(format!(
                "too many indicies for array; expected {}, got {}",
                shape.len(),
                selection.len()
            )));
        }
        let mut dims = Vec::with_capacity(shape.len());
        for (i, (&len, &chunk_len)) in shape.iter().zip(chunk_shape).enumerate() {
            let sel = selection.get(i).copied().unwrap_or(DimSelection::All);
            dims.push(match sel {
                DimSelection::Index(mut x) => {
                    if x < 0 {
                        x += len as i64;
                    }
                    if x < 0 || x >= len as i64 {
                        return Err(Error::InvalidSelection(format!(
                            "index out of bounds for dimension with length {len}"
                        )));
                    }
                    DimIndexer::Int {
                        sel: x as usize,
                        chunk_len,
                    }
                }
                DimSelection::All | DimSelection::Slice(_) => {
                    let s = if let DimSelection::Slice(s) = sel {
                        s
                    } else {
                        Slice::default()
                    };
                    let (start, stop, step) = slice_indices(s, len)?;
                    if step < 1 {
                        return Err(Error::InvalidSelection(
                            "only slices with step >= 1 are supported".into(),
                        ));
                    }
                    let nitems = if stop > start {
                        ((stop - start) as usize).div_ceil(step as usize)
                    } else {
                        0
                    };
                    DimIndexer::Slice {
                        start: start as usize,
                        stop: stop as usize,
                        step: step as usize,
                        len,
                        chunk_len,
                        nitems,
                    }
                }
            });
        }
        let shape = dims
            .iter()
            .filter_map(|d| {
                if let DimIndexer::Slice { nitems, .. } = d {
                    Some(*nitems)
                } else {
                    None
                }
            })
            .collect();
        Ok(Self { dims, shape })
    }

    /// Cartesian product of per-dimension projections (TS `product(...)`).
    pub fn iter(&self) -> impl Iterator<Item = ChunkProjection> + '_ {
        let per_dim: Vec<Vec<(usize, Projection)>> =
            self.dims.iter().map(DimIndexer::projections).collect();
        let empty = per_dim.iter().any(Vec::is_empty);
        let total: usize = if empty {
            0
        } else {
            per_dim.iter().map(Vec::len).product()
        };
        (0..total).map(move |mut n| {
            // Last dimension varies fastest.
            let rank = per_dim.len();
            let mut chunk_coords = vec![0; rank];
            let mut mapping = vec![Projection::Int { from: 0 }; rank];
            for d in (0..rank).rev() {
                let (ix, p) = per_dim[d][n % per_dim[d].len()];
                n /= per_dim[d].len();
                chunk_coords[d] = ix;
                mapping[d] = p;
            }
            ChunkProjection {
                chunk_coords,
                mapping,
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::indexing::slice;

    #[test]
    fn slice_indices_matches_python() {
        assert_eq!(slice_indices(slice(None, None), 10).unwrap(), (0, 10, 1));
        assert_eq!(slice_indices(slice(-3, None), 10).unwrap(), (7, 10, 1));
        assert_eq!(slice_indices(slice(2, 100), 10).unwrap(), (2, 10, 1));
        assert_eq!(slice_indices(slice(-100, -1), 10).unwrap(), (0, 9, 1));
    }

    #[test]
    fn chunk_iteration() {
        let ix = BasicIndexer::new(
            &[DimSelection::Slice(slice(3, 9)), DimSelection::Index(5)],
            &[10, 10],
            &[4, 4],
        )
        .unwrap();
        assert_eq!(ix.shape, vec![6]);
        let coords: Vec<_> = ix.iter().map(|p| p.chunk_coords).collect();
        assert_eq!(coords, vec![vec![0, 1], vec![1, 1], vec![2, 1]]);
    }
}
