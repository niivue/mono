/// Translate cloud-storage URIs (`s3://`, `gs://`, `gcs://`) to HTTPS URLs.
/// Other URLs are returned unchanged. Port of TS `resolveUri`.
pub fn resolve_uri(url: &str) -> String {
    let Some(idx) = url.find("://") else {
        return url.to_string();
    };
    let host = match &url[..idx] {
        "gs" | "gcs" => "storage.googleapis.com",
        "s3" => "s3.amazonaws.com",
        _ => return url.to_string(),
    };
    format!("https://{host}/{}", &url[idx + 3..])
}

#[cfg(test)]
mod tests {
    #[test]
    fn uris() {
        assert_eq!(
            super::resolve_uri("s3://bucket/x.zarr"),
            "https://s3.amazonaws.com/bucket/x.zarr"
        );
        assert_eq!(
            super::resolve_uri("gs://b/x"),
            "https://storage.googleapis.com/b/x"
        );
        assert_eq!(super::resolve_uri("https://h/x"), "https://h/x");
    }
}
