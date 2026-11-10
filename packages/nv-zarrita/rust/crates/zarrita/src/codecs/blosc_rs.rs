//! Pure-Rust Blosc1 decompressor, used where c-blosc can't be built (WebAssembly).
//!
//! Follows c-blosc 1.x `blosc_d`: 16-byte header, per-block offsets, optional
//! per-byte "splits", then byte- or bit-unshuffle. Supports the blosclz, lz4,
//! zlib and zstd compressors (snappy is not supported).

use crate::{Error, Result};

const MAX_SPLITS: usize = 16;
const MIN_BUFFERSIZE: usize = 128;
const DOSHUFFLE: u8 = 0x1;
const MEMCPYED: u8 = 0x2;
const DOBITSHUFFLE: u8 = 0x4;
const DONT_SPLIT: u8 = 0x10;
const HEADER: usize = 16;

fn err(msg: impl Into<String>) -> Error {
    Error::Unsupported(format!("blosc: {}", msg.into()))
}

fn u32le(b: &[u8], at: usize) -> Result<usize> {
    b.get(at..at + 4)
        .map(|s| u32::from_le_bytes(s.try_into().unwrap()) as usize)
        .ok_or_else(|| err("truncated buffer"))
}

/// Uncompressed size recorded in a Blosc header.
pub fn decompressed_size(src: &[u8]) -> Result<usize> {
    u32le(src, 4)
}

pub fn decompress(src: &[u8]) -> Result<Vec<u8>> {
    if src.len() < HEADER {
        return Err(err("buffer shorter than header"));
    }
    let flags = src[2];
    let typesize = src[3] as usize;
    let nbytes = u32le(src, 4)?;
    let blocksize = u32le(src, 8)?;
    let cbytes = u32le(src, 12)?;
    if cbytes > src.len() {
        return Err(err("cbytes larger than buffer"));
    }
    let src = &src[..cbytes];
    let mut out = vec![0u8; nbytes];
    if nbytes == 0 {
        return Ok(out);
    }
    if flags & MEMCPYED != 0 {
        let body = src
            .get(HEADER..HEADER + nbytes)
            .ok_or_else(|| err("truncated memcpyed buffer"))?;
        out.copy_from_slice(body);
        return Ok(out);
    }
    if blocksize == 0 || typesize == 0 {
        return Err(err("invalid header"));
    }
    let compformat = (flags & 0xe0) >> 5;
    let leftover = nbytes % blocksize;
    let nblocks = nbytes / blocksize + usize::from(leftover > 0);
    let doshuffle = flags & DOSHUFFLE != 0 && typesize > 1;
    let mut tmp = vec![0u8; blocksize];
    for j in 0..nblocks {
        let is_leftover = j == nblocks - 1 && leftover > 0;
        let bsize = if is_leftover { leftover } else { blocksize };
        let dobitshuffle = flags & DOBITSHUFFLE != 0 && bsize >= typesize;
        let start = u32le(src, HEADER + 4 * j)?;
        let dest = &mut out[j * blocksize..j * blocksize + bsize];
        let staged: &mut [u8] = if doshuffle || dobitshuffle {
            &mut tmp[..bsize]
        } else {
            dest
        };
        decompress_block(src, start, staged, flags, typesize, compformat, is_leftover)?;
        if doshuffle {
            unshuffle(
                typesize,
                &tmp[..bsize],
                &mut out[j * blocksize..j * blocksize + bsize],
            );
        } else if dobitshuffle {
            bitunshuffle(
                typesize,
                &tmp[..bsize],
                &mut out[j * blocksize..j * blocksize + bsize],
            );
        }
    }
    Ok(out)
}

