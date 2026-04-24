//
//  NiiVueModel.swift
//  medgfx
//
//  @Observable view-model that mirrors NiiVue controller properties.
//  Every property is declared once and stays in sync via the generic
//  setProp / propChange bridge.
//
//  Adding a new bindable property is one line here plus one line in
//  apps/medgfx/web/src/prop-allowlist.ts.
//

import Foundation
import SwiftUI

@MainActor
@Observable
final class NiiVueModel {
    let bridge: Bridge

    // MARK: Registered properties (one line each)

    let sliceTypeRaw:            NiiVueProp<Int>    = NiiVueProp(path: "sliceType",            initial: SliceType.multiplanar.rawValue)
    let multiplanarTypeRaw:      NiiVueProp<Int>    = NiiVueProp(path: "multiplanarType",      initial: MultiplanarType.auto.rawValue)
    let showRenderRaw:           NiiVueProp<Int>    = NiiVueProp(path: "showRender",           initial: ShowRender.auto.rawValue)
    let mosaicString:            NiiVueProp<String> = NiiVueProp(path: "mosaicString",         initial: "")
    let heroFraction:            NiiVueProp<Double> = NiiVueProp(path: "heroFraction",         initial: 0.5)
    let isRadiological:          NiiVueProp<Bool>   = NiiVueProp(path: "isRadiological",       initial: false)

    let isColorbarVisible:        NiiVueProp<Bool> = NiiVueProp(path: "isColorbarVisible",        initial: false)
    let isOrientCubeVisible:      NiiVueProp<Bool> = NiiVueProp(path: "isOrientCubeVisible",      initial: false)
    let isOrientationTextVisible: NiiVueProp<Bool> = NiiVueProp(path: "isOrientationTextVisible", initial: true)
    let is3DCrosshairVisible:     NiiVueProp<Bool> = NiiVueProp(path: "is3DCrosshairVisible",     initial: false)
    let isCrossLinesVisible:      NiiVueProp<Bool> = NiiVueProp(path: "isCrossLinesVisible",      initial: false)
    let isRulerVisible:           NiiVueProp<Bool> = NiiVueProp(path: "isRulerVisible",           initial: false)
    let isLegendVisible:          NiiVueProp<Bool> = NiiVueProp(path: "isLegendVisible",          initial: true)

    let backgroundColor: NiiVueProp<[Double]> = NiiVueProp(path: "backgroundColor", initial: [0, 0, 0, 1])
    let gamma:           NiiVueProp<Double>   = NiiVueProp(path: "gamma",           initial: 1.0)
    let azimuth:         NiiVueProp<Double>   = NiiVueProp(path: "azimuth",         initial: 110.0)
    let elevation:       NiiVueProp<Double>   = NiiVueProp(path: "elevation",       initial: 10.0)

    // MARK: Transient state (not synced via propChange)

    var isReady: Bool = false
    var locationText: String = "—"
    var lastStatus: String = "Waiting for webview…"
    /// Current rendering backend. Updated from the `ready` event and from
    /// `backendChange` events after a user-initiated switch.
    var currentBackend: Backend? = nil
    /// True while a backend switch is in flight so the UI can disable the picker.
    var isSwitchingBackend: Bool = false

    // MARK: Dispatch table

    private var cells: [String: any AnyPropCell] = [:]

    // Suppresses pushToJS while applying inbound updates.
    private var isApplyingFromJS = false

