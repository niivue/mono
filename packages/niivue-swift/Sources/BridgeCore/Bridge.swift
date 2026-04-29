//
//  Bridge.swift
//  BridgeCore
//
//  Typed two-way bridge between a SwiftUI host and a WKWebView-hosted web
//  app. Configured by a `BridgeConfig` so the same code can power multiple
//  independent bridges in one app (e.g. multiple viewers side by side).
//
//  Wire format (both directions):
//    { kind: "call",   id, method, payload }
//    { kind: "result", id, ok: true,  value }
//    { kind: "result", id, ok: false, error }
//    { kind: "event",  name, payload }
//
//  Transport:
//    Swift -> JS: webView.evaluateJavaScript("<jsGlobalPath>.__receive(<json>)")
//    JS -> Swift: WKScriptMessageHandler named `config.handlerName`
//

import Foundation
import WebKit

@MainActor
public final class Bridge: NSObject {
    public let config: BridgeConfig

    /// The webview this bridge speaks to. Set by the SwiftUI wrapper after
    /// the `WKWebView` is created.
    public weak var webView: WKWebView?

    // Pending Swift-initiated calls awaiting a result envelope from JS.
    private var pending: [String: CheckedContinuation<Data, Error>] = [:]

    // Handlers for JS-initiated calls.
    private var callHandlers: [String: (Data) async throws -> Encodable] = [:]

    // Handlers for JS-initiated events.
    private var eventHandlers: [String: [(Data) -> Void]] = [:]

    // Calls/events queued before the JS side emits `ready`.
    private var isReady = false
    private var preReadyQueue: [String] = []

    /// Test-only hook. When set, outbound JS literals are delivered here
    /// instead of being evaluated on the webView. `internal` + `@testable
    /// import BridgeCore` keeps this out of the public surface.
    internal var _testOutboundSink: ((String) -> Void)?

    public init(config: BridgeConfig = .default) {
        self.config = config
        super.init()
        // Built-in: flush the queue when JS reports it's ready.
        on("ready") { [weak self] _ in
            Task { @MainActor in self?.markReady() }
        }
    }

    // MARK: Public API

    /// Invoke a method on the JS side and await its reply.
    public func call<Out: Decodable>(
        _ method: String,
        _ payload: Encodable,
        as: Out.Type = Out.self
    ) async throws -> Out {
        let id = UUID().uuidString
        let envelope = CallEnvelope(kind: "call", id: id, method: method, payload: AnyEncodable(payload))
        let js = try encodeAsJSLiteral(envelope)
        let data: Data = try await withCheckedThrowingContinuation { cont in
            pending[id] = cont
            enqueueOrSend(js)
        }
        return try JSONDecoder().decode(Out.self, from: data)
    }

    /// Fire-and-forget event to the JS side with no payload.
    public func emit(_ name: String) {
        emit(name, EmptyPayload())
    }

    /// Fire-and-forget event to the JS side.
    public func emit(_ name: String, _ payload: Encodable) {
        let envelope = EventEnvelope(kind: "event", name: name, payload: AnyEncodable(payload))
        do {
            let js = try encodeAsJSLiteral(envelope)
            enqueueOrSend(js)
        } catch {
            print("[niivue-bridge] failed to encode event \(name): \(error)")
        }
    }

    /// Register a handler for JS-initiated calls to `method`.
    ///
    /// Precondition: `method` must not already be registered. Matches the
    /// JS side's symmetric behaviour (`Bridge.handle` throws on dupes).
    public func handle(_ method: String, _ handler: @escaping (Data) async throws -> Encodable) {
        precondition(
            callHandlers[method] == nil,
            "Bridge.handle: handler already registered for '\(method)'"
        )
        callHandlers[method] = handler
    }

    /// Subscribe to JS-emitted events by name.
    public func on(_ event: String, _ handler: @escaping (Data) -> Void) {
        eventHandlers[event, default: []].append(handler)
    }

    // MARK: Transport plumbing

