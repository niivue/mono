//! `crc32c` checksum codec (port of `codecs/crc32c.ts`).

use super::BytesToBytesCodec;
use crate::{Error, Result};
use bytes::Bytes;

pub struct Crc32cCodec;

impl BytesToBytesCodec for Crc32cCodec {
    fn encode(&self, b: Bytes) -> Result<Bytes> {
        let mut v = Vec::with_capacity(b.len() + 4);
        v.extend_from_slice(&b);
        v.extend_from_slice(&crc32c::crc32c(&b).to_le_bytes());
        Ok(v.into())
    }
    fn decode(&self, b: Bytes) -> Result<Bytes> {
        let n = b
            .len()
            .checked_sub(4)
            .ok_or_else(|| Error::Corrupt("crc32c: chunk too short".into()))?;
        let expected = u32::from_le_bytes(b[n..].try_into().unwrap());
        if crc32c::crc32c(&b[..n]) != expected {
            return Err(Error::Corrupt("crc32c checksum mismatch".into()));
        }
        Ok(b.slice(..n))
    }
}
