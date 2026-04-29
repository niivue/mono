//
//  BridgeConfig+Bundled.swift
//  NiiVueKit
//
//  Convenience presets for `BridgeConfig` that reference resources shipped
//  inside the `NiiVueKit` module. These live in NiiVueKit (not BridgeCore)
//  so `Bundle.module` resolves to NiiVueKit's own bundle.
//

import BridgeCore
import Foundation

extension BridgeConfig {
    /// Default configuration that serves the web bundle shipped inside
    /// `NiiVueKit.Resources/WebApp/` via `Bundle.module`. Zero-config for
    /// consumers who are happy with the stock `medgfx-web` UI.
    ///
    /// Use this when you don't ship your own web bundle. Falls back to
    /// whatever is in the package resource bundle; no Run Script phase
    /// required in the host Xcode target.
    public static var niiVueKitBundled: BridgeConfig {
        BridgeConfig(resourceBundle: .module)
    }
}

public enum NiiVueKit {
    /// Version of `@niivue/niivue` pinned by the bundled web app at build
    /// time. Consumers that load the default bundle can surface this in
    /// diagnostics / about screens.
    ///
    /// Kept as a hand-maintained constant; updated by `scripts/build-web.sh`
    /// (or manually) whenever the bundled web app is regenerated against a
    /// new `@niivue/niivue` release.
    public static let niiVueVersion: String = "1.0.0-rc.3"

    /// Version of the NiiVueKit Swift package itself.
    public static let packageVersion: String = "0.1.0"
}
