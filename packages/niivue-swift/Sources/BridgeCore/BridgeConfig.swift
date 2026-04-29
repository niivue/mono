//
//  BridgeConfig.swift
//  BridgeCore
//
//  Configuration shared by `Bridge`, the SwiftUI web view wrapper, and the
//  custom-scheme web asset handler. A single value ties together the
//  WKScriptMessageHandler name, the JS global receiver, the custom URL
//  scheme used to serve bundled assets, and the dev-server URL used in
//  DEBUG builds.
//
//  `BridgeConfig.default` matches the defaults used by the
//  `@niivue/web-bridge` npm package, so a consumer that sticks to the
//  defaults on both sides gets a working bridge with zero configuration.
//

import Foundation

public struct BridgeConfig: Sendable {
    /// Name of the `WKScriptMessageHandler` registered on the native side
    /// and read by the JS side as `window.webkit.messageHandlers[handlerName]`.
    public let handlerName: String

    /// Name (without the `window.` prefix) of the global JS object the
    /// native side calls to deliver envelopes. Defaults to
    /// `__<handlerName>Bridge`.
    public let jsGlobalName: String

    /// Custom URL scheme used to serve the bundled web app in RELEASE
    /// builds. The web view loads `<urlScheme>://<host>/<entryPath>`.
    public let urlScheme: String

    /// Authority component of the bundled web-app URL. WebKit requires
    /// one for custom-scheme URLs; `"app"` is a neutral default. Only
    /// matters if a consumer wants to route multiple bundles through the
    /// same scheme handler by host.
    public let host: String

    /// Folder (relative to the resource bundle) that contains the built
    /// web app (index.html + assets). Typically `"WebApp"`.
    public let bundleSubdir: String

    /// Bundle the asset handler searches when serving `urlScheme://host/*`.
    /// Defaults to `.main` (matches the convention of copying the built
    /// web bundle into `.app/Contents/Resources/WebApp/` via a Run Script
    /// phase). Package consumers shipping a prebuilt web app as SPM
    /// resources would pass `.module` instead.
    public let resourceBundle: Bundle

    /// URL loaded in DEBUG builds. `nil` disables the dev fallback and
    /// always uses the bundled assets. Defaults to `nil` -- set this
    /// explicitly when wiring a dev server (see `BridgeConfig.withDevServer`).
    public let devServerURL: URL?

    /// Entry path loaded from the bundled web app. Typically `"index.html"`.
    public let entryPath: String

    public init(
        handlerName: String = "niivue",
        jsGlobalName: String? = nil,
        urlScheme: String = "niivue-app",
        host: String = "app",
        bundleSubdir: String = "WebApp",
        resourceBundle: Bundle = .main,
        devServerURL: URL? = nil,
        entryPath: String = "index.html"
    ) {
        self.handlerName = handlerName
        self.jsGlobalName = jsGlobalName ?? "__\(handlerName)Bridge"
        self.urlScheme = urlScheme
        self.host = host
        self.bundleSubdir = bundleSubdir
        self.resourceBundle = resourceBundle
        self.devServerURL = devServerURL
        self.entryPath = entryPath
    }

    /// Default configuration: handler `niivue`, scheme `niivue-app`,
    /// assets in `.main/WebApp/`, no dev-server fallback. RELEASE-only
    /// out of the box; call `.withDevServer(port:)` to add one.
    public static let `default` = BridgeConfig()

    /// Convenience: return a copy with `devServerURL` set to
    /// `http://localhost:<port>/`. Use this when your Vite dev server is
    /// running locally; RELEASE builds ignore the field.
    public func withDevServer(port: Int) -> BridgeConfig {
        BridgeConfig(
            handlerName: handlerName,
            jsGlobalName: jsGlobalName,
            urlScheme: urlScheme,
            host: host,
            bundleSubdir: bundleSubdir,
            resourceBundle: resourceBundle,
            devServerURL: URL(string: "http://localhost:\(port)/"),
            entryPath: entryPath
        )
    }

    /// Full JS global path including `window.` prefix, used when
    /// evaluating script.
    public var jsGlobalPath: String { "window.\(jsGlobalName)" }

    /// URL loaded by the web view in RELEASE builds.
    public var bundledEntryURL: URL {
        guard let url = URL(string: "\(urlScheme)://\(host)/\(entryPath)") else {
            // Misconfiguration; surface loudly in DEBUG, fall back to a
            // harmless file URL in RELEASE so the app still boots.
            assertionFailure("BridgeConfig: failed to build URL from scheme=\(urlScheme) host=\(host) entry=\(entryPath)")
            return URL(fileURLWithPath: "/")
        }
        return url
    }
}
