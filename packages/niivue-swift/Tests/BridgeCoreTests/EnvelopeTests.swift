//
//  EnvelopeTests.swift
//  BridgeCoreTests
//
//  Coverage for the wire envelope types, `AnyJSON` decoding, and the
//  `BridgeConfig` defaults.
//

import XCTest
@testable import BridgeCore

final class EnvelopeTests: XCTestCase {
    func testAnyEncodableRoundTrip() throws {
        struct Payload: Encodable { let n: Int; let s: String }
        let boxed = AnyEncodable(Payload(n: 42, s: "hi"))
        let data = try JSONEncoder().encode(boxed)
        let any = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(any?["n"] as? Int, 42)
        XCTAssertEqual(any?["s"] as? String, "hi")
    }

    func testAnyJSONDecodesScalars() throws {
        let boolBox = try JSONDecoder().decode(AnyJSON.self, from: Data("true".utf8))
        XCTAssertEqual(boolBox.raw as? Bool, true)

        let numBox = try JSONDecoder().decode(AnyJSON.self, from: Data("3.14".utf8))
        XCTAssertEqual(numBox.raw as? Double, 3.14)

        let strBox = try JSONDecoder().decode(AnyJSON.self, from: Data("\"hello\"".utf8))
        XCTAssertEqual(strBox.raw as? String, "hello")
    }

    func testAnyJSONDecodesNull() throws {
        let box = try JSONDecoder().decode(AnyJSON.self, from: Data("null".utf8))
        XCTAssertTrue(box.raw is NSNull)
    }

    func testAnyJSONDecodesArraysAndObjects() throws {
        let arrBox = try JSONDecoder().decode(AnyJSON.self, from: Data("[1, 2, 3]".utf8))
        let arr = arrBox.raw as? [Any]
        XCTAssertEqual(arr?.count, 3)
        XCTAssertEqual(arr?[0] as? Double, 1)

        let objBox = try JSONDecoder().decode(
            AnyJSON.self,
            from: Data("{\"a\":1,\"b\":\"two\"}".utf8)
        )
        let obj = objBox.raw as? [String: Any]
        XCTAssertEqual(obj?["a"] as? Double, 1)
        XCTAssertEqual(obj?["b"] as? String, "two")
    }

    func testBridgeConfigDefaults() {
        let cfg = BridgeConfig.default
        XCTAssertEqual(cfg.handlerName, "niivue")
        XCTAssertEqual(cfg.jsGlobalName, "__niivueBridge")
        XCTAssertEqual(cfg.jsGlobalPath, "window.__niivueBridge")
        XCTAssertEqual(cfg.urlScheme, "niivue-app")
        XCTAssertEqual(cfg.bundledEntryURL.absoluteString, "niivue-app://app/index.html")
        XCTAssertNil(cfg.devServerURL, "default should have no dev server")
    }

    func testBridgeConfigCustomHandlerName() {
        let cfg = BridgeConfig(handlerName: "medgfx")
        XCTAssertEqual(cfg.jsGlobalName, "__medgfxBridge")
        XCTAssertEqual(cfg.jsGlobalPath, "window.__medgfxBridge")
    }

    func testBridgeConfigWithDevServer() {
        let cfg = BridgeConfig.default.withDevServer(port: 8083)
        XCTAssertEqual(cfg.devServerURL?.absoluteString, "http://localhost:8083/")
        XCTAssertEqual(cfg.handlerName, "niivue")
        XCTAssertEqual(cfg.urlScheme, "niivue-app")
    }
}

// MARK: - Bridge behaviour tests (driven via test hook)

/// Tests that exercise `Bridge` without a real `WKWebView`, using the
/// internal `_testOutboundSink` hook to capture outbound JS literals.
@MainActor
final class BridgeBehaviourTests: XCTestCase {
    private struct Captured {
        var js: [String] = []
    }

