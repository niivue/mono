//
//  NiiVueModelTests.swift
//  NiiVueKitTests
//
//  Covers the NiiVueModel <-> Bridge wiring:
//    - outbound writes turn into `setProp` envelopes
//    - inbound `propChange` updates cells without echoing (echo-suppression)
//    - `ready` triggers `hydrate()` -> `getProps` call
//    - `extraCells` registered at init are visible for inbound updates
//

import XCTest
@testable import BridgeCore
@testable import NiiVueKit

@MainActor
final class NiiVueModelTests: XCTestCase {
    private struct Harness {
        let bridge: Bridge
        let model: NiiVueModel
        let captured: () -> [String]
    }

    private func parseEnvelope(_ js: String) -> [String: Any]? {
        guard let start = js.firstIndex(of: "("),
              let end = js.lastIndex(of: ")")
        else { return nil }
        let jsonSlice = js[js.index(after: start)..<end]
        guard let data = String(jsonSlice).data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func makeHarness(
        extra: [any AnyPropCell] = [],
        ready: Bool = true
    ) async -> Harness {
        let bridge = Bridge(config: .default)
        var captured: [String] = []
        bridge._testOutboundSink = { captured.append($0) }
        let model = NiiVueModel(bridge: bridge, extraCells: extra)
        if ready {
            bridge.receive(rawBody: ["kind": "event", "name": "ready"])
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return Harness(bridge: bridge, model: model, captured: { captured })
    }

    // MARK: outbound writes

    func testSettingCellValueEmitsSetPropCall() async throws {
        let h = await makeHarness()
        h.model.isColorbarVisible.value = true

        try await Task.sleep(nanoseconds: 10_000_000)

        let outbound = h.captured()
        // 1st envelope is the auto `getProps` triggered by the ready event's
        // hydrate; 2nd is our setProp.
        let setProp = outbound
            .compactMap { parseEnvelope($0) }
            .first { ($0["method"] as? String) == "setProp" }
        XCTAssertNotNil(setProp, "expected a setProp envelope")

        let payload = setProp?["payload"] as? [String: Any]
        XCTAssertEqual(payload?["path"] as? String, "isColorbarVisible")
        XCTAssertEqual(payload?["value"] as? Bool, true)
    }

    func testEnumWrapperPushesRawInt() async throws {
        let h = await makeHarness()
        h.model.sliceType = .axial
        try await Task.sleep(nanoseconds: 10_000_000)

        let envelopes = h.captured().compactMap { parseEnvelope($0) }
        let setProp = envelopes.first { ($0["method"] as? String) == "setProp" }
        XCTAssertNotNil(setProp)
        let payload = setProp?["payload"] as? [String: Any]
        XCTAssertEqual(payload?["path"] as? String, "sliceType")
        XCTAssertEqual(payload?["value"] as? Int, SliceType.axial.rawValue)
    }

    // MARK: inbound propChange + echo suppression

    func testPropChangeUpdatesCell() async throws {
        let h = await makeHarness()
        XCTAssertFalse(h.model.isColorbarVisible.value)

        h.bridge.receive(rawBody: [
            "kind": "event",
            "name": "propChange",
            "payload": ["path": "isColorbarVisible", "value": true],
        ])
        try await Task.sleep(nanoseconds: 10_000_000)

        XCTAssertTrue(h.model.isColorbarVisible.value)
    }

    func testPropChangeDoesNotEchoBack() async throws {
        let h = await makeHarness()

        // Clear anything already captured from the ready/hydrate path.
        let baseline = h.captured().count

        h.bridge.receive(rawBody: [
            "kind": "event",
            "name": "propChange",
            "payload": ["path": "gamma", "value": 1.7],
        ])

        // Give any stray Task a moment.
        try await Task.sleep(nanoseconds: 10_000_000)

        // Value updated...
        XCTAssertEqual(h.model.gamma.value, 1.7)
        // ...without producing an outbound setProp.
        let newEnvelopes = h.captured().dropFirst(baseline).compactMap { parseEnvelope($0) }
        let setProps = newEnvelopes.filter { ($0["method"] as? String) == "setProp" }
        XCTAssertEqual(setProps.count, 0, "inbound update must not echo as setProp")
    }

    // MARK: ready -> hydrate

    func testReadyTriggersGetPropsCall() async throws {
        // Build without auto-ready so we can observe the envelope ordering.
        let h = await makeHarness(ready: false)
        h.bridge.receive(rawBody: ["kind": "event", "name": "ready"])
        try await Task.sleep(nanoseconds: 10_000_000)

        let envelopes = h.captured().compactMap { parseEnvelope($0) }
        let getProps = envelopes.first { ($0["method"] as? String) == "getProps" }
        XCTAssertNotNil(getProps, "ready should trigger a getProps hydration call")
    }

    func testReadyEventSetsBackendFromPayload() async throws {
        let h = await makeHarness(ready: false)
        h.bridge.receive(rawBody: [
            "kind": "event",
            "name": "ready",
            "payload": ["backend": "webgpu"],
        ])
        // Let the ready handler's Task run.
        try await Task.sleep(nanoseconds: 10_000_000)
        XCTAssertEqual(h.model.currentBackend, .webgpu)
        XCTAssertTrue(h.model.isReady)
    }

    // MARK: backendChange

    func testBackendChangeEventUpdatesCurrentBackend() async throws {
        let h = await makeHarness()
        h.bridge.receive(rawBody: [
            "kind": "event",
            "name": "backendChange",
            "payload": ["backend": "webgl2"],
        ])
        try await Task.sleep(nanoseconds: 10_000_000)
        XCTAssertEqual(h.model.currentBackend, .webgl2)
    }

    // MARK: extraCells

    func testExtraCellReceivesInboundPropChange() async throws {
        let crosshair = NiiVueProp<[Double]>(path: "crosshairColor", initial: [1, 0, 0, 1])
        let h = await makeHarness(extra: [crosshair])

        h.bridge.receive(rawBody: [
            "kind": "event",
            "name": "propChange",
            "payload": ["path": "crosshairColor", "value": [0, 1, 0, 1]],
        ])
        try await Task.sleep(nanoseconds: 10_000_000)

        XCTAssertEqual(crosshair.value, [0, 1, 0, 1])
    }

    func testExtraCellWritePushesSetProp() async throws {
        let crosshair = NiiVueProp<[Double]>(path: "crosshairColor", initial: [1, 0, 0, 1])
        let h = await makeHarness(extra: [crosshair])

        crosshair.value = [0, 0, 1, 1]
        try await Task.sleep(nanoseconds: 10_000_000)

        let envelopes = h.captured().compactMap { parseEnvelope($0) }
        let setProp = envelopes.first { env in
            (env["method"] as? String) == "setProp"
                && ((env["payload"] as? [String: Any])?["path"] as? String) == "crosshairColor"
        }
        XCTAssertNotNil(setProp)
    }

    // MARK: locationChange

    func testLocationChangeUpdatesLocationText() async throws {
        let h = await makeHarness()
        h.bridge.receive(rawBody: [
            "kind": "event",
            "name": "locationChange",
            "payload": ["mm": [1.0, 2.0, 3.0], "voxel": [10.0, 20.0, 30.0], "string": "X=1 Y=2 Z=3"],
        ])
        try await Task.sleep(nanoseconds: 10_000_000)
        XCTAssertEqual(h.model.locationText, "X=1 Y=2 Z=3")
    }

    func testEmptyLocationStringFallsBackToDash() async throws {
        let h = await makeHarness()
        h.bridge.receive(rawBody: [
            "kind": "event",
            "name": "locationChange",
            "payload": ["string": ""],
        ])
        try await Task.sleep(nanoseconds: 10_000_000)
        XCTAssertEqual(h.model.locationText, "—")
    }
}
