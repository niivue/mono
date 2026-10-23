# NeuroVue

NeuroVue is a lightweight viewer app for neuroimaging workflow previews. It is
modeled on the OSD volume desktop and the IIIF volumetric server, but the app
shell and local data server are Rust/Tauri.

The intended split is:

- Rust local server: IIIF desktop manifests, volume metadata, raw NIfTI bytes,
  session patch files, and future OME-Zarr/tract/mesh routes.
- Web viewer: OSD-style dataset browsing plus NiiVue WebGPU/WebGL rendering.
- Tauri wrapper: native file access, session lifecycle, and app windows.

## Development

```sh
npm install
npm run tauri:dev
```

`npm run tauri:dev` and `npm run tauri:build` prepare a Tauri sidecar for
`niimath` by downloading the latest platform release from
`rordenlab/niimath`. To refresh an already staged binary, run:

```sh
npm run ensure-niimath -- --force
```

The Tauri host starts a local server and the viewer asks the host for its URL.
In browser-only Vite development, the app falls back to
`http://127.0.0.1:8087`, which is the current OSD/IIIF reference server.

## Reference Contract

NeuroVue starts with the same core endpoints used by the OSD desktop:

- `GET /api`
- `GET /iiif/desktop`
- `GET /iiif/desktop/neuro/manifest`
- `GET /iiif/image/{volume}/{axis}/{slice}/info.json`
- `GET /iiif/image/{volume}/{axis}/{slice}/{region}/{size}/{rotation}/{quality}.{format}`
- `GET /volumes/{volume}/metadata`
- `GET /volumes/{volume}/raw.nii.gz`

The initial Rust server includes a compatibility shim and serves a local MNI152
sample when one is discoverable from the NiiVue checkouts.