fn decompress_block(
    src: &[u8],
    mut off: usize,
    out: &mut [u8],
    flags: u8,
    typesize: usize,
    compformat: u8,
    is_leftover: bool,
) -> Result<()> {
    let bsize = out.len();
    let split = flags & DONT_SPLIT == 0
        && typesize <= MAX_SPLITS
        && bsize / typesize >= MIN_BUFFERSIZE
        && !is_leftover;
    let nsplits = if split { typesize } else { 1 };
    let neblock = bsize / nsplits;
    for s in 0..nsplits {
        let cb = u32le(src, off)?;
        off += 4;
        let input = src
            .get(off..off + cb)
            .ok_or_else(|| err("split exceeds buffer"))?;
        let dst = &mut out[s * neblock..(s + 1) * neblock];
        if cb == neblock {
            dst.copy_from_slice(input);
        } else {
            let n =
                match compformat {
                    0 => blosclz_decompress(input, dst)?,
                    1 => lz4_flex::block::decompress_into(input, dst)
                        .map_err(|e| err(e.to_string()))?,
                    3 => {
                        let mut d = flate2::Decompress::new(true);
                        d.decompress(input, dst, flate2::FlushDecompress::Finish)
                            .map_err(|e| err(e.to_string()))?;
                        d.total_out() as usize
                    }
                    4 => zstd::bulk::decompress_to_buffer(input, dst)
                        .map_err(|e| err(e.to_string()))?,
                    2 => return Err(err("snappy is not supported")),
                    other => return Err(err(format!("unknown compressor code {other}"))),
                };
            if n != neblock {
                return Err(err(format!(
                    "split decompressed to {n} bytes, expected {neblock}"
                )));
            }
        }
        off += cb;
    }
    Ok(())
}

/// Byte unshuffle (c-blosc `unshuffle_generic`).
fn unshuffle(typesize: usize, src: &[u8], dst: &mut [u8]) {
    let n = src.len() / typesize;
    let body = n * typesize;
    match typesize {
        // Specialized loops let the compiler vectorize the common cases.
        2 => {
            let (a, b) = src[..body].split_at(n);
            for (i, d) in dst[..body].chunks_exact_mut(2).enumerate() {
                d[0] = a[i];
                d[1] = b[i];
            }
        }
        4 => {
            let (p, q) = (&src[..n], &src[n..2 * n]);
            let (r, s) = (&src[2 * n..3 * n], &src[3 * n..4 * n]);
            for (i, d) in dst[..body].chunks_exact_mut(4).enumerate() {
                d[0] = p[i];
                d[1] = q[i];
                d[2] = r[i];
                d[3] = s[i];
            }
        }
        _ => {
            for byte in 0..typesize {
                let plane = &src[byte * n..(byte + 1) * n];
                for (i, &v) in plane.iter().enumerate() {
                    dst[i * typesize + byte] = v;
                }
            }
        }
    }
    dst[body..].copy_from_slice(&src[body..]);
}

/// Bit unshuffle (bitshuffle's `untrans_bit_elem`). Only whole groups of 8
/// elements are bit-shuffled; trailing bytes are stored as is.
fn bitunshuffle(typesize: usize, src: &[u8], dst: &mut [u8]) {
    let size = src.len() / typesize;
    if size % 8 != 0 {
        dst.copy_from_slice(src);
        return;
    }
    let nrow = size / 8; // bytes per bit plane
    dst[..size * typesize].fill(0);
    for j in 0..typesize {
        for k in 0..8 {
            let plane = &src[(j * 8 + k) * nrow..(j * 8 + k + 1) * nrow];
            for (b, &byte) in plane.iter().enumerate() {
                if byte == 0 {
                    continue;
                }
                for bit in 0..8 {
                    if byte >> bit & 1 == 1 {
                        dst[(b * 8 + bit) * typesize + j] |= 1 << k;
                    }
                }
            }
        }
    }
    let off = size * typesize;
    dst[off..].copy_from_slice(&src[off..]);
}

