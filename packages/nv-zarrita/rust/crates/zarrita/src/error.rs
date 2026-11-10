//! Port of `errors.ts`. The TS `_tag`-discriminated classes become enum variants.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKind {
    Array,
    Group,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Encode,
    Decode,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Not found: {context}")]
    NotFound {
        context: String,
        path: Option<String>,
        found: Option<NodeKind>,
    },

    #[error("{message}")]
    InvalidMetadata {
        message: String,
        path: Option<String>,
        #[source]
        source: Option<Box<dyn std::error::Error + Send + Sync>>,
    },

    #[error("Unknown codec: {0}")]
    UnknownCodec(String),

    #[error("Failed to {} chunk{}{}",
        match direction { Direction::Encode => "encode", Direction::Decode => "decode" },
        codec.as_ref().map(|c| format!(" via codec \"{c}\"")).unwrap_or_default(),
        chunk_path.as_ref().map(|p| format!(" at {p}")).unwrap_or_default())]
    CodecPipeline {
        direction: Direction,
        codec: Option<String>,
        chunk_path: Option<String>,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },

    #[error("{0}")]
    InvalidSelection(String),

    #[error("Unsupported: {0}")]
    Unsupported(String),

    #[error(transparent)]
    Store(#[from] zarrita_storage::StoreError),
}

impl Error {
    pub fn invalid_metadata(message: impl Into<String>) -> Self {
        Error::InvalidMetadata {
            message: message.into(),
            path: None,
            source: None,
        }
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::InvalidMetadata {
            message: e.to_string(),
            path: None,
            source: Some(Box::new(e)),
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;
