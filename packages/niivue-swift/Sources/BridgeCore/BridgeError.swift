//
//  BridgeError.swift
//  BridgeCore
//
//  Errors surfaced by `Bridge` to callers.
//

import Foundation

public enum BridgeError: Error {
    /// The JS side replied with `{ ok: false, error }` for a `call`.
    case remote(String)
    /// The bridge is not wired to a live webview (call arrived too early
    /// or after teardown).
    case notReady
    /// JSON encoding of an outbound envelope failed.
    case encoding(String)
    /// The underlying `WKWebView` was deallocated before a reply came back.
    case webViewGone
}
