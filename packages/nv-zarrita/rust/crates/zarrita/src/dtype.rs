//! Zarr data types (port of the `DataType` union in `metadata.ts` plus the
//! v2 dtype parsing in `util.ts`).

use crate::{Error, Result};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Endian {
    Little,
    Big,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum DataType {
    Bool,
    Int8,
    Int16,
    Int32,
    Int64,
    Uint8,
    Uint16,
    Uint32,
    Uint64,
    Float16,
    Float32,
    Float64,
    /// v3 variable-length UTF-8 `"string"`.
    String,
    /// v2 fixed-width UTF-32 string `U<n>` (n characters).
    V2Unicode(usize),
    /// v2 fixed-width byte string `S<n>`.
    V2Bytes(usize),
    /// v2 `|O` object (typically vlen-utf8).
    V2Object,
}

impl DataType {
    /// Parse a v3 `data_type` string.
    pub fn from_v3(s: &str) -> Result<Self> {
        use DataType::*;
        Ok(match s {
            "bool" => Bool,
            "int8" => Int8,
            "int16" => Int16,
            "int32" => Int32,
            "int64" => Int64,
            "uint8" => Uint8,
            "uint16" => Uint16,
            "uint32" => Uint32,
            "uint64" => Uint64,
            "float16" => Float16,
            "float32" => Float32,
            "float64" => Float64,
            "string" => String,
            other => return Err(Error::Unsupported(format!("data_type {other:?}"))),
        })
    }

    /// Parse a v2 numpy-style `dtype` string (e.g. `<i2`, `|b1`, `>U13`, `|O`).
    /// Returns the data type and its endianness (if relevant).
    pub fn from_v2(s: &str) -> Result<(Self, Option<Endian>)> {
        use DataType::*;
        // A few v2 writers emit v3-style names.
        if let Ok(dt) = Self::from_v3(s) {
            return Ok((dt, Some(Endian::Little)));
        }
        let (endian, rest) = match s.as_bytes().first() {
            Some(b'<') => (Some(Endian::Little), &s[1..]),
            Some(b'>') => (Some(Endian::Big), &s[1..]),
            Some(b'|') => (None, &s[1..]),
            _ => (Some(Endian::Little), s),
        };
        let bad = || Error::Unsupported(format!("v2 dtype {s:?}"));
        let (kind, size) = rest.split_at(1);
        let n: usize = if size.is_empty() {
            0
        } else {
            size.parse().map_err(|_| bad())?
        };
        let dt = match (kind, n) {
            ("b", 1) => Bool,
            ("i", 1) => Int8,
            ("i", 2) => Int16,
            ("i", 4) => Int32,
            ("i", 8) => Int64,
            ("u", 1) => Uint8,
            ("u", 2) => Uint16,
            ("u", 4) => Uint32,
            ("u", 8) => Uint64,
            ("f", 2) => Float16,
            ("f", 4) => Float32,
            ("f", 8) => Float64,
            ("U", n) => V2Unicode(n),
            ("S", n) => V2Bytes(n),
            ("O", 0) => V2Object,
            _ => return Err(bad()),
        };
        let endian = if dt.byte_size().is_some_and(|b| b > 1) || matches!(dt, V2Unicode(_)) {
            endian
        } else {
            None
        };
        Ok((dt, endian))
    }

    /// Size in bytes of one element, or `None` for variable-length types.
    pub fn byte_size(&self) -> Option<usize> {
        use DataType::*;
        Some(match self {
            Bool | Int8 | Uint8 => 1,
            Int16 | Uint16 | Float16 => 2,
            Int32 | Uint32 | Float32 => 4,
            Int64 | Uint64 | Float64 => 8,
            V2Unicode(n) => 4 * n,
            V2Bytes(n) => *n,
            String | V2Object => return None,
        })
    }
}

impl fmt::Display for DataType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        use DataType::*;
        match self {
            Bool => f.write_str("bool"),
            Int8 => f.write_str("int8"),
            Int16 => f.write_str("int16"),
            Int32 => f.write_str("int32"),
            Int64 => f.write_str("int64"),
            Uint8 => f.write_str("uint8"),
            Uint16 => f.write_str("uint16"),
            Uint32 => f.write_str("uint32"),
            Uint64 => f.write_str("uint64"),
            Float16 => f.write_str("float16"),
            Float32 => f.write_str("float32"),
            Float64 => f.write_str("float64"),
            String => f.write_str("string"),
            V2Unicode(n) => write!(f, "v2:U{n}"),
            V2Bytes(n) => write!(f, "v2:S{n}"),
            V2Object => f.write_str("v2:object"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parse_v2() {
        assert_eq!(
            DataType::from_v2("<i2").unwrap(),
            (DataType::Int16, Some(Endian::Little))
        );
        assert_eq!(
            DataType::from_v2(">f4").unwrap(),
            (DataType::Float32, Some(Endian::Big))
        );
        assert_eq!(DataType::from_v2("|b1").unwrap(), (DataType::Bool, None));
        assert_eq!(
            DataType::from_v2(">U13").unwrap(),
            (DataType::V2Unicode(13), Some(Endian::Big))
        );
        assert_eq!(
            DataType::from_v2("|S7").unwrap(),
            (DataType::V2Bytes(7), None)
        );
        assert_eq!(DataType::from_v2("|O").unwrap(), (DataType::V2Object, None));
        assert_eq!(DataType::from_v2("int32").unwrap().0, DataType::Int32);
        assert!(DataType::from_v2("<c16").is_err());
    }
}