    /// Parse an envelope from a captured JS `__receive(...)` call.
    private func parseEnvelope(_ js: String) -> [String: Any]? {
        // js looks like: window.__niivueBridge.__receive({...});
        guard let start = js.firstIndex(of: "("),
              let end = js.lastIndex(of: ")")
        else { return nil }
        let jsonSlice = js[js.index(after: start)..<end]
        guard let data = String(jsonSlice).data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func makeBridge(ready: Bool = true) async -> (Bridge, () -> [String]) {
        let bridge = Bridge(config: .default)
        var captured: [String] = []
        bridge._testOutboundSink = { captured.append($0) }
        if ready {
            bridge.receive(rawBody: ["kind": "event", "name": "ready"])
            // Yield so the internal ready-handler Task runs.
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return (bridge, { captured })
    }

    // MARK: ready handshake

    func testCallBeforeReadyIsQueuedAndFlushedOnReady() async throws {
        let bridge = Bridge(config: .default)
        var captured: [String] = []
        bridge._testOutboundSink = { captured.append($0) }

        // Not ready yet -- fire-and-forget emit must not reach the sink.
        bridge.emit("noop", EmptyPayload())
        XCTAssertTrue(captured.isEmpty, "pre-ready envelopes must be queued")

        // Deliver `ready` -> the internal handler schedules markReady on a
        // Task; yield so it runs before we inspect the sink.
        bridge.receive(rawBody: ["kind": "event", "name": "ready"])
        try await Task.sleep(nanoseconds: 10_000_000)

        XCTAssertEqual(captured.count, 1, "queue must flush exactly once on ready")
        let env = parseEnvelope(captured[0])
        XCTAssertEqual(env?["kind"] as? String, "event")
        XCTAssertEqual(env?["name"] as? String, "noop")
    }

    func testEmitAfterReadyGoesStraightToSink() async {
        let (bridge, captured) = await makeBridge()
        bridge.emit("hello", EmptyPayload())
        XCTAssertEqual(captured().count, 1)
    }

    // MARK: call / result round trip

    func testCallResolvesOnOkResult() async throws {
        let (bridge, captured) = await makeBridge()
        struct Reply: Decodable, Equatable { let n: Int }

        let task = Task { () -> Reply in
            try await bridge.call("getN", EmptyPayload(), as: Reply.self)
        }

        // Pump the runloop so the Task emits the call envelope.
        try await Task.sleep(nanoseconds: 10_000_000)
        let outbound = captured()
        XCTAssertEqual(outbound.count, 1)
        let env = parseEnvelope(outbound[0])
        XCTAssertEqual(env?["kind"] as? String, "call")
        let id = env?["id"] as? String ?? ""
        XCTAssertFalse(id.isEmpty)

        // Deliver a matching ok result.
        bridge.receive(rawBody: [
            "kind": "result",
            "id": id,
            "ok": true,
            "value": ["n": 7],
        ])

        let reply = try await task.value
        XCTAssertEqual(reply, Reply(n: 7))
    }

    func testCallThrowsBridgeErrorRemoteOnOkFalse() async throws {
        let (bridge, captured) = await makeBridge()

        let task = Task { () -> String in
            do {
                struct Out: Decodable {}
                let _: Out = try await bridge.call("boom", EmptyPayload())
                return "no-throw"
            } catch let BridgeError.remote(msg) {
                return "remote:\(msg)"
            } catch {
                return "other:\(error)"
            }
        }

        try await Task.sleep(nanoseconds: 10_000_000)
        let env = parseEnvelope(captured()[0])
        let id = env?["id"] as? String ?? ""

        bridge.receive(rawBody: [
            "kind": "result",
            "id": id,
            "ok": false,
            "error": "nope",
        ])

        let outcome = await task.value
        XCTAssertEqual(outcome, "remote:nope")
    }

    // MARK: handle

    func testHandleSuccessReplyEnvelope() async throws {
        let (bridge, captured) = await makeBridge()
        struct Out: Encodable { let pong: Int }
        bridge.handle("ping") { _ in Out(pong: 42) }

        bridge.receive(rawBody: [
            "kind": "call",
            "id": "c-1",
            "method": "ping",
            "payload": [:],
        ])

        // The handler's Task resolves on the main actor; yield.
        try await Task.sleep(nanoseconds: 10_000_000)

        let outbound = captured()
        XCTAssertEqual(outbound.count, 1)
        let env = parseEnvelope(outbound[0])
        XCTAssertEqual(env?["kind"] as? String, "result")
        XCTAssertEqual(env?["id"] as? String, "c-1")
        XCTAssertEqual(env?["ok"] as? Bool, true)
        let value = env?["value"] as? [String: Any]
        XCTAssertEqual(value?["pong"] as? Int, 42)
    }

    func testHandleErrorReplyEnvelope() async throws {
        let (bridge, captured) = await makeBridge()
        struct HandlerError: Error {}
        bridge.handle("boom") { _ in throw HandlerError() }

        bridge.receive(rawBody: [
            "kind": "call",
            "id": "c-2",
            "method": "boom",
            "payload": [:],
        ])
        try await Task.sleep(nanoseconds: 10_000_000)

        let env = parseEnvelope(captured()[0])
        XCTAssertEqual(env?["kind"] as? String, "result")
        XCTAssertEqual(env?["id"] as? String, "c-2")
        XCTAssertEqual(env?["ok"] as? Bool, false)
        XCTAssertNotNil(env?["error"] as? String)
    }

    func testUnknownMethodRepliesOkFalse() async throws {
        let (bridge, captured) = await makeBridge()
        bridge.receive(rawBody: [
            "kind": "call",
            "id": "c-3",
            "method": "nobody-home",
            "payload": [:],
        ])
        // The reply path is synchronous for the "no handler" branch.
        let env = parseEnvelope(captured()[0])
        XCTAssertEqual(env?["ok"] as? Bool, false)
        XCTAssertTrue((env?["error"] as? String)?.contains("no handler") == true)
    }

    // MARK: on

    func testEventSubscriptionFiresHandler() async {
        let (bridge, _) = await makeBridge()
        var received: [String] = []
        bridge.on("tick") { data in
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            received.append(obj?["n"] as? String ?? "")
        }
        bridge.receive(rawBody: [
            "kind": "event",
            "name": "tick",
            "payload": ["n": "one"],
        ])
        XCTAssertEqual(received, ["one"])
    }

    // MARK: U+2028 escape

    func testU2028IsEscapedInOutboundLiteral() async throws {
        let (bridge, captured) = await makeBridge()
        struct P: Encodable { let s: String }
        bridge.emit("line", P(s: "a\u{2028}b\u{2029}c"))

        XCTAssertEqual(captured().count, 1)
        let js = captured()[0]
        XCTAssertFalse(js.contains("\u{2028}"), "U+2028 must be escaped")
        XCTAssertFalse(js.contains("\u{2029}"), "U+2029 must be escaped")
        XCTAssertTrue(js.contains("\\u2028"))
        XCTAssertTrue(js.contains("\\u2029"))
    }
}