    /// Called from the WKScriptMessageHandler for each envelope JS sent us.
    public func receive(rawBody: Any) {
        guard let json = serializeMessageBody(rawBody),
              let envelope = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
              let kind = envelope["kind"] as? String
        else {
            print("[niivue-bridge] malformed envelope from JS: \(rawBody)")
            return
        }
        switch kind {
        case "call":   handleCall(envelope)
        case "result": handleResult(envelope)
        case "event":  handleEvent(envelope)
        default:       print("[niivue-bridge] unknown kind: \(kind)")
        }
    }

    private func markReady() {
        guard !isReady else { return }
        isReady = true
        let flush = preReadyQueue
        preReadyQueue.removeAll()
        for js in flush { sendToJS(js) }
    }

    private func enqueueOrSend(_ js: String) {
        if isReady {
            sendToJS(js)
        } else {
            preReadyQueue.append(js)
        }
    }

    private func sendToJS(_ jsEnvelopeLiteral: String) {
        // `JSONEncoder` does not escape U+2028/U+2029, which terminate JS
        // source lines. We embed the JSON directly into an `evaluateJavaScript`
        // input, so we must neutralise them ourselves.
        let safeLiteral = jsEnvelopeLiteral
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
        if let sink = _testOutboundSink {
            sink("\(config.jsGlobalPath).__receive(\(safeLiteral));")
            return
        }
        guard let webView else { return }
        let js = "\(config.jsGlobalPath).__receive(\(safeLiteral));"
        webView.evaluateJavaScript(js) { _, err in
            if let err { print("[niivue-bridge] evaluateJavaScript error: \(err)") }
        }
    }

    // MARK: Envelope handlers

    private func handleCall(_ env: [String: Any]) {
        guard
            let id = env["id"] as? String,
            let method = env["method"] as? String
        else { return }
        let payloadAny = env["payload"] ?? [:]
        let payloadData = (try? JSONSerialization.data(withJSONObject: payloadAny)) ?? Data("null".utf8)

        guard let handler = callHandlers[method] else {
            replyError(id: id, message: "no handler registered for '\(method)'")
            return
        }
        Task { @MainActor in
            do {
                let value = try await handler(payloadData)
                replyOK(id: id, value: value)
            } catch {
                replyError(id: id, message: String(describing: error))
            }
        }
    }

    private func handleResult(_ env: [String: Any]) {
        guard let id = env["id"] as? String else { return }
        guard let cont = pending.removeValue(forKey: id) else { return }
        if let ok = env["ok"] as? Bool, ok {
            let valueAny = env["value"] ?? NSNull()
            let data = (try? JSONSerialization.data(withJSONObject: valueAny, options: [.fragmentsAllowed])) ?? Data("null".utf8)
            cont.resume(returning: data)
        } else {
            let msg = (env["error"] as? String) ?? "unknown error"
            cont.resume(throwing: BridgeError.remote(msg))
        }
    }

    private func handleEvent(_ env: [String: Any]) {
        guard let name = env["name"] as? String else { return }
        let payloadAny = env["payload"] ?? [:]
        let payloadData = (try? JSONSerialization.data(withJSONObject: payloadAny, options: [.fragmentsAllowed])) ?? Data("null".utf8)
        for handler in eventHandlers[name] ?? [] {
            handler(payloadData)
        }
    }

    private func replyOK(id: String, value: Encodable) {
        let env = ResultOK(kind: "result", id: id, ok: true, value: AnyEncodable(value))
        if let js = try? encodeAsJSLiteral(env) {
            sendToJS(js)
        }
    }

    private func replyError(id: String, message: String) {
        let env = ResultErr(kind: "result", id: id, ok: false, error: message)
        if let js = try? encodeAsJSLiteral(env) {
            sendToJS(js)
        }
    }
}

// MARK: - Helpers

/// The JS side wraps script messages as NSDictionary / NSArray / NSString / NSNumber.
/// Normalize into a JSON Data blob.
private func serializeMessageBody(_ body: Any) -> Data? {
    if let s = body as? String, let data = s.data(using: .utf8) { return data }
    return try? JSONSerialization.data(withJSONObject: body, options: [.fragmentsAllowed])
}

private func encodeAsJSLiteral<T: Encodable>(_ value: T) throws -> String {
    let data = try JSONEncoder().encode(value)
    guard let s = String(data: data, encoding: .utf8) else {
        throw BridgeError.encoding("non-utf8 JSON output")
    }
    return s
}
