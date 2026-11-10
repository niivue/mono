use crate::{AbsolutePath, Bytes, RangeQuery, Readable, Result, StoreError};
use reqwest::{Client, StatusCode, header};
use url::Url;

/// Read-only HTTP store. Port of `@zarrita/storage/fetch`.
///
/// 404 maps to `Ok(None)`, 200/206 to bytes, anything else to an error.
#[derive(Debug, Clone)]
pub struct FetchStore {
    base: Url,
    client: Client,
    use_suffix_request: bool,
}

impl FetchStore {
    pub fn new(url: &str) -> Result<Self> {
        Self::with_client(url, Client::new())
    }

    pub fn with_client(url: &str, client: Client) -> Result<Self> {
        let mut base =
            Url::parse(&crate::resolve_uri(url)).map_err(|e| StoreError::Other(e.to_string()))?;
        if !base.path().ends_with('/') {
            let p = format!("{}/", base.path());
            base.set_path(&p);
        }
        Ok(Self {
            base,
            client,
            use_suffix_request: false,
        })
    }

    /// Send `Range: bytes=-N` for suffix requests instead of a HEAD + range request.
    pub fn use_suffix_request(mut self, yes: bool) -> Self {
        self.use_suffix_request = yes;
        self
    }

    fn resolve(&self, key: &AbsolutePath) -> Result<Url> {
        let mut u = self
            .base
            .join(key.strip_prefix())
            .map_err(|e| StoreError::Other(e.to_string()))?;
        u.set_query(self.base.query());
        Ok(u)
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Result<Option<Bytes>> {
        let resp = req
            .send()
            .await
            .map_err(|e| StoreError::Other(e.to_string()))?;
        match resp.status() {
            StatusCode::NOT_FOUND => Ok(None),
            StatusCode::OK | StatusCode::PARTIAL_CONTENT => Ok(Some(
                resp.bytes()
                    .await
                    .map_err(|e| StoreError::Other(e.to_string()))?,
            )),
            s => Err(StoreError::HttpStatus(s.as_u16())),
        }
    }
}

impl Readable for FetchStore {
    async fn get(&self, key: &AbsolutePath) -> Result<Option<Bytes>> {
        self.send(self.client.get(self.resolve(key)?)).await
    }

    async fn get_range(&self, key: &AbsolutePath, range: RangeQuery) -> Result<Option<Bytes>> {
        let url = self.resolve(key)?;
        let header_value = match range {
            RangeQuery::Range { offset, length } => {
                format!("bytes={}-{}", offset, offset + length - 1)
            }
            RangeQuery::Suffix { suffix_length } if self.use_suffix_request => {
                format!("bytes=-{suffix_length}")
            }
            RangeQuery::Suffix { suffix_length } => {
                let head = self
                    .client
                    .head(url.clone())
                    .send()
                    .await
                    .map_err(|e| StoreError::Other(e.to_string()))?;
                if head.status() == StatusCode::NOT_FOUND {
                    return Ok(None);
                }
                let len = head
                    .headers()
                    .get(header::CONTENT_LENGTH)
                    .and_then(|v| v.to_str().ok()?.parse::<u64>().ok())
                    .ok_or_else(|| StoreError::Other("missing Content-Length".into()))?;
                let start = len.saturating_sub(suffix_length);
                format!("bytes={}-{}", start, len - 1)
            }
        };
        self.send(self.client.get(url).header(header::RANGE, header_value))
            .await
    }
}
