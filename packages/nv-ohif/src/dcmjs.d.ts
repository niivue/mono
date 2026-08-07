// Ambient declaration for `dcmjs` (no `.d.ts` shipped upstream). We only reach
// `dcmjs.data.DicomDict` and type its shape locally in reconstructP10.ts, so a
// permissive module declaration is enough.
declare module 'dcmjs'
