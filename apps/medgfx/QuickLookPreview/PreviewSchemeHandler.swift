//
//  PreviewSchemeHandler.swift
//  Serves the extension's bundled web assets and the one previewed document
//  over a private scheme.
//
//  Deliberately NOT shared with the app's `BridgeCore.WebAssetHandler`, which
//  is a different animal: it reads whole files with `Data(contentsOf:)`, has no
//  path-containment check, no cancellation, no main-queue confinement and no
//  document route, and it serves COOP/COEP where this serves a CSP. Unifying
//  them would need a config object with five knobs to express the differences —
//  more code than the duplication, and it would hand one of them the wrong
//  memory profile.
//
//  A custom scheme rather than `file://` for the same reason as the host app:
//  Vite emits `<script type="module" crossorigin>`, and a `file://` page is an
//  opaque origin, so module loading is CORS-blocked.
//

import Foundation
import WebKit

final class PreviewSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "niivue-preview"
    static let host = "preview"

    /// Bounds the *Swift* allocation per read. It does not bound the peak:
    /// `WKURLSchemeTask` has no flow control, so the web content process still
    /// buffers the whole response. `PreviewViewController.maxFileBytes` (256 MB)
    /// is what bounds that.
    private static let chunkSize = 1024 * 1024

    private let root: URL
    private let documentLock = NSLock()
    private var document: (token: String, url: URL, fileName: String)?
    private let readsLock = NSLock()
    private var reads: [ObjectIdentifier: ReadState] = [:]

    /// `cancelled` is **main-queue confined**, and so is every `task.*` call —
    /// see `deliver(_:_:)`. A lock here would not be enough: WebKit marks a task
    /// stopped *before* it calls `webView(_:stop:)`, so any "check a flag, then
    /// send" sequence that spans two queues can still send to a stopped task,
    /// and `WKURLSchemeTask` answers that with an Objective-C exception Swift
    /// cannot catch. Sharing one queue with `stop` is what makes it atomic.
    private final class ReadState {
        var cancelled = false
    }

    init(root: URL) {
        self.root = root.standardizedFileURL.resolvingSymlinksInPath()
        super.init()
    }

    static func pageURL() -> URL {
        // `WebApp/`, matching where the app target already stages its web
        // bundle (see AGENTS.md). The appex gets its own copy — `Bundle.main`
        // inside an extension is the .appex, not the containing app.
        URL(string: "\(scheme)://\(host)/WebApp/quicklook.html")!
    }

    // MARK: - Document route

    /// Register the previewed file and return a same-origin URL whose path
    /// carries only an opaque token and the original filename.
    ///
    /// Exactly one document is ever registered per handler, and registering
    /// again replaces it — a preview that is superseded must not leave the old
    /// file reachable. The page has no way to enumerate or guess the token, and
    /// no route exists to any other path outside the bundle root.
    func registerDocument(_ url: URL, fileName: String) -> URL {
        let token = UUID().uuidString
        documentLock.lock()
        document = (token: token, url: url, fileName: fileName)
        documentLock.unlock()

        var components = URLComponents()
        components.scheme = Self.scheme
        components.host = Self.host
        // Encode the filename ourselves rather than letting the `path` setter do
        // it: that setter leaves a literal `%` alone, so a file named `a%2Fb.nii`
        // would round-trip through `url.path` as `a/b.nii` — four path components
        // instead of three, and a refused load.
        //
        // `.` is deliberately left unescaped, and that is load-bearing rather
        // than cosmetic. `NVMesh.loadMesh` takes the reader extension from the
        // **URL** and ignores the `name` we pass alongside it
        // (`mesh/NVMesh.ts:192`), so a fully-escaped route carries no extension
        // at all: `isTractExtension('')` is false, `readerByExt.get('')` misses,
        // and NiiVue silently falls back to the MZ3 reader. The symptom is that
        // `.mz3` previews correctly by accident while `.gii`, `.tck`, `.trk` and
        // `.trx` all fail. A dot cannot create a path component, so allowing it
        // costs nothing the aggressive encoding was protecting against — `/` and
        // `%` are still escaped, which is what that protection was actually for.
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "."))
        let encoded = fileName.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
        components.percentEncodedPath = "/document/\(token)/\(encoded)"
        return components.url!
    }

    /// Drop the document route. Called on teardown so a torn-down preview's file
    /// is unreachable even if a stale page were somehow still running.
    func invalidateDocument() {
        documentLock.lock()
        document = nil
        documentLock.unlock()
    }

    // MARK: - Serving

    private static let mimeTypes = [
        "html": "text/html", "js": "text/javascript", "mjs": "text/javascript",
        "css": "text/css", "json": "application/json", "svg": "image/svg+xml",
        "png": "image/png", "woff2": "font/woff2", "wasm": "application/wasm",
        "gz": "application/gzip", "map": "application/json",
    ]

    /// Containment is checked on **path components**, never `hasPrefix`:
    /// `/root` is a string prefix of `/rootlike/secret`.
    private func fileURL(for url: URL) -> URL? {
        let parts = url.path.split(separator: "/").map(String.init)
        if parts.first == "document" {
            guard parts.count == 3 else { return nil }
            documentLock.lock()
            let registered = document
            documentLock.unlock()
            guard registered?.token == parts[1], registered?.fileName == parts[2] else { return nil }
            return registered?.url
        }

        let relative = parts.joined(separator: "/")
        let candidate = root.appendingPathComponent(relative)
            .standardizedFileURL
            .resolvingSymlinksInPath()
        let rootParts = root.pathComponents
        let candidateParts = candidate.pathComponents
        guard candidateParts.count > rootParts.count,
              Array(candidateParts.prefix(rootParts.count)) == rootParts else {
            return nil
        }
        return candidate
    }

    /// The extension carries `com.apple.security.network.client` because WebKit
    /// will not start without it. This CSP is what makes "offline" true in
    /// practice rather than merely intended: no origin but our own is reachable,
    /// so the capability is never exercisable by page script.
    ///
    /// Nil rather than a header-less `URLResponse` when the response cannot be
    /// built. Failing closed matters — the fallback that would serve the page
    /// with no CSP and no `nosniff` is worse than not serving it. A plain
    /// `URLResponse` also makes `fetch()` report status 0, which NiiVue reads as
    /// a failed load.
    private func response(for requestURL: URL, fileURL: URL, mime: String) -> URLResponse? {
        let attributes = try? FileManager.default.attributesOfItem(atPath: fileURL.path)
        let length = (attributes?[.size] as? NSNumber)?.int64Value ?? -1
        var headers = [
            "Content-Type": mime,
            "Content-Security-Policy":
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                + "connect-src 'self'; img-src 'self' data: blob:; font-src 'self'; "
                + "worker-src 'self' blob:; object-src 'none'; base-uri 'none'; "
                + "frame-ancestors 'none'",
            "X-Content-Type-Options": "nosniff",
        ]
        if length >= 0 {
            headers["Content-Length"] = String(length)
        }
        return HTTPURLResponse(url: requestURL,
                               statusCode: 200,
                               httpVersion: "HTTP/1.1",
                               headerFields: headers)
    }

    private func finishRead(_ id: ObjectIdentifier) {
        readsLock.lock()
        reads.removeValue(forKey: id)
        readsLock.unlock()
    }

    /// Run `body` on the main queue unless the task has been stopped, reporting
    /// whether it ran. `webView(_:stop:)` is delivered on the main queue too, so
    /// the cancellation check and the `task.*` call cannot be split by a stop.
    ///
    /// Deliberately `sync`, not `async`: it makes the read loop wait for each
    /// chunk to be handed over, so a large file cannot pile up as hundreds of
    /// pending main-queue blocks each holding a megabyte. Nothing on the main
    /// queue ever waits on this handler, so there is no inversion.
    @discardableResult
    private func deliver(_ state: ReadState, _ body: () -> Void) -> Bool {
        var ran = false
        DispatchQueue.main.sync {
            guard !state.cancelled else { return }
            body()
            ran = true
        }
        return ran
    }

    private func serve(_ task: WKURLSchemeTask,
                       requestURL: URL,
                       fileURL: URL,
                       mime: String,
                       state: ReadState,
                       id: ObjectIdentifier) {
        defer { finishRead(id) }
        do {
            let handle = try FileHandle(forReadingFrom: fileURL)
            // Closed as soon as delivery finishes, including on cancellation:
            // Apple advises against holding a descriptor open for the lifetime
            // of a preview, and a stopped task returns out of this scope.
            defer { try? handle.close() }
            guard let response = response(for: requestURL, fileURL: fileURL, mime: mime) else {
                deliver(state) { task.didFailWithError(URLError(.cannotParseResponse)) }
                return
            }
            guard deliver(state, { task.didReceive(response) }) else { return }

            while true {
                guard let chunk = try handle.read(upToCount: Self.chunkSize), !chunk.isEmpty else {
                    break
                }
                guard deliver(state, { task.didReceive(chunk) }) else { return }
            }
            deliver(state) { task.didFinish() }
        } catch {
            deliver(state) { task.didFailWithError(error) }
        }
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        guard url.host == Self.host else {
            task.didFailWithError(URLError(.unsupportedURL))
            return
        }
        guard let file = fileURL(for: url) else {
            task.didFailWithError(URLError(.noPermissionsToReadFile))
            return
        }
        let mime = Self.mimeTypes[file.pathExtension.lowercased()] ?? "application/octet-stream"
        let id = ObjectIdentifier(task as AnyObject)
        let state = ReadState()
        readsLock.lock()
        reads[id] = state
        readsLock.unlock()

        // The closure holds `task` strongly until `finishRead` runs, so the
        // `ObjectIdentifier` key cannot be recycled by a later task while this
        // read is in flight.
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            serve(task, requestURL: url, fileURL: file, mime: mime, state: state, id: id)
        }
    }

    /// Delivered on the main queue, which is what makes `deliver(_:_:)` safe.
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task as AnyObject)
        readsLock.lock()
        let state = reads[id]
        readsLock.unlock()
        state?.cancelled = true
    }
}
