# Provenance & dataset transfer — design note

**Decision (2026-07-07): align with the accepted neuroimaging provenance stack
rather than roll our own hash-chain / changelog format.**

The use case — "a researcher hands someone a dataset, they run a process on it,
results sync back with a record of what happened" — is exactly what
[DataLad](https://www.datalad.org/) (`datalad run`/`rerun`) plus
[W3C PROV](https://www.w3.org/TR/prov-overview/) →
[NIDM](http://nidm.nidash.org/) →
[BEP028 "BIDS-prov"](https://github.com/bids-standard/BEP028_BIDSprov) and
[BIDS-Derivatives `GeneratedBy`](https://bids-specification.readthedocs.io/) were
built for. Our existing "content-hash integrity + append-only changelog" and
"assign → work-offline → resync" items reinvent pieces of these. So NeuroVue
should **emit and interoperate with these standards**, not invent a proprietary
schema.

## The one hard constraint: no git-annex on iOS

DataLad = git + git-annex (subprocesses + free filesystem access) — a non-starter
on iOS (see `AGENTS.md`). So we do **not** embed DataLad as the engine. Instead we
make the `.nvbundle` carry **standards-shaped metadata** (SHA-256 identity,
PROV-JSON activities, BIDS `GeneratedBy`) so it round-trips with DataLad/BIDS
tooling **without depending on it**, and works on mobile. A desktop-only
import/export adapter for real DataLad datasets can come later.

## Identity

SHA-256 content hash — already computed per data file in the bundle
(`sha256_file` in `volumetric_server.rs`). This is the same identity git-annex
uses, so bundle files are addressable/interoperable. It replaces the
non-cryptographic `file_content_hash` (`DefaultHasher`) for integrity use; keep
`id` as the single dataset-facing identity.

## `.nvbundle` manifest, provenance-aware

Extends the current manifest (`source` / `volumes` / `view`) with two additions:
per-volume **`generatedBy`** (BIDS-Derivatives shape) and a bundle-level
**`provenance`** block (PROV-JSON).

```jsonc
{
  "nvbundle": "2",
  "createdAt": "2026-07-07T18:20:00Z",
  "tool": { "name": "NeuroVue", "version": "0.1.0" },

  "source": {
    "datasetName": "ds000001",
    "datasetDoi": "10.18112/openneuro.ds000001.v1.0.0",
    // BIDS derivative provenance for the dataset as a whole:
    "GeneratedBy": [{ "Name": "NeuroVue", "Version": "0.1.0" }],
    "SourceDatasets": [{ "DOI": "10.18112/openneuro.ds000001.v1.0.0" }]
  },

  "volumes": [
    { "id": "sub-01_T1w", "role": "base",
      "data": "data/sub-01_T1w.nii.gz", "sha256": "9f2c…", "bytes": 4194304 },

    { "id": "sub-01_T1w_smooth", "role": "derived",
      "data": "data/sub-01_T1w_smooth.nii.gz", "sha256": "b71a…", "bytes": 4210688,
      // BIDS-Derivatives GeneratedBy — the human/tool-readable derivation record:
      "generatedBy": [{
        "Name": "niimath", "Version": "1.0.0",
        "Description": "Gaussian smoothing, sigma 2 mm",
        "CodeURL": "https://github.com/rordenlab/niimath",
        "Command": "niimath sub-01_T1w.nii.gz -s 2 sub-01_T1w_smooth.nii.gz"
      }],
      "sourceSha256": ["9f2c…"]
    }
  ],

  // W3C PROV-JSON: the machine-actionable record. One activity per tracked op.
  "provenance": {
    "prefix": { "nv": "https://neurovue.org/prov#" },
    "entity": {
      "nv:sha256/9f2c…": { "prov:type": "nv:Volume", "nv:role": "base",  "nv:path": "data/sub-01_T1w.nii.gz" },
      "nv:sha256/b71a…": { "prov:type": "nv:Volume", "nv:role": "derived","nv:path": "data/sub-01_T1w_smooth.nii.gz" }
    },
    "agent": {
      "nv:person/jane": { "prov:type": "prov:Person",        "foaf:name": "Jane Smith", "foaf:mbox": "jane@…" },
      "nv:soft/niimath-1.0.0": { "prov:type": "prov:SoftwareAgent", "nv:name": "niimath", "nv:version": "1.0.0" }
    },
    "activity": {
      "nv:act/018f…": {
        "prov:type": "nv:Operation",
        "prov:startTime": "2026-07-07T18:19:41Z",
        "prov:endTime":   "2026-07-07T18:19:43Z",
        "nv:argv": ["niimath","sub-01_T1w.nii.gz","-s","2","sub-01_T1w_smooth.nii.gz"],
        "nv:exitCode": 0
      }
    },
    "used":              { "_:u1": { "prov:activity": "nv:act/018f…", "prov:entity": "nv:sha256/9f2c…" } },
    "wasGeneratedBy":    { "_:g1": { "prov:entity": "nv:sha256/b71a…", "prov:activity": "nv:act/018f…" } },
    "wasAssociatedWith": {
      "_:a1": { "prov:activity": "nv:act/018f…", "prov:agent": "nv:soft/niimath-1.0.0" },
      "_:a2": { "prov:activity": "nv:act/018f…", "prov:agent": "nv:person/jane" }
    }
  }
}
```

Notes:
- `generatedBy` (BIDS) and the PROV `activity` describe the **same** event at two
  altitudes — BIDS for tools/humans that read derivatives, PROV for
  machine-actionable re-computation. Emit both; they're cheap.
- Entities are keyed by SHA-256, so PROV `used`/`wasGeneratedBy` edges are
  content-addressed — the DataLad `run`-record idea, in PROV form.

## Dataset-level changelog (tamper-evident)

Generalize the current per-session `provenance.jsonl` (`persist_correction_patch`,
NeuroFlow-gated, `action: "correction.save"`) into an **append-only, hash-chained**
dataset log where each entry is a PROV activity:

```jsonc
{ "entry": 7,
  "parent": "e3b0c442…",          // SHA-256 of entry 6's canonical bytes
  "ts": "2026-07-07T18:19:43Z",
  "agent": "nv:person/jane",
  "activity": { /* PROV activity as above */ },
  "payloadSha256": "b71a…" }      // hash of the artifact this entry is about
```

Append-only + parent-hash chain = tamper-evident, replayable history (same
guarantee git gives DataLad, without git). Verify the chain on load.

## Assign → work-offline → resync

A **unit of work** = `{ datasetId, volumeIds | sliceRange, assignee, baseSha256 }`.
Generate a per-assignee `.nvbundle` (data subset + this manifest). On resync:
verify each returned artifact's `baseSha256` against the current dataset, **append**
the assignee's changelog entries (their PROV activities) to the dataset log, and
flag conflicts (two assignees touching the same unit) instead of last-write-wins.
This is `datalad run` on a subset + `push` back to a sibling, expressed in our
transport-agnostic bundle (file-in / file-out → AirDrop, shared folder, or server).

## Mapping to existing code

| Concept                    | Today                                   | Target                                              |
|----------------------------|-----------------------------------------|-----------------------------------------------------|
| File identity              | `sha256_file` (bundle) / `DefaultHasher` (cache) | SHA-256 everywhere for integrity; keep `id` as identity |
| Derivation record          | `VolumeDerivation { operation, source_path, output_path }` | per-volume `generatedBy` (BIDS) + PROV activity |
| Op provenance              | `provenance.jsonl` `correction.save` (NeuroFlow-only) | dataset-level hash-chained PROV log, always on |
| Transport                  | `.nvbundle` (export/import)             | same, with the provenance block above               |
| Sync engine (desktop opt.) | —                                       | optional DataLad import/export adapter              |
```