/// BloscLZ decompressor (port of `blosclz_decompress`).
fn blosclz_decompress(input: &[u8], out: &mut [u8]) -> Result<usize> {
    const MAX_DISTANCE: usize = 8191;
    let bad = || err("corrupt blosclz stream");
    if input.is_empty() {
        return Ok(0);
    }
    let (mut ip, mut op) = (1usize, 0usize);
    let mut ctrl = (input[0] & 31) as usize;
    loop {
        if ctrl >= 32 {
            let mut len = (ctrl >> 5) - 1;
            let mut ofs = (ctrl & 31) << 8;
            if len == 6 {
                loop {
                    let code = *input.get(ip).ok_or_else(bad)?;
                    ip += 1;
                    len += code as usize;
                    if code != 255 {
                        break;
                    }
                }
            }
            let code = *input.get(ip).ok_or_else(bad)? as usize;
            ip += 1;
            len += 3;
            // `ref = op - ofs - code`, then `ref--` below.
            let mut back = ofs + code;
            if code == 255 && ofs == 31 << 8 {
                ofs = ((*input.get(ip).ok_or_else(bad)? as usize) << 8)
                    + *input.get(ip + 1).ok_or_else(bad)? as usize;
                ip += 2;
                back = ofs + MAX_DISTANCE;
            }
            back += 1;
            if op + len > out.len() || back > op {
                return Err(bad());
            }
            let r = op - back;
            if back == 1 {
                let v = out[r];
                out[op..op + len].fill(v);
            } else if back >= len {
                out.copy_within(r..r + len, op);
            } else {
                for i in 0..len {
                    out[op + i] = out[r + i];
                }
            }
            op += len;
            if ip >= input.len() {
                break;
            }
            ctrl = input[ip] as usize;
            ip += 1;
        } else {
            let n = ctrl + 1;
            if op + n > out.len() || ip + n > input.len() {
                return Err(bad());
            }
            out[op..op + n].copy_from_slice(&input[ip..ip + n]);
            op += n;
            ip += n;
            if ip >= input.len() {
                break;
            }
            ctrl = input[ip] as usize;
            ip += 1;
        }
    }
    Ok(op)
}

#[cfg(all(test, feature = "native-blosc"))]
mod tests {
    use std::ffi::{CString, c_void};

    fn c_compress(
        data: &[u8],
        typesize: usize,
        cname: &str,
        shuffle: i32,
        clevel: i32,
        blocksize: usize,
    ) -> Vec<u8> {
        let mut out = vec![0u8; data.len() + blosc_src::BLOSC_MAX_OVERHEAD as usize];
        let cname = CString::new(cname).unwrap();
        let n = unsafe {
            blosc_src::blosc_compress_ctx(
                clevel,
                shuffle,
                typesize,
                data.len(),
                data.as_ptr() as *const c_void,
                out.as_mut_ptr() as *mut c_void,
                out.len(),
                cname.as_ptr(),
                blocksize,
                1,
            )
        };
        assert!(n > 0, "c-blosc compress failed");
        out.truncate(n as usize);
        out
    }

    /// Compress with c-blosc, decompress with the Rust port, across compressors,
    /// shuffles, type sizes, odd lengths and forced small blocks.
    #[test]
    fn matches_c_blosc() {
        let mut seed = 7u64;
        let mut next = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            (seed >> 33) as u32
        };
        let mut cases = 0;
        for &len in &[0usize, 1, 7, 100, 1000, 4096, 65_537, 300_001] {
            // Smooth-ish data with noise so every compressor emits real matches.
            let data: Vec<u8> = (0..len)
                .map(|i| ((i / 7) as u32 ^ (next() % 4)) as u8)
                .collect();
            for &typesize in &[1usize, 2, 4, 8, 3, 16] {
                for &shuffle in &[0, 1, 2] {
                    for cname in ["blosclz", "lz4", "lz4hc", "zlib", "zstd"] {
                        for &blocksize in &[0usize, 256] {
                            for &clevel in &[0, 1, 5, 9] {
                                let c =
                                    c_compress(&data, typesize, cname, shuffle, clevel, blocksize);
                                let d = super::decompress(&c).unwrap_or_else(|e| {
                                    panic!("{cname} ts={typesize} sh={shuffle} len={len} bs={blocksize} cl={clevel}: {e}")
                                });
                                assert!(
                                    d == data,
                                    "{cname} ts={typesize} sh={shuffle} len={len} bs={blocksize} cl={clevel}: mismatch"
                                );
                                cases += 1;
                            }
                        }
                    }
                }
            }
        }
        assert!(cases > 1000);
    }
}
