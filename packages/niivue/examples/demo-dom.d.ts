// biome-ignore-all lint/suspicious/noExplicitAny: loose DOM types are the point of this file
// Demos are untyped page scripts: DOM lookups are loose so the check reports
// NiiVue API misuse, not missing element casts. Pages also hang debug handles
// on window.
interface Document {
  getElementById(id: string): any
}
interface ParentNode {
  querySelector(selectors: string): any
  querySelectorAll(selectors: string): any
}
interface Window {
  nv1: any
  nvL: any
  nvR: any
  __bench: any
  __benchDone: any
  __benchError: any
}
