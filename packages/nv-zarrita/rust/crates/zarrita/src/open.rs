//! `open` / `create` (ports of `open.ts`, `create.ts`).

use crate::hierarchy::{Array, Group, Location};
use crate::metadata::{
    ArrayMetadata, ArrayMetadataV2, Attributes, ChunkGrid, ChunkKeyEncoding,
    ChunkKeyEncodingConfig, ChunkKeyEncodingName, CodecMetadata, GroupMetadata, NodeMetadata,
    RegularChunkGridConfig, Separator,
};
use crate::util::v2_to_v3_array_metadata;
use crate::{Error, Readable, Result, Writable};
use serde_json::Value;

/// Either an array or a group.
#[derive(Debug)]
#[allow(clippy::large_enum_variant)]
pub enum Node<S> {
    Array(Array<S>),
    Group(Group<S>),
}

impl<S> Node<S> {
    pub fn into_array(self) -> Result<Array<S>> {
        match self {
            Node::Array(a) => Ok(a),
            Node::Group(g) => Err(Error::NotFound {
                context: "array".into(),
                path: Some(g.location.path.to_string()),
                found: Some(crate::error::NodeKind::Group),
            }),
        }
    }
    pub fn into_group(self) -> Result<Group<S>> {
        match self {
            Node::Group(g) => Ok(g),
            Node::Array(a) => Err(Error::NotFound {
                context: "group".into(),
                path: Some(a.location.path.to_string()),
                found: Some(crate::error::NodeKind::Array),
            }),
        }
    }
}

fn not_found(context: &str, path: &crate::AbsolutePath) -> Error {
    Error::NotFound {
        context: context.into(),
        path: Some(path.to_string()),
        found: None,
    }
}

/// Open a Zarr v3 node (`zarr.json`).
pub async fn open_v3<S: Readable>(location: &Location<S>) -> Result<Node<S>> {
    let meta_loc = location.resolve("zarr.json")?;
    let bytes = location
        .store
        .get(&meta_loc.path)
        .await?
        .ok_or_else(|| not_found("v3 array or group", &meta_loc.path))?;
    Ok(match NodeMetadata::from_json(&bytes)? {
        NodeMetadata::Array(m) => Node::Array(Array::new(location.clone(), m)?),
        NodeMetadata::Group(m) => Node::Group(Group {
            location: location.clone(),
            metadata: m,
        }),
    })
}

/// Open a Zarr v2 node (`.zarray` / `.zgroup` + `.zattrs`).
pub async fn open_v2<S: Readable>(location: &Location<S>) -> Result<Node<S>> {
    let attrs_loc = location.resolve(".zattrs")?;
    let zarray = location.resolve(".zarray")?;
    let zgroup = location.resolve(".zgroup")?;
    let (arr, attrs) = futures::join!(
        location.store.get(&zarray.path),
        location.store.get(&attrs_loc.path)
    );
    let attributes: Attributes = match attrs? {
        Some(b) => serde_json::from_slice(&b)?,
        None => Attributes::new(),
    };
    if let Some(b) = arr? {
        let meta: ArrayMetadataV2 = serde_json::from_slice(&b)?;
        return Ok(Node::Array(Array::new(
            location.clone(),
            v2_to_v3_array_metadata(&meta, attributes)?,
        )?));
    }
    if location.store.get(&zgroup.path).await?.is_some() {
        return Ok(Node::Group(Group {
            location: location.clone(),
            metadata: GroupMetadata {
                zarr_format: 3,
                node_type: "group".into(),
                attributes,
                consolidated_metadata: None,
            },
        }));
    }
    Err(not_found("v2 array or group", &location.path))
}

/// Open a node, trying v3 first and falling back to v2.
pub async fn open<S: Readable>(location: &Location<S>) -> Result<Node<S>> {
    match open_v3(location).await {
        Err(Error::NotFound { .. }) => open_v2(location).await,
        other => other,
    }
}

pub async fn open_array<S: Readable>(location: &Location<S>) -> Result<Array<S>> {
    open(location).await?.into_array()
}

pub async fn open_group<S: Readable>(location: &Location<S>) -> Result<Group<S>> {
    open(location).await?.into_group()
}

/// Options for [`create_array`] (TS `zarr.create(loc, {...})`).
#[derive(Debug, Clone)]
pub struct CreateArrayOptions {
    pub shape: Vec<u64>,
    pub chunk_shape: Vec<u64>,
    pub data_type: String,
    pub codecs: Vec<CodecMetadata>,
    pub fill_value: Value,
    pub chunk_separator: Separator,
    pub attributes: Attributes,
    pub dimension_names: Option<Vec<Option<String>>>,
}

impl CreateArrayOptions {
    pub fn new(shape: Vec<u64>, chunk_shape: Vec<u64>, data_type: impl Into<String>) -> Self {
        Self {
            shape,
            chunk_shape,
            data_type: data_type.into(),
            codecs: vec![],
            fill_value: Value::Null,
            chunk_separator: Separator::Slash,
            attributes: Attributes::new(),
            dimension_names: None,
        }
    }
    pub fn codecs(mut self, codecs: Vec<CodecMetadata>) -> Self {
        self.codecs = codecs;
        self
    }
    pub fn fill_value(mut self, v: Value) -> Self {
        self.fill_value = v;
        self
    }
}

/// Create a v3 array, writing its `zarr.json`.
pub async fn create_array<S: Writable>(
    location: &Location<S>,
    opts: CreateArrayOptions,
) -> Result<Array<S>> {
    let meta = ArrayMetadata {
        zarr_format: 3,
        node_type: "array".into(),
        shape: opts.shape,
        dimension_names: opts.dimension_names,
        data_type: opts.data_type,
        chunk_grid: ChunkGrid::Regular(RegularChunkGridConfig {
            chunk_shape: opts.chunk_shape,
        }),
        chunk_key_encoding: ChunkKeyEncoding {
            name: ChunkKeyEncodingName::Default,
            configuration: Some(ChunkKeyEncodingConfig {
                separator: Some(opts.chunk_separator),
            }),
        },
        codecs: opts.codecs,
        fill_value: opts.fill_value,
        attributes: opts.attributes,
        storage_transformers: vec![],
    };
    let arr = Array::new(location.clone(), meta)?;
    let path = location.resolve("zarr.json")?.path;
    location
        .store
        .set(&path, serde_json::to_vec_pretty(arr.metadata())?.into())
        .await?;
    Ok(arr)
}

/// Create a v3 group, writing its `zarr.json`.
pub async fn create_group<S: Writable>(
    location: &Location<S>,
    attributes: Attributes,
) -> Result<Group<S>> {
    let metadata = GroupMetadata {
        zarr_format: 3,
        node_type: "group".into(),
        attributes,
        consolidated_metadata: None,
    };
    let path = location.resolve("zarr.json")?.path;
    location
        .store
        .set(&path, serde_json::to_vec_pretty(&metadata)?.into())
        .await?;
    Ok(Group {
        location: location.clone(),
        metadata,
    })
}
