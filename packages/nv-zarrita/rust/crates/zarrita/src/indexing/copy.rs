//! Strided chunk -> output copy (port of `setFromChunkBinary` in `indexing/ops.ts`).
//! Works on raw bytes with element offsets, and uses the same contiguous-span
//! fast path as the TS version at every recursion level.

use super::Projection;

fn indices_len(start: i64, stop: i64, step: i64) -> usize {
    if start < stop {
        ((stop - start - 1) / step + 1) as usize
    } else {
        0
    }
}

fn contiguous_span(
    projs: &[Projection],
    dstride: &[usize],
    sstride: &[usize],
) -> Option<(usize, usize, usize)> {
    if projs.len() != dstride.len() || projs.len() != sstride.len() {
        return None;
    }
    let (mut size, mut doff, mut soff) = (1usize, 0usize, 0usize);
    for i in (0..projs.len()).rev() {
        let Projection::Slice { from, to } = projs[i] else {
            return None;
        };
        if dstride[i] != size || sstride[i] != size || to.2 != 1 || from.2 != 1 {
            return None;
        }
        doff += size * to.0 as usize;
        soff += size * from.0 as usize;
        size *= indices_len(to.0, to.1, to.2);
    }
    Some((size, doff, soff))
}

/// Copy the projected part of `src` (offset `soff`, strides `sstride`) into
/// `dest` (offset `doff`, strides `dstride`). Offsets and strides are in elements.
#[allow(clippy::too_many_arguments)]
pub fn set_from_chunk(
    dest: &mut [u8],
    doff: usize,
    dstride: &[usize],
    src: &[u8],
    soff: usize,
    sstride: &[usize],
    es: usize,
    projs: &[Projection],
) {
    if let Some((size, d, s)) = contiguous_span(projs, dstride, sstride) {
        let (d, s) = ((doff + d) * es, (soff + s) * es);
        dest[d..d + size * es].copy_from_slice(&src[s..s + size * es]);
        return;
    }
    let Some((proj, projs)) = projs.split_first() else {
        let (d, s) = (doff * es, soff * es);
        dest[d..d + es].copy_from_slice(&src[s..s + es]);
        return;
    };
    match *proj {
        Projection::Int { from } => {
            // Dimension is dropped from the output: consume a src stride only.
            set_from_chunk(
                dest,
                doff,
                dstride,
                src,
                soff + sstride[0] * from,
                &sstride[1..],
                es,
                projs,
            );
        }
        Projection::Slice { from, to } => {
            let len = indices_len(to.0, to.1, to.2);
            let (ds, ss) = (dstride[0], sstride[0]);
            for i in 0..len {
                let di = doff + ds * (to.0 as usize + to.2 as usize * i);
                let si = soff + ss * (from.0 as usize + from.2 as usize * i);
                set_from_chunk(dest, di, &dstride[1..], src, si, &sstride[1..], es, projs);
            }
        }
    }
}
