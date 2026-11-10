use crate::{AbsolutePath, Bytes, Listable, Readable, Result, Writable};
use std::collections::BTreeMap;
use std::sync::RwLock;

/// In-memory store (TS uses a plain `Map<AbsolutePath, Uint8Array>`).
#[derive(Debug, Default)]
pub struct MemoryStore {
    map: RwLock<BTreeMap<AbsolutePath, Bytes>>,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn len(&self) -> usize {
        self.map.read().unwrap().len()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Readable for MemoryStore {
    async fn get(&self, key: &AbsolutePath) -> Result<Option<Bytes>> {
        Ok(self.map.read().unwrap().get(key).cloned())
    }
}

impl Writable for MemoryStore {
    async fn set(&self, key: &AbsolutePath, value: Bytes) -> Result<()> {
        self.map.write().unwrap().insert(key.clone(), value);
        Ok(())
    }
}

impl Listable for MemoryStore {
    async fn list(&self, prefix: &AbsolutePath) -> Result<Vec<AbsolutePath>> {
        let p = prefix.as_str();
        Ok(self
            .map
            .read()
            .unwrap()
            .keys()
            .filter(|k| k.as_str().starts_with(p))
            .cloned()
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::RangeQuery;

    #[tokio::test]
    async fn roundtrip_and_ranges() {
        let s = MemoryStore::new();
        let k = AbsolutePath::new("/a/b").unwrap();
        assert!(s.get(&k).await.unwrap().is_none());
        s.set(&k, Bytes::from_static(b"hello world")).await.unwrap();
        assert_eq!(&s.get(&k).await.unwrap().unwrap()[..], b"hello world");
        let r = s
            .get_range(
                &k,
                RangeQuery::Range {
                    offset: 6,
                    length: 5,
                },
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&r[..], b"world");
        let r = s
            .get_range(&k, RangeQuery::Suffix { suffix_length: 3 })
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&r[..], b"rld");
    }
}
