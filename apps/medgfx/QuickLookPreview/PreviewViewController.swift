//
//  PreviewViewController.swift
//  medgfx Quick Look preview extension (macOS).
//
//  Hosts the `quicklook.html` page from `apps/medgfx/web` in a `WKWebView` and
//  hands it exactly one file over an opaque same-origin document route. Every
//  path out of a preview — completion, timeout, replacement, dismissal, deinit
//  — is generation-scoped so a stale callback cannot touch a newer preview.
//
//  Ported from the Catalyst app at ~/src/ios. AppKit rather than UIKit:
//  `NSViewController`, no `webView.scrollView`, `underPageBackgroundColor`
//  instead of `isOpaque` + `backgroundColor`. Routing is by filename now
//  (`PreviewFileKind`), following MIQ and NIfTIViewQL.
//

import AppKit
import WebKit
// `QLPreviewingController` lives in QuickLookUI on macOS. On Catalyst it comes
// in with `QuickLook` alone, which is why the source this was ported from
// imports only that — dropping this line fails with "cannot find type in scope".
import QuickLookUI
import os

private let log = Logger(subsystem: "com.niivue.medgfx.QuickLookPreview", category: "preview")

/// Structured failure codes, shared with the page's `FailureCode` union in
/// `quicklook.ts`. Bare strings cross the boundary; keep the two in sync.
///
/// `cancelled` is the one code that is recorded but never sent: by the time a
/// preview is cancelled the page is being torn down, so there is nobody left to
/// show it to. It exists so a dismissal is distinguishable from a failure in
/// the log rather than collapsing into `internal`.
enum PreviewFailure: String {
    case unreadable
    case unsupported
    case timeout
    case graphicsUnavailable = "graphics-unavailable"
    case cancelled
    case resourceLimit = "resource-limit"
    case internalFailure = "internal"
}

/// Prevents `WKUserContentController` from retaining the controller through the
/// script-message registration. Without this the controller — and with it the
/// web view, the scheme handler, and the security scope — outlives every
/// preview, which is exactly what this milestone's "twenty open/dismiss cycles"
/// gate is looking for.
private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var delegate: WKScriptMessageHandler?

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        delegate?.userContentController(controller, didReceive: message)
    }
}

class PreviewViewController: NSViewController, QLPreviewingController, WKScriptMessageHandler, WKNavigationDelegate {

    /// Domain for every `NSError` handed back to Quick Look. The codes are
    /// distinct only so a log line can tell the failure paths apart; Quick Look
    /// shows `NSLocalizedDescriptionKey` and ignores the rest.
    private static let errorDomain = "com.niivue.medgfx.QuickLookPreview"
    /// A page that never reports back must not hang Quick Look forever.
    private static let readinessTimeout: TimeInterval = 10
    /// The page came up but never finished with the document.
    private static let loadTimeout: TimeInterval = 20
    /// How long the page gets to draw its own timeout panel before the native
    /// side stops waiting for it.
    private static let timeoutGrace: TimeInterval = 2
    /// Bytes on disk. An unreadable size fails closed rather than passing the
    /// cap as zero.
    private static let maxFileBytes = 256 * 1024 * 1024
    /// Bytes a compressed file may inflate to, which the file cap does not
    /// bound — a small gzip can expand without limit. Set equal to the file cap
    /// so the rule is one sentence: a preview will not decode more than it
    /// would accept as a file.
    ///
    /// NOT calibrated. It counts decoded *file* bytes, but NiiVue additionally
    /// allocates `Float32Array(nVox3D*3)` + `Uint8Array(nVox3D*4)`, so for uint8
    /// data the content-process peak is roughly 17x what this counts.
    /// Conservative in the right direction; a real number needs a device
    /// measurement. Consequence worth knowing: an oversize legitimate 4D series
    /// is refused outright rather than shown at frame zero.
    private static let maxDecodedBytes = 256 * 1024 * 1024

