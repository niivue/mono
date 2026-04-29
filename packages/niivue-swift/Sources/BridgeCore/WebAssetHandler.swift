//
//  WebAssetHandler.swift
//  BridgeCore
//
//  Serves the built web app from a resource bundle under a custom URL
//  scheme configured on a `BridgeConfig`. Exists specifically so we can set
//  Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy response
//  headers, which `WKWebView.loadFileURL:` cannot do. Those headers enable
//  `crossOriginIsolated`, which NiiVue's worker paths rely on for
//  `SharedArrayBuffer`.
//
//  URL shape: <scheme>://<host>/<path-under-bundleSubdir>
//

import Foundation
import UniformTypeIdentifiers
import WebKit

public final class WebAssetHandler: NSObject, WKURLSchemeHandler {
    public let config: BridgeConfig

    public init(config: BridgeConfig) {
        self.config = config
    }

    public func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let url = urlSchemeTask.request.url
        guard let url, url.scheme == config.urlScheme else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }

        // `<scheme>://<host>/foo/bar.js` -> path "foo/bar.js" relative to
        // the configured bundle subdir.
        var relative = url.path
        if relative.hasPrefix("/") { relative.removeFirst() }
        if relative.isEmpty { relative = config.entryPath }

        guard let fileURL = resolve(relative: relative) else {
            respondNotFound(task: urlSchemeTask, url: url)
            return
        }

        do {
            let data = try Data(contentsOf: fileURL)
            let mime = Self.mimeType(for: fileURL)
            let headers: [String: String] = [
                "Content-Type": mime,
                "Content-Length": String(data.count),
                // Cross-origin isolation: required for SharedArrayBuffer.
                "Cross-Origin-Opener-Policy": "same-origin",
                "Cross-Origin-Embedder-Policy": "require-corp",
                "Cross-Origin-Resource-Policy": "same-origin",
                "Cache-Control": "no-store",
            ]
            let response = HTTPURLResponse(
                url: url,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: headers
            )!
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(data)
            urlSchemeTask.didFinish()
        } catch {
            urlSchemeTask.didFailWithError(error)
        }
    }

    public func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // No long-running state to cancel.
    }

    // MARK: Helpers

    private func resolve(relative: String) -> URL? {
        guard let base = config.resourceBundle.resourceURL?
            .appendingPathComponent(config.bundleSubdir)
        else { return nil }
        let candidate = base.appendingPathComponent(relative)
        guard FileManager.default.fileExists(atPath: candidate.path) else {
            return nil
        }
        return candidate
    }

    private static func mimeType(for url: URL) -> String {
        let ext = url.pathExtension.lowercased()
        switch ext {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs":   return "text/javascript; charset=utf-8"
        case "css":         return "text/css; charset=utf-8"
        case "json":        return "application/json; charset=utf-8"
        case "wasm":        return "application/wasm"
        case "svg":         return "image/svg+xml"
        case "png":         return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "webp":        return "image/webp"
        case "ico":         return "image/x-icon"
        case "woff":        return "font/woff"
        case "woff2":       return "font/woff2"
        case "ttf":         return "font/ttf"
        case "map":         return "application/json; charset=utf-8"
        case "nii":         return "application/octet-stream"
        case "gz":          return "application/gzip"
        default:
            if let type = UTType(filenameExtension: ext), let mime = type.preferredMIMEType {
                return mime
            }
            return "application/octet-stream"
        }
    }

    private func respondNotFound(task: WKURLSchemeTask, url: URL) {
        let response = HTTPURLResponse(
            url: url,
            statusCode: 404,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "text/plain; charset=utf-8"]
        )!
        task.didReceive(response)
        task.didReceive(Data("not found".utf8))
        task.didFinish()
    }
}