    init(bridge: Bridge) {
        self.bridge = bridge

        register(sliceTypeRaw) { [weak self] p, v in self?.pushToJS(path: p, value: v) }
        register(multiplanarTypeRaw) { [weak self] p, v in self?.pushToJS(path: p, value: v) }
        register(showRenderRaw) { [weak self] p, v in self?.pushToJS(path: p, value: v) }
        register(mosaicString) { [weak self] p, v in self?.pushToJS(path: p, value: v) }
        register(heroFraction) { [weak self] p, v in self?.pushToJS(path: p, value: v) }
        register(isRadiological) { [weak self] p, v in self?.pushToJS(path: p, value: v) }

        register(isColorbarVisible) { [weak self] p, v in self?.pushToJS(path: p, value: v) }
        register(isOrientCubeVisible) { [weak self] p, v in self?.pushToJS(path: p, value: v) }
        register(isOrientationTextVisible) { [weak self] p, v in self?.pushToJS(path: p, value: v) }
        register(is3DCrosshairVisible) { [weak self] p, v in self?.pushToJS(path: p, value: v) }
        register(isCrossLinesVisible) { [weak self] p, v in self?.pushToJS(path: p, value: v) }
        register(isRulerVisible) { [weak self] p, v in self?.pushToJS(path: p, value: v) }
        register(isLegendVisible) { [weak self] p, v in self?.pushToJS(path: p, value: v) }

        register(backgroundColor) { [weak self] p, v in self?.pushToJS(path: p, value: v) }
        register(gamma) { [weak self] p, v in self?.pushToJS(path: p, value: v) }
        register(azimuth) { [weak self] p, v in self?.pushToJS(path: p, value: v) }
        register(elevation) { [weak self] p, v in self?.pushToJS(path: p, value: v) }

        wireBridgeEvents()
    }

    // MARK: Typed enum accessors (wrap raw Int cells)

    var sliceType: SliceType {
        get { SliceType(rawValue: sliceTypeRaw.value) ?? .multiplanar }
        set { sliceTypeRaw.value = newValue.rawValue }
    }

    var multiplanarType: MultiplanarType {
        get { MultiplanarType(rawValue: multiplanarTypeRaw.value) ?? .auto }
        set { multiplanarTypeRaw.value = newValue.rawValue }
    }

    var showRender: ShowRender {
        get { ShowRender(rawValue: showRenderRaw.value) ?? .auto }
        set { showRenderRaw.value = newValue.rawValue }
    }

    // MARK: Bindings

    /// Typed two-way binding for a cell. Works directly with SwiftUI controls
    /// (Toggle, Slider, Picker) without per-property boilerplate.
    func binding<Value: Codable & Equatable>(_ keyPath: KeyPath<NiiVueModel, NiiVueProp<Value>>) -> Binding<Value> {
        let cell = self[keyPath: keyPath]
        return Binding(
            get: { cell.value },
            set: { cell.value = $0 }
        )
    }

    var sliceTypeBinding: Binding<SliceType> {
        Binding(get: { self.sliceType }, set: { self.sliceType = $0 })
    }

    var multiplanarTypeBinding: Binding<MultiplanarType> {
        Binding(get: { self.multiplanarType }, set: { self.multiplanarType = $0 })
    }

    var showRenderBinding: Binding<ShowRender> {
        Binding(get: { self.showRender }, set: { self.showRender = $0 })
    }

    // MARK: Actions

    /// Request the web side to switch backends. NiiVue may downgrade the
    /// request (e.g. webgpu → webgl2) if the adapter is unavailable; the
    /// returned value reflects what actually ended up active.
    func setBackend(_ backend: Backend) async {
        guard !isSwitchingBackend else { return }
        guard currentBackend != backend else { return }
        isSwitchingBackend = true
        defer { isSwitchingBackend = false }
        do {
            let payload = SetBackendPayload(backend: backend.rawValue)
            let reply: SetBackendReply = try await bridge.call("setBackend", payload)
            if let resolved = Backend(rawValue: reply.backend) {
                currentBackend = resolved
                lastStatus = "Backend: \(resolved.label)"
                // A reinitialized view drops all loaded volumes — refresh our
                // mirror of NiiVue's property state from the new controller.
                await hydrate()
            }
        } catch {
            lastStatus = "Backend switch failed: \(error)"
        }
    }