    private var webView: WKWebView!
    private let messageHandler = WeakScriptMessageHandler()
    private var schemeHandler: PreviewSchemeHandler!

    /// The single completion gate. Nil once fired; every path checks it, so a
    /// late JavaScript message or a timeout cannot complete a request twice —
    /// Quick Look treats a double completion as a programming error.
    private var completion: ((Error?) -> Void)?
    private var request: PreviewRequest?
    /// Set when the native side already knows the preview cannot succeed. The
    /// page is still loaded, so the failure is shown in our own fallback panel
    /// rather than as a blank canvas.
    private var pendingFailure: PreviewFailure?
    /// Bumped on every request and on teardown. Timers and JavaScript
    /// completions carry the generation they were issued under and are dropped
    /// if it has moved on — Quick Look may reuse one controller for a second
    /// file, and the first file's 10 s timer must not fire into it.
    private var generation = 0
    /// True only when `startAccessingSecurityScopedResource` returned true, so
    /// the balancing `stop` is never called spuriously.
    private var scopedURL: URL?
    /// Set when the page reports `ready`, cleared by teardown. Separates "the
    /// shell never came up" from "the shell is up and the file is slow" — two
    /// failures with different deadlines and different remedies.
    private var pageIsReady = false
    /// The navigation this preview started. `stopLoading()` reports the
    /// previous page's cancellation *asynchronously*, by which time the next
    /// request's completion is already installed — so a failure that does not
    /// belong to the current navigation must be ignored, or arrowing through a
    /// folder in Finder fails each preview with the one before it.
    private var currentNavigation: WKNavigation?
    /// `preparePreviewOfFile` entry. The exit gate is measured from here to the
    /// page's `loaded`, and cold extension launch is reported separately
    /// because it is not ours to fix — see `processStart`.
    private var startedAt: Date?
    /// When this extension process began, so a first preview can be told apart
    /// from a warm one in the log.
    private static let processStart = Date()
    /// Append a line to a diagnostic file inside this extension's container.
    ///
    /// Debug builds only. It exists because there is otherwise no way to answer
    /// "did the extension run, and which build was it" — `os_log` output from a
    /// Quick Look appex does not reach `log show`, and Finder gives no other
    /// feedback. Several wrong conclusions in this project came from assuming an
    /// answer to that question instead of reading one.
    static func trace(_ message: String) {
#if DEBUG
        let path = NSHomeDirectory() + "/tmp/quicklook-preview.log"
        let stamp = ISO8601DateFormatter().string(from: Date())
        let line = "\(stamp)  build=\(buildStamp)  \(message)\n"
        guard let data = line.data(using: .utf8) else { return }
        if let handle = FileHandle(forWritingAtPath: path) {
            defer { try? handle.close() }
            try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
        } else {
            try? data.write(to: URL(fileURLWithPath: path))
        }
#endif
    }

    /// This binary's build time, read from its own executable.
    private static let buildStamp: String = {
        guard let exe = Bundle.main.executableURL,
              let date = (try? exe.resourceValues(forKeys: [.contentModificationDateKey]))?
                  .contentModificationDate else { return "unknown" }
        let f = DateFormatter()
        f.dateFormat = "MMM d HH:mm:ss"
        return f.string(from: date)
    }()

    private struct PreviewRequest {
        let displayName: String
        let fileSize: Int
        let family: String
        let documentURL: URL
    }

    // MARK: - Lifecycle

