//
//  NiiVueModel.swift
//  NiiVueKit
//
//  @Observable view-model that mirrors NiiVue controller properties.
//  Every property is declared once and stays in sync via the generic
//  setProp / propChange bridge.
//
//  Adding a new bindable property:
//    1. Add a matching line to the JS-side allow-list (web-bridge).
//    2. Construct a `NiiVueProp<V>` on the model and call `register(_:)`.
//

import BridgeCore
import Foundation
import SwiftUI

@MainActor
@Observable
public final class NiiVueModel {
    public let bridge: Bridge

    // MARK: Registered properties (one line each)

    public let sliceTypeRaw:            NiiVueProp<Int>    = NiiVueProp(path: "sliceType",            initial: SliceType.multiplanar.rawValue)
    public let multiplanarTypeRaw:      NiiVueProp<Int>    = NiiVueProp(path: "multiplanarType",      initial: MultiplanarType.auto.rawValue)
    public let showRenderRaw:           NiiVueProp<Int>    = NiiVueProp(path: "showRender",           initial: ShowRender.auto.rawValue)
    public let mosaicString:            NiiVueProp<String> = NiiVueProp(path: "mosaicString",         initial: "")
    public let heroFraction:            NiiVueProp<Double> = NiiVueProp(path: "heroFraction",         initial: 0.5)
    public let isRadiological:          NiiVueProp<Bool>   = NiiVueProp(path: "isRadiological",       initial: false)

    public let isColorbarVisible:        NiiVueProp<Bool> = NiiVueProp(path: "isColorbarVisible",        initial: false)
    public let isOrientCubeVisible:      NiiVueProp<Bool> = NiiVueProp(path: "isOrientCubeVisible",      initial: false)
    public let isOrientationTextVisible: NiiVueProp<Bool> = NiiVueProp(path: "isOrientationTextVisible", initial: true)
    public let is3DCrosshairVisible:     NiiVueProp<Bool> = NiiVueProp(path: "is3DCrosshairVisible",     initial: false)
    public let isCrossLinesVisible:      NiiVueProp<Bool> = NiiVueProp(path: "isCrossLinesVisible",      initial: false)
    public let isRulerVisible:           NiiVueProp<Bool> = NiiVueProp(path: "isRulerVisible",           initial: false)
    public let isLegendVisible:          NiiVueProp<Bool> = NiiVueProp(path: "isLegendVisible",          initial: true)

    public let backgroundColor: NiiVueProp<[Double]> = NiiVueProp(path: "backgroundColor", initial: [0, 0, 0, 1])
    public let gamma:           NiiVueProp<Double>   = NiiVueProp(path: "gamma",           initial: 1.0)
    public let azimuth:         NiiVueProp<Double>   = NiiVueProp(path: "azimuth",         initial: 110.0)
    public let elevation:       NiiVueProp<Double>   = NiiVueProp(path: "elevation",       initial: 10.0)

    // MARK: Transient state (not synced via propChange)

    public var isReady: Bool = false
    public var locationText: String = "—"
    public var lastStatus: String = "Waiting for webview…"
    /// Current rendering backend. Updated from the `ready` event and from
    /// `backendChange` events after a user-initiated switch.
    public var currentBackend: Backend? = nil
    /// True while a backend switch is in flight so the UI can disable the picker.
    public var isSwitchingBackend: Bool = false

    // MARK: Dispatch table

    private var cells: [String: any AnyPropCell] = [:]

    // Suppresses pushToJS while applying inbound updates.
    private var isApplyingFromJS = false

    public init(bridge: Bridge, extraCells: [any AnyPropCell] = []) {
        self.bridge = bridge

        register(sliceTypeRaw)
        register(multiplanarTypeRaw)
        register(showRenderRaw)
        register(mosaicString)
        register(heroFraction)
        register(isRadiological)

        register(isColorbarVisible)
        register(isOrientCubeVisible)
        register(isOrientationTextVisible)
        register(is3DCrosshairVisible)
        register(isCrossLinesVisible)
        register(isRulerVisible)
        register(isLegendVisible)

        register(backgroundColor)
        register(gamma)
        register(azimuth)
        register(elevation)

        // Extras must be registered before wiring events so the first
        // `hydrate()` (triggered by `ready`) can populate them from the
        // JS-side snapshot.
        for cell in extraCells {
            registerAny(cell)
        }

        wireBridgeEvents()
    }

