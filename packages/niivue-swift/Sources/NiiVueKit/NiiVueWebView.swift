//
//  NiiVueWebView.swift
//  NiiVueKit
//
//  SwiftUI wrapper around `WKWebView` that hosts a NiiVue-powered web app
//  and connects it to a typed `Bridge`.
//
//  In DEBUG builds, loads `config.devServerURL` if set (e.g. a Vite dev
//  server) so TS changes hot-reload without rebuilding the Xcode app.
//
//  In RELEASE builds, loads `config.bundledEntryURL` served by
//  `WebAssetHandler` from `config.resourceBundle/config.bundleSubdir/`.
//

import BridgeCore
import SwiftUI
import WebKit

#if os(macOS)
public typealias PlatformViewRepresentable = NSViewRepresentable
#else
public typealias PlatformViewRepresentable = UIViewRepresentable
#endif

public struct NiiVueWebView: PlatformViewRepresentable {
    public let bridge: Bridge
    public let config: BridgeConfig
    /// Override URL. When non-nil, bypasses the DEBUG/RELEASE selection
    /// and loads this URL directly. Useful if the consumer wants to host
    /// the web bundle from an in-process HTTP server or a different scheme.
    public let overrideURL: URL?

    public init(bridge: Bridge, config: BridgeConfig? = nil, overrideURL: URL? = nil) {
        self.bridge = bridge
        self.config = config ?? bridge.config
        self.overrideURL = overrideURL
    }

    #if os(macOS)
    public func makeNSView(context: Context) -> WKWebView { makeWebView(context: context) }
    public func updateNSView(_ nsView: WKWebView, context: Context) {}
    #else
    public func makeUIView(context: Context) -> WKWebView { makeWebView(context: context) }
    public func updateUIView(_ uiView: WKWebView, context: Context) {}
    #endif

    public func makeCoordinator() -> Coordinator {
        Coordinator(bridge: bridge, config: config)
    }

    // MARK: Construction

    private func makeWebView(context: Context) -> WKWebView {
        let wkConfig = WKWebViewConfiguration()

        // Register the JS -> Swift message handler.
        let userContent = WKUserContentController()
        userContent.add(context.coordinator, name: config.handlerName)

        // Install a minimal JS stub at document start so calls that fire
        // before the real bridge loads still resolve against a real object.
        let stub = """
        (function () {
          if (window.\(config.jsGlobalName)) return;
          window.\(config.jsGlobalName) = {
            __pendingReceive: [],
            __receive: function (env) { this.__pendingReceive.push(env); }
          };
        })();
        """
        userContent.addUserScript(WKUserScript(
            source: stub,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))

        wkConfig.userContentController = userContent

        // Register the custom scheme handler for RELEASE builds.
        wkConfig.setURLSchemeHandler(
            context.coordinator.assetHandler,
            forURLScheme: config.urlScheme
        )

        let webView = WKWebView(frame: .zero, configuration: wkConfig)

        #if DEBUG
        if #available(iOS 16.4, macOS 13.3, *) {
            webView.isInspectable = true
        }
        #endif

        #if os(macOS)
        webView.setValue(false, forKey: "drawsBackground")
        #else
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.isScrollEnabled = false
        #endif

        bridge.webView = webView

        if let url = initialURL() {
            webView.load(URLRequest(url: url))
        }
        return webView
    }

    private func initialURL() -> URL? {
        if let overrideURL { return overrideURL }
        #if DEBUG
        if let dev = config.devServerURL { return dev }
        #endif
        return config.bundledEntryURL
    }
}

// MARK: - Coordinator

extension NiiVueWebView {
    @MainActor
    public final class Coordinator: NSObject, WKScriptMessageHandler {
        let bridge: Bridge
        let assetHandler: WebAssetHandler

        init(bridge: Bridge, config: BridgeConfig) {
            self.bridge = bridge
            self.assetHandler = WebAssetHandler(config: config)
        }

        public func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            bridge.receive(rawBody: message.body)
        }
    }
}
