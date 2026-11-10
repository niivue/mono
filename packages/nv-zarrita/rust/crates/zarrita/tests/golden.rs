//! Compare full reads of every fixture array with zarrita.js output
//! (`tests/golden.json`, produced by `bench/js/golden.mjs`).

#![cfg(feature = "fs")]

use base64::Engine;
use serde_json::Value;
use std::path::PathBuf;
use zarrita::{DataType, FileSystemStore, GetOptions, NdArray, get, open_array, root};

async fn read_bytes(
    arr: &zarrita::Array<FileSystemStore>,
) -> zarrita::Result<(Vec<u8>, Vec<usize>)> {
    fn raw<T: bytemuck::Pod>(a: NdArray<T>) -> (Vec<u8>, Vec<usize>) {
        (bytemuck::cast_slice(&a.data).to_vec(), a.shape)
    }
    let o = GetOptions::default();
    Ok(match arr.dtype() {
        DataType::Int8 => raw(get::<i8, _>(arr, &[], o).await?),
        DataType::Int16 => raw(get::<i16, _>(arr, &[], o).await?),
        DataType::Int32 => raw(get::<i32, _>(arr, &[], o).await?),
        DataType::Int64 => raw(get::<i64, _>(arr, &[], o).await?),
        DataType::Uint8 => raw(get::<u8, _>(arr, &[], o).await?),
        DataType::Uint16 => raw(get::<u16, _>(arr, &[], o).await?),
        DataType::Uint32 => raw(get::<u32, _>(arr, &[], o).await?),
        DataType::Uint64 => raw(get::<u64, _>(arr, &[], o).await?),
        DataType::Float16 => raw(get::<half::f16, _>(arr, &[], o).await?),
        DataType::Float32 => raw(get::<f32, _>(arr, &[], o).await?),
        DataType::Float64 => raw(get::<f64, _>(arr, &[], o).await?),
        other => return Err(zarrita::Error::Unsupported(other.to_string())),
    })
}

#[tokio::test]
async fn matches_zarrita_js() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let fixtures = dir.join("../../../fixtures");
    let golden: Vec<Value> =
        serde_json::from_slice(&std::fs::read(dir.join("tests/golden.json")).unwrap()).unwrap();
    let (mut ok, mut unsupported, mut failures) = (0, vec![], vec![]);
    for g in golden.iter().filter(|g| g.get("data").is_some()) {
        let id = g["id"].as_str().unwrap();
        let (store_root, rel) = id.split_once(".zarr/").unwrap();
        let store = FileSystemStore::new(fixtures.join(format!("{store_root}.zarr")));
        let loc = root(store).resolve(rel).unwrap();
        let result = match open_array(&loc).await {
            Ok(arr) => read_bytes(&arr).await,
            Err(e) => Err(e),
        };
        match result {
            Ok((bytes, shape)) => {
                let want = base64::engine::general_purpose::STANDARD
                    .decode(g["data"].as_str().unwrap())
                    .unwrap();
                let want_shape: Vec<usize> = serde_json::from_value(g["shape"].clone()).unwrap();
                if bytes == want && shape == want_shape {
                    ok += 1;
                } else {
                    failures.push(format!(
                        "{id}: mismatch (shape {shape:?} vs {want_shape:?})"
                    ));
                }
            }
            Err(e @ (zarrita::Error::Unsupported(_) | zarrita::Error::UnknownCodec(_))) => {
                unsupported.push(format!("{id}: {e}"))
            }
            Err(e) => failures.push(format!("{id}: {e}")),
        }
    }
    eprintln!("matched {ok}; not yet supported {}:", unsupported.len());
    for u in &unsupported {
        eprintln!("  {u}");
    }
    assert!(failures.is_empty(), "failures:\n{}", failures.join("\n"));
    assert!(ok >= 30, "only {ok} arrays matched");
}
