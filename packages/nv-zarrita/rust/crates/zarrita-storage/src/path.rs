use std::fmt;

/// A store key that always begins with `/` (TS `AbsolutePath`).
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct AbsolutePath(String);

impl AbsolutePath {
    pub const ROOT: &'static str = "/";

    pub fn new(s: impl Into<String>) -> crate::Result<Self> {
        let s = s.into();
        if !s.starts_with('/') {
            return Err(crate::StoreError::InvalidPath(s, "must start with '/'"));
        }
        if s.split('/').any(|seg| seg == "..") {
            return Err(crate::StoreError::InvalidPath(
                s,
                "'..' segments are not allowed",
            ));
        }
        Ok(Self(s))
    }

    pub fn root() -> Self {
        Self("/".into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The path without its leading `/` (TS `stripPrefix`).
    pub fn strip_prefix(&self) -> &str {
        &self.0[1..]
    }

    /// Join a relative segment, e.g. `/a` + `zarr.json` -> `/a/zarr.json`.
    pub fn join(&self, rel: &str) -> crate::Result<Self> {
        let rel = rel.trim_start_matches('/');
        if self.0.ends_with('/') {
            Self::new(format!("{}{}", self.0, rel))
        } else {
            Self::new(format!("{}/{}", self.0, rel))
        }
    }
}

impl fmt::Display for AbsolutePath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl fmt::Debug for AbsolutePath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}", self.0)
    }
}
impl TryFrom<&str> for AbsolutePath {
    type Error = crate::StoreError;
    fn try_from(s: &str) -> crate::Result<Self> {
        Self::new(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn join_and_strip() {
        let p = AbsolutePath::root()
            .join("a")
            .unwrap()
            .join("zarr.json")
            .unwrap();
        assert_eq!(p.as_str(), "/a/zarr.json");
        assert_eq!(p.strip_prefix(), "a/zarr.json");
        assert!(AbsolutePath::new("a").is_err());
        assert!(AbsolutePath::new("/a/../b").is_err());
    }
}