    // MARK: Typed enum accessors (wrap raw Int cells)

    public var sliceType: SliceType {
        get { SliceType(rawValue: sliceTypeRaw.value) ?? .multiplanar }
        set { sliceTypeRaw.value = newValue.rawValue }
    }

    public var multiplanarType: MultiplanarType {
        get { MultiplanarType(rawValue: multiplanarTypeRaw.value) ?? .auto }
        set { multiplanarTypeRaw.value = newValue.rawValue }
    }

    public var showRender: ShowRender {
        get { ShowRender(rawValue: showRenderRaw.value) ?? .auto }
        set { showRenderRaw.value = newValue.rawValue }
    }

    // MARK: Bindings

    /// Typed two-way binding for a cell. Works directly with SwiftUI
    /// controls (Toggle, Slider, Picker) without per-property boilerplate.
    public func binding<Value: Codable & Equatable>(
        _ keyPath: KeyPath<NiiVueModel, NiiVueProp<Value>>
    ) -> Binding<Value> {
        let cell = self[keyPath: keyPath]
        return Binding(
            get: { cell.value },
            set: { cell.value = $0 }
        )
    }

    public var sliceTypeBinding: Binding<SliceType> {
        Binding(get: { self.sliceType }, set: { self.sliceType = $0 })
    }

    public var multiplanarTypeBinding: Binding<MultiplanarType> {
        Binding(get: { self.multiplanarType }, set: { self.multiplanarType = $0 })
    }

    public var showRenderBinding: Binding<ShowRender> {
        Binding(get: { self.showRender }, set: { self.showRender = $0 })
    }

    // MARK: Actions

    /// Convenience: load a volume from raw bytes. Equivalent to a
    /// `loadVolume` bridge call with base64-encoded payload.
    public func loadVolume(data: Data, name: String) async throws {
        let payload = LoadVolumePayload(
            name: name,
            bytesBase64: data.base64EncodedString()
        )
        let _: OKReply = try await bridge.call("loadVolume", payload)
    }

    /// Convenience: load a volume from a file URL.
    public func loadVolume(url: URL) async throws {
        let data = try Data(contentsOf: url)
        try await loadVolume(data: data, name: url.lastPathComponent)
    }

    /// Request the web side to switch backends. NiiVue may downgrade the
    /// request (e.g. webgpu -> webgl2) if the adapter is unavailable; the
    /// returned value reflects what actually ended up active.
    public func setBackend(_ backend: Backend) async {
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
                // A reinitialized view drops all loaded volumes -- refresh
                // our mirror of NiiVue's property state.
                await hydrate()
            }
        } catch {
            lastStatus = "Backend switch failed: \(error)"
        }
    }

    /// Pull the current property snapshot from JS. Called after `ready`.
    public func hydrate() async {
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

    // MARK: Extension point

    /// Register an extra property cell beyond the defaults. The cell's
    /// `path` must exist in the JS-side allow-list too.
    ///
    /// Prefer the `extraCells:` init parameter when possible: cells added
    /// after `ready` fire will miss the automatic `hydrate()` and start at
    /// their `initial` value until the JS side emits the next change.
    public func registerExtra<V: Codable & Equatable>(_ cell: NiiVueProp<V>) {
        register(cell)
    }

    // MARK: Internal

    private func pushToJS(path: String, value: AnyEncodable) {
        guard !isApplyingFromJS else { return }
        let payload = SetPropPayload(path: path, value: value)
        Task {
            do {
                let _: OKReply = try await bridge.call("setProp", payload)
            } catch {
                print("[NiiVueModel] setProp \(path) failed: \(error)")
            }
        }
    }

    private func register(_ cell: any AnyPropCell) {
        cell.attach { [weak self] path, value in
            self?.pushToJS(path: path, value: value)
        }
        cells[cell.path] = cell
    }

    /// Type-erased register used for `extraCells` at init-time. Kept as a
    /// distinct name for call-site clarity; forwards to `register`.
    private func registerAny(_ cell: any AnyPropCell) {
        register(cell)
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