    override func loadView() {
        let config = WKWebViewConfiguration()
        // Force-unwrapped deliberately: the build phase that stages `WebApp/`
        // into this appex guarantees it, so nil means the build is broken and
        // should crash loudly rather than present an empty panel.
        // Two `deletingLastPathComponent` calls walk `…/Resources/WebApp/
        // quicklook.html` back to `…/Resources`, which is the scheme handler's
        // root — the `/WebApp/...` in `pageURL()` is resolved against it.
        let root = Bundle.main.url(forResource: "quicklook", withExtension: "html", subdirectory: "WebApp")!
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        schemeHandler = PreviewSchemeHandler(root: root)
        config.setURLSchemeHandler(schemeHandler, forURLScheme: PreviewSchemeHandler.scheme)
        messageHandler.delegate = self
        config.userContentController.add(messageHandler, name: "qlPreview")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        // The AppKit equivalent of the Catalyst build's `isOpaque` +
        // `backgroundColor`: this page is solid black and has no SwiftUI
        // background to reveal, so paint the same colour underneath rather than
        // flashing white before the first frame. `NSView.isOpaque` is get-only
        // and `scrollView` does not exist on macOS — the page sets
        // `overflow: hidden`, which is what actually stopped the bounce.
        webView.underPageBackgroundColor = .black
        // A preview is not a browser: no swipe-back, no link navigation.
        webView.allowsBackForwardNavigationGestures = false
        // No container view and no gesture recognizer. Claiming the drag for
        // UIKit was an attempt to take it back from the host, and it is
        // unnecessary if the drag is never handed over in the first place —
        // which is what leaving WebKit's own selection intact achieves.
        view = webView
    }

    override func viewDidDisappear() {
        super.viewDidDisappear()
        // Dismissal during a load must release the file and stop the transfer
        // promptly rather than at deinit, which Quick Look may defer.
        teardown(reason: .cancelled)
    }

    deinit {
        // Not on the main thread by contract. Everything that must run there is
        // captured and hopped; the rest is safe anywhere.
        schemeHandler?.invalidateDocument()
        if let scopedURL {
            scopedURL.stopAccessingSecurityScopedResource()
        }
        let dying: WKWebView? = webView
        DispatchQueue.main.async {
            dying?.stopLoading()
            dying?.configuration.userContentController.removeAllScriptMessageHandlers()
        }
    }

    /// Release everything the current preview holds and invalidate its
    /// generation. Idempotent; safe to call from dismissal and from a
    /// replacement request.
    private func teardown(reason: PreviewFailure) {
        generation &+= 1
        // A pending Quick Look completion must still be answered, or Quick Look
        // waits on a preview nobody is producing any more.
        finish(nil)
        request = nil
        pendingFailure = nil
        pageIsReady = false
        currentNavigation = nil
        webView?.stopLoading()
        // Dropping the token first means an in-flight page cannot start a new
        // read of the file we are about to release.
        schemeHandler?.invalidateDocument()
        if let scopedURL {
            scopedURL.stopAccessingSecurityScopedResource()
            self.scopedURL = nil
        }
        if reason != .cancelled {
            log.notice("preview torn down: \(reason.rawValue, privacy: .public)")
        }
    }

    // MARK: - QLPreviewingController

    func preparePreviewOfFile(at url: URL, completionHandler handler: @escaping (Error?) -> Void) {
        startedAt = Date()
        // FIRST, unconditionally: Quick Look reuses one controller for a whole
        // folder, so every entry to this method must retire the previous
        // request — its completion, document token, security scope, navigation
        // and timers. This used to sit below the decline guard, so arrowing
        // from a volume onto a `.tar.gz` returned early and left the previous
        // preview's file scoped and its route live until something else
        // happened to tear it down.
        //
        // Safe before `loadViewIfNeeded()`: `teardown` reaches the web view and
        // scheme handler only through optional chaining, so a controller whose
        // view has never loaded is a no-op rather than a nil-unwrap.
        teardown(reason: .cancelled)

        // Decline before building anything. We claim every gzip on the machine,
        // so a folder of `.tar.gz` arrowed through in Finder would otherwise pay
        // for a `WKWebView` and a scheme handler per file.
        guard let kind = PreviewFileKind(url: url) else {
            log.notice("declining foreign archive")
            handler(NSError(domain: Self.errorDomain, code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Not a medical image.",
            ]))
            return
        }
        // Which binary is actually running. DEBUG only, and deliberately after
        // the decline: logging every gzip on the machine is not a diagnostic.
        Self.trace("preview \(url.lastPathComponent)")
        // Quick Look is not documented to load the view before preparing, and
        // every path below touches the web view.
        loadViewIfNeeded()
        completion = handler
        let current = generation

