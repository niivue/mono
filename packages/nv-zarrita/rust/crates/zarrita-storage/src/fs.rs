use crate::{AbsolutePath, Bytes, Listable, RangeQuery, Readable, Result, Writable};
use std::io::{ErrorKind, SeekFrom};
use std::path::{Path, PathBuf};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

/// Local filesystem store. Port of `@zarrita/storage/fs`.
#[derive(Debug, Clone)]
pub struct FileSystemStore {
    root: PathBuf,
}

impl FileSystemStore {
    pub fn new(root: impl AsRef<Path>) -> Self {
        Self {
            root: root.as_ref().to_path_buf(),
        }
    }
    fn resolve(&self, key: &AbsolutePath) -> PathBuf {
        self.root.join(key.strip_prefix())
    }
    pub async fn has(&self, key: &AbsolutePath) -> bool {
        tokio::fs::try_exists(self.resolve(key))
            .await
            .unwrap_or(false)
    }
    pub async fn delete(&self, key: &AbsolutePath) -> Result<bool> {
        match tokio::fs::remove_file(self.resolve(key)).await {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e.into()),
        }
    }
}

fn not_found<T>(r: std::io::Result<T>) -> Result<Option<T>> {
    match r {
        Ok(v) => Ok(Some(v)),
        Err(e) if e.kind() == ErrorKind::NotFound || e.kind() == ErrorKind::NotADirectory => {
            Ok(None)
        }
        Err(e) => Err(e.into()),
    }
}

impl Readable for FileSystemStore {
    async fn get(&self, key: &AbsolutePath) -> Result<Option<Bytes>> {
        Ok(not_found(tokio::fs::read(self.resolve(key)).await)?.map(Bytes::from))
    }

    async fn get_range(&self, key: &AbsolutePath, range: RangeQuery) -> Result<Option<Bytes>> {
        let Some(mut f) = not_found(tokio::fs::File::open(self.resolve(key)).await)? else {
            return Ok(None);
        };
        let size = f.metadata().await?.len();
        let (start, end) = range.resolve(size);
        f.seek(SeekFrom::Start(start)).await?;
        let mut buf = vec![0u8; (end - start) as usize];
        f.read_exact(&mut buf).await?;
        Ok(Some(Bytes::from(buf)))
    }
}

impl Writable for FileSystemStore {
    async fn set(&self, key: &AbsolutePath, value: Bytes) -> Result<()> {
        let fp = self.resolve(key);
        if let Some(parent) = fp.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(fp, &value).await?;
        Ok(())
    }
}

impl Listable for FileSystemStore {
    async fn list(&self, prefix: &AbsolutePath) -> Result<Vec<AbsolutePath>> {
        let mut out = Vec::new();
        let mut stack = vec![self.resolve(prefix)];
        while let Some(dir) = stack.pop() {
            let Some(mut rd) = not_found(tokio::fs::read_dir(&dir).await)? else {
                continue;
            };
            while let Some(entry) = rd.next_entry().await? {
                let p = entry.path();
                if entry.file_type().await?.is_dir() {
                    stack.push(p);
                } else if let Ok(rel) = p.strip_prefix(&self.root) {
                    let s = rel
                        .to_string_lossy()
                        .replace(std::path::MAIN_SEPARATOR, "/");
                    out.push(AbsolutePath::new(format!("/{s}"))?);
                }
            }
        }
        out.sort();
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixtures() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures")
    }

    #[tokio::test]
    async fn reads_fixture_metadata() {
        let s = FileSystemStore::new(fixtures().join("v3/data.zarr"));
        let b = s
            .get(&AbsolutePath::new("/zarr.json").unwrap())
            .await
            .unwrap()
            .unwrap();
        assert!(std::str::from_utf8(&b).unwrap().contains("zarr_format"));
        assert!(
            s.get(&AbsolutePath::new("/nope.json").unwrap())
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn write_read_range() {
        let dir = std::env::temp_dir().join(format!("zarrita-rs-test-{}", std::process::id()));
        let s = FileSystemStore::new(&dir);
        let k = AbsolutePath::new("/x/y/c/0").unwrap();
        s.set(&k, Bytes::from_static(b"0123456789")).await.unwrap();
        let r = s
            .get_range(&k, RangeQuery::Suffix { suffix_length: 4 })
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&r[..], b"6789");
        assert_eq!(
            s.list(&AbsolutePath::root()).await.unwrap(),
            vec![k.clone()]
        );
        assert!(s.delete(&k).await.unwrap());
        let _ = std::fs::remove_dir_all(dir);
    }
}
