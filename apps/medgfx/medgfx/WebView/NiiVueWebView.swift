//
//  NiiVueWebView.swift
//  medgfx
//
//  SwiftUI wrapper around WKWebView that hosts the medgfx-web Vite app and
//  connects it to the typed Bridge.
//
//  In DEBUG builds, loads the Vite dev server on http://localhost:8083/
//  so TS changes hot-reload without rebuilding the Xcode app.
//
//  In RELEASE builds, loads medgfx://app/index.html served by WebAssetHandler
//  from Resources/WebApp inside the .app bundle.
//

import SwiftUI
import WebKit

#if os(macOS)
typealias PlatformViewRepresentable = NSViewRepresentable
#else
typealias PlatformViewRepresentable = UIViewRepresentable
#endif

struct NiiVueWebView: PlatformViewRepresentable {
    let bridge: Bridge

    #if os(macOS)
    func makeNSView(context: Context) -> WKWebView { makeWebView(context: context) }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
    #else
    func makeUIView(context: Context) -> WKWebView { makeWebView(context: context) }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
    #endif

    func makeCoordinator() -> Coordinator {
        Coordinator(bridge: bridge)
    }

    // MARK: Construction

    private func makeWebView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()

        // Register the JS -> Swift message handler.
        let userContent = WKUserContentController()
        userContent.add(context.coordinator, name: BridgeNames.messageHandler)

        // Install a minimal JS stub at document start so calls that fire
        // before main.ts loads still resolve against a real object.
        let stub = """
        (function () {
          if (window.__medgfxBridge) return;
          window.__medgfxBridge = {
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

        config.userContentController = userContent

        // Register the custom scheme handler for RELEASE builds.
        config.setURLSchemeHandler(
            context.coordinator.assetHandler,
            forURLScheme: WebAssetConstants.scheme
        )

        // Show the web inspector in DEBUG so we can debug the webview from Safari.
        #if DEBUG
        if #available(iOS 16.4, macOS 13.3, *) {
            // `isInspectable` is a runtime flag on WKWebView >= iOS 16.4 / macOS 13.3.
        }
        #endif

        let webView = WKWebView(frame: .zero, configuration: config)
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

        // Kick off the initial navigation.
        if let url = initialURL() {
            webView.load(URLRequest(url: url))
        }
        return webView
    }

    private func initialURL() -> URL? {
        #if DEBUG
        return URL(string: "http://localhost:8083/")
        #else
        return WebAssetConstants.entryURL
        #endif
    }
}

// MARK: - Coordinator

extension NiiVueWebView {
    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler {
        let bridge: Bridge
        let assetHandler = WebAssetHandler()

        init(bridge: Bridge) {
            self.bridge = bridge
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            bridge.receive(rawBody: message.body)
        }
    }
}