        // Milestone 0.5 measured the previewed file as already readable inside
        // the sandbox, so this normally returns false. Claim it anyway — it
        // costs nothing and is the documented contract for provider-backed
        // files — and only balance it when it actually succeeded.
        if url.startAccessingSecurityScopedResource() {
            scopedURL = url
        }

        // Sizing a file — and streaming the inflate bound — is file I/O, and
        // this is Quick Look's callback: it must not block. Everything that
        // touches the controller hops back to the main queue, where the
        // generation check makes a superseded preview's work harmless.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            // Fails closed: an unreadable size refuses the file rather than
            // passing the cap as zero.
            let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize)
            // Decided here, NOT in `begin`: the inflate bound streams up to the
            // whole payload, measured at 738 ms for a legitimate 178 MB volume.
            // On the main queue that blocks the readiness timer and dismissal
            // and blows the <=2 s gate before the page has even started loading.
            let failure = Self.budgetFailure(fileSize: size, url: url)
            DispatchQueue.main.async {
                guard let self, self.generation == current else { return }
                self.begin(url: url, kind: kind, fileSize: size, failure: failure)
            }
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + Self.readinessTimeout) { [weak self] in
            // `pageIsReady`, not just `completion != nil`. The shell reporting
            // `ready` is what this timer is waiting for; once that has happened
            // a slow *load* is the load timeout's business. Checking only for an
            // outstanding completion killed any legitimate render still running
            // at ten seconds and told the user the preview "could not start".
            guard let self, self.generation == current, !self.pageIsReady,
                  self.completion != nil else { return }
            // The shell itself never came up, so there is no fallback panel to
            // show the failure in. Completing with an error hands Quick Look
            // back its own panel, which beats an indefinite spinner.
            log.error("preview page never reported ready")
            self.finish(NSError(domain: Self.errorDomain, code: 2, userInfo: [
                NSLocalizedDescriptionKey: "The preview could not start.",
            ]))
            // Then release, rather than merely invalidating: bumping the
            // generation by hand stopped stale work from landing but left the
            // security scope, the document token and the request alive for a
            // preview Quick Look has already been told failed.
            self.teardown(reason: .timeout)
        }
    }

    /// Main-queue continuation of `preparePreviewOfFile`, once the file has been
    /// sized and budgeted off it.
    private func begin(url: URL, kind: PreviewFileKind,
                       fileSize: Int?, failure: PreviewFailure?) {
        if let failure {
            pendingFailure = failure
            log.error("refusing file: \(failure.rawValue, privacy: .public)")
        } else {
            request = PreviewRequest(displayName: url.lastPathComponent,
                                     fileSize: fileSize ?? -1,
                                     family: kind.family,
                                     documentURL: schemeHandler.registerDocument(url, fileName: url.lastPathComponent))
        }

        // Tell the page which generation it belongs to BEFORE any of its script
        // runs, so even `ready` can be stamped. Without this, `ready` had to be
        // exempt from the staleness check — and a stale `ready` from a previous
        // preview would set `pageIsReady` for this one, dispatch `render` into a
        // page that was still navigating, and complete a perfectly good file
        // with an error. It could also disarm the readiness timer for a request
        // that had not armed a load timer yet, leaving Quick Look waiting for a
        // completion that never came.
        let scripts = webView.configuration.userContentController
        scripts.removeAllUserScripts()
        scripts.addUserScript(WKUserScript(
            source: "window.__qlGeneration = \(generation);",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        currentNavigation = webView.load(URLRequest(url: PreviewSchemeHandler.pageURL()))
    }

    /// Why this file must not be handed to the page, if it must not be.
    ///
    /// Checked before a single byte reaches WebKit. This is the one place the
    /// content still matters: routing is by name, but a name says nothing about
    /// how far a payload expands, and the allocation happens inside the content
    /// process where running out is a crash rather than an error we can report.
    ///
    /// Two bounds, covering disjoint cases:
    ///   - uncompressed: bytes on disk, since decoded is roughly bytes on disk.
    ///   - compressed: the streaming inflate bound, the ONLY thing between a
    ///     gzip bomb and the content process. A 2.65 MB `.nii.gz` was measured
    ///     at 5.4 GiB resident. It stops the moment the limit is passed, so the
    ///     cost is the limit, not the expansion.
    /// Internal, not private, so `scripts/check-gzip-bound.sh` can call the REAL
    /// decision. The previous check compiled only `GzipPeek` and therefore could
    /// not see a gate reintroduced at this call site — which is exactly the
    /// regression it claimed to guard.
    static func budgetFailure(fileSize: Int?, url: URL) -> PreviewFailure? {
        guard let fileSize else { return .unreadable }
        if fileSize > maxFileBytes { return .resourceLimit }
        // Unconditional, and that is load-bearing. This used to be gated on
        // `PreviewFileKind.isGzipped(url)` — a FILENAME test — while every
        // decoder downstream decides by CONTENT: `nifti.isCompressed`,
        // `NVGz.maybeDecompress` and the mesh readers all switch on the `1f 8b`
        // magic bytes. `cp bomb.gz bomb.nii` therefore sailed past the bound
        // (extension is `nii`, so the gate was skipped) and NiiVue inflated it
        // anyway. The attacker picks the name, so the name cannot select the
        // defence. `inflatedSize` already returns false for non-gzip input, so
        // the cost for an ordinary uncompressed file is one 64 KiB read.
        if GzipPeek.inflatedSize(ofFileAt: url, exceeds: maxDecodedBytes) {
            log.error("gzip payload exceeds the decoded budget")
            return .resourceLimit
        }
        return nil
    }

    private static func failed(_ message: String) -> NSError {
        NSError(domain: Self.errorDomain, code: 4,
                userInfo: [NSLocalizedDescriptionKey: message])
    }

    /// Fire the completion gate exactly once.
    private func finish(_ error: Error?) {
        guard let pending = completion else { return }
        completion = nil
        pending(error)
    }

    // MARK: - Page messages

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? String,
              let data = body.data(using: .utf8),
              let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let stage = payload["stage"] as? String else { return }

        // Terminal messages carry the generation they were issued under. This
        // was the last async channel without that scoping: a `loaded` still in
        // flight across a navigation would otherwise complete the *next*
        // preview while it sat on its spinner. `ready` is NO LONGER exempt: the
        // generation is injected as `window.__qlGeneration` at document start,
        // so the page knows it before its first line runs.
        if let stamped = payload["generation"] as? Int, stamped != generation {
            log.notice("dropping stale \(stage, privacy: .public) from generation \(stamped)")
            return
        }

        switch stage {
        case "ready":
            pageIsReady = true
            dispatchRequest()
        case "loaded":
            // The Milestone 7 gate, reported at the one point that can measure
            // it. `launch` is the cold-start cost Quick Look imposes before we
            // are called at all; it is deliberately separate from `prepare`,
            // which is the part this code controls.
            if let startedAt {
                let prepare = Date().timeIntervalSince(startedAt) * 1000
                let launch = startedAt.timeIntervalSince(Self.processStart) * 1000
                log.notice("preview loaded in \(prepare, format: .fixed(precision: 0)) ms (extension launch \(launch, format: .fixed(precision: 0)) ms)")
            }
            finish(nil)
        case "failed":
            let code = payload["code"] as? String ?? PreviewFailure.internalFailure.rawValue
            log.error("preview failed: \(code, privacy: .public)")
            // Still a successful *request*: the page is showing its own fallback,
            // which the product contract requires over a blank canvas. Completing
            // with an error here would replace that with Quick Look's generic
            // panel and lose the explanation.
            finish(nil)
        default:
            break
        }
    }

    /// Hand the page its one request, or its one failure.
    private func dispatchRequest() {
        let current = generation
        if let failure = pendingFailure {
            call("await window.niivuePreview.fail(code, generation);",
                 ["code": failure.rawValue, "generation": current])
            // Same backstop as the load path. This branch used to return before
            // arming any timer, and the readiness timer has already stood down
            // by now, so a page that ran `fail()` but could not post left the
            // completion pending for good.
            armCompletionBackstop(after: Self.timeoutGrace, generation: current)
            return
        }
        guard let request else { return }
        let payload: [String: Any] = [
            "url": request.documentURL.absoluteString,
            "displayName": request.displayName,
            "fileSize": request.fileSize,
            "family": request.family,
            "generation": current,
        ]
        guard let json = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: json, encoding: .utf8) else {
            // `render` was never called, so the page is sitting on its spinner.
            finish(Self.failed("The preview could not start."))
            return
        }
        // callAsyncJavaScript with an argument, never string interpolation into
        // source — the filename is attacker-influenced text.
        call("await window.niivuePreview.render(JSON.parse(request));", ["request": text])

        DispatchQueue.main.asyncAfter(deadline: .now() + Self.loadTimeout) { [weak self] in
            guard let self, self.generation == current, self.completion != nil else { return }
            // The shell is up, so the page can explain this itself.
            log.error("document load timed out")
            self.call("await window.niivuePreview.fail(code, generation);",
                      ["code": PreviewFailure.timeout.rawValue, "generation": current])
            // Asking the page to explain itself only works if the page is
            // alive. A hung or jetsammed content process will never run that
            // call and never post `failed`, which left the completion pending
            // for good. Complete natively if the page has not answered shortly.
            self.armCompletionBackstop(after: Self.timeoutGrace, generation: current)
        }
    }

    /// Complete natively if the page has not answered by `delay`. Asking the
    /// page to explain itself only works while the page is alive; a hung or
    /// jetsammed content process never runs the call and never posts.
    private func armCompletionBackstop(after delay: TimeInterval, generation current: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.generation == current, self.completion != nil else { return }
            log.error("page did not answer; completing natively")
            self.finish(NSError(domain: Self.errorDomain, code: 3, userInfo: [
                NSLocalizedDescriptionKey: "The preview timed out.",
            ]))
        }
    }

    private func call(_ script: String, _ arguments: [String: Any]) {
        let current = generation
        webView.callAsyncJavaScript(script, arguments: arguments, in: nil, in: .page) { [weak self] result in
            guard let self, self.generation == current else { return }
            if case .failure(let error) = result {
                // The page is mid-spinner or mid-draw and will not recover.
                log.error("page call failed: \(error.localizedDescription, privacy: .public)")
                self.finish(Self.failed("The preview could not be drawn."))
            }
        }
    }

    // MARK: - Navigation policy

    /// Only our own bundled page may ever load. With the network entitlement
    /// present for WebKit's sake, this and the CSP are what keep the extension
    /// genuinely offline.
    ///
    /// The document route is fetch-only and must never become the top-level
    /// document — the same rule the host app applies to its picked-file route.
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        let allowed = url?.scheme == PreviewSchemeHandler.scheme
            && url?.host == PreviewSchemeHandler.host
            && url?.path.split(separator: "/").first != "document"
        decisionHandler(allowed ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard navigation === currentNavigation else { return }
        log.error("preview page failed to load: \(error.localizedDescription, privacy: .public)")
        // Nothing ever rendered — the view is solid black. Completing with
        // success here hands the user a blank panel and calls it a preview.
        finish(Self.failed("The preview could not be loaded."))
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        log.error("preview content process terminated")
        // This is where a resource-limit kill lands. The web view is blank, so
        // the only honest answer to Quick Look is an error.
        finish(Self.failed("The preview ran out of resources."))
        // Nothing survives the content process, so hold nothing for it: the
        // document token and the security scope would otherwise stay live until
        // the next preview.
        teardown(reason: .cancelled)
    }
}
