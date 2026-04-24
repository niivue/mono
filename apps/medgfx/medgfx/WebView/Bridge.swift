//
//  Bridge.swift
//  medgfx
//
//  Typed two-way bridge between SwiftUI and the WKWebView.
//
//  Wire format (both directions):
//    { kind: "call",   id, method, payload }
//    { kind: "result", id, ok: true,  value }
//    { kind: "result", id, ok: false, error }
//    { kind: "event",  name, payload }
//
//  Transport:
//    Swift -> JS: webView.evaluateJavaScript("window.__medgfxBridge.__receive(<json>)")
//    JS -> Swift: WKScriptMessageHandler named "medgfx"
//

import Foundation
import WebKit

enum BridgeError: Error {
    case remote(String)
    case notReady
    case encoding(String)
    case webViewGone
}

/// Name of the JS-side message handler and the JS global object.
/// Kept in one place so the Swift injection script and the JS bridge agree.
enum BridgeNames {
    static let messageHandler = "medgfx"
    static let jsGlobal = "window.__medgfxBridge"
}

@MainActor
final class Bridge: NSObject {
    // The webview this bridge speaks to. Set by NiiVueWebView after the
    // WKWebView is created.
    weak var webView: WKWebView?

    // Pending Swift-initiated calls awaiting a result envelope from JS.
    private var pending: [String: CheckedContinuation<Data, Error>] = [:]

    // Handlers for JS-initiated calls.
    private var callHandlers: [String: (Data) async throws -> Encodable] = [:]

    // Handlers for JS-initiated events.
    private var eventHandlers: [String: [(Data) -> Void]] = [:]

    // Calls/events queued before the JS side emits `ready`.
    private var isReady = false
    private var preReadyQueue: [String] = []

    override init() {
        super.init()
        // Built-in: flush the queue when JS reports it's ready.
        on("ready") { [weak self] _ in
            Task { @MainActor in self?.markReady() }
        }
    }

    // MARK: Public API

    /// Invoke a method on the JS side and await its reply.
    func call<Out: Decodable>(
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
    func emit(_ name: String) {
        emit(name, EmptyPayload())
    }

    /// Fire-and-forget event to the JS side.
    func emit(_ name: String, _ payload: Encodable) {
        let envelope = EventEnvelope(kind: "event", name: name, payload: AnyEncodable(payload))
        do {
            let js = try encodeAsJSLiteral(envelope)
            enqueueOrSend(js)
        } catch {
            print("[medgfx-bridge] failed to encode event \(name): \(error)")
        }
    }

    /// Register a handler for JS-initiated calls to `method`.
    func handle(_ method: String, _ handler: @escaping (Data) async throws -> Encodable) {
        callHandlers[method] = handler
    }

    /// Subscribe to JS-emitted events by name.
    func on(_ event: String, _ handler: @escaping (Data) -> Void) {
        eventHandlers[event, default: []].append(handler)
    }

    // MARK: Transport plumbing

    /// Called from WKScriptMessageHandler for each envelope JS sent us.
    func receive(rawBody: Any) {
        guard let json = serializeMessageBody(rawBody),
              let envelope = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
              let kind = envelope["kind"] as? String
        else {
            print("[medgfx-bridge] malformed envelope from JS: \(rawBody)")
            return
        }
        switch kind {
        case "call":   handleCall(envelope)
        case "result": handleResult(envelope)
        case "event":  handleEvent(envelope)
        default:       print("[medgfx-bridge] unknown kind: \(kind)")
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
        guard let webView else { return }
        let js = "\(BridgeNames.jsGlobal).__receive(\(jsEnvelopeLiteral));"
        webView.evaluateJavaScript(js) { _, err in
            if let err { print("[medgfx-bridge] evaluateJavaScript error: \(err)") }
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

// MARK: - Wire types

private struct CallEnvelope: Encodable {
    let kind: String
    let id: String
    let method: String
    let payload: AnyEncodable
}

private struct EventEnvelope: Encodable {
    let kind: String
    let name: String
    let payload: AnyEncodable
}

private struct ResultOK: Encodable {
    let kind: String
    let id: String
    let ok: Bool
    let value: AnyEncodable
}

private struct ResultErr: Encodable {
    let kind: String
    let id: String
    let ok: Bool
    let error: String
}

struct EmptyPayload: Encodable {}

/// Type-erased Encodable wrapper so we can embed arbitrary Encodable payloads.
struct AnyEncodable: Encodable {
    private let _encode: (Encoder) throws -> Void
    init<T: Encodable>(_ wrapped: T) { _encode = wrapped.encode }
    func encode(to encoder: Encoder) throws { try _encode(encoder) }
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