    /// Pull current property snapshot from JS. Called after `ready`.
    func hydrate() async {
        do {
            let snapshot: [String: AnyJSON] = try await bridge.call("getProps", EmptyPayload())
            isApplyingFromJS = true
            defer { isApplyingFromJS = false }
            for (path, box) in snapshot {
                cells[path]?.applyFromJS(box.raw)
            }
        } catch {
            print("[NiiVueModel] hydrate failed: \(error)")
        }
    }

    // MARK: Internal — invoked by each cell's pusher closure

    private func pushToJS<V: Encodable>(path: String, value: V) {
        guard !isApplyingFromJS else { return }
        let payload = SetPropPayload(path: path, value: AnyEncodable(value))
        Task {
            do {
                let _: OKReply = try await bridge.call("setProp", payload)
            } catch {
                print("[NiiVueModel] setProp \(path) failed: \(error)")
            }
        }
    }

    // MARK: Private

    private func register<V: Codable & Equatable>(
        _ cell: NiiVueProp<V>,
        pusher: @escaping (String, V) -> Void
    ) {
        cell.pusher = pusher
        cells[cell.path] = cell
    }

    private func wireBridgeEvents() {
        bridge.on("ready") { [weak self] data in
            guard let self else { return }
            let payload = try? JSONDecoder().decode(ReadyPayload.self, from: data)
            Task { @MainActor in
                self.isReady = true
                self.lastStatus = "Ready"
                if let raw = payload?.backend, let backend = Backend(rawValue: raw) {
                    self.currentBackend = backend
                }
                await self.hydrate()
            }
        }
        bridge.on("backendChange") { [weak self] data in
            guard let self else { return }
            let payload = try? JSONDecoder().decode(BackendChangePayload.self, from: data)
            Task { @MainActor in
                if let raw = payload?.backend, let backend = Backend(rawValue: raw) {
                    self.currentBackend = backend
                }
            }
        }
        bridge.on("propChange") { [weak self] data in
            guard let self else { return }
            guard let env = try? JSONDecoder().decode(PropChangeEnvelope.self, from: data) else {
                return
            }
            Task { @MainActor in
                self.isApplyingFromJS = true
                defer { self.isApplyingFromJS = false }
                self.cells[env.path]?.applyFromJS(env.value.raw)
            }
        }
        bridge.on("locationChange") { [weak self] data in
            guard let self else { return }
            guard let payload = try? JSONDecoder().decode(LocationChangeEnvelope.self, from: data) else {
                return
            }
            Task { @MainActor in
                self.locationText = payload.string.isEmpty ? "—" : payload.string
            }
        }
    }
}

// MARK: - Wire types

struct SetPropPayload: Encodable {
    let path: String
    let value: AnyEncodable
}

struct OKReply: Decodable {
    let ok: Bool
}

/// JSON blob that preserves the raw `Any` so we can forward to a cell without
/// knowing its concrete type at decode time.
struct AnyJSON: Decodable {
    let raw: Any

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let v = try? container.decode(Bool.self)   { raw = v; return }
        if let v = try? container.decode(Double.self) { raw = v; return }
        if let v = try? container.decode(String.self) { raw = v; return }
        if let v = try? container.decode([AnyJSON].self) { raw = v.map { $0.raw }; return }
        if let v = try? container.decode([String: AnyJSON].self) {
            raw = v.mapValues { $0.raw }; return
        }
        raw = NSNull()
    }
}

private struct PropChangeEnvelope: Decodable {
    let path: String
    let value: AnyJSON
}

private struct LocationChangeEnvelope: Decodable {
    let mm: [Double]?
    let voxel: [Double]?
    let string: String
}

private struct ReadyPayload: Decodable {
    let backend: String?
}

private struct BackendChangePayload: Decodable {
    let backend: String
}

struct SetBackendPayload: Encodable {
    let backend: String
}

struct SetBackendReply: Decodable {
    let backend: String
}
