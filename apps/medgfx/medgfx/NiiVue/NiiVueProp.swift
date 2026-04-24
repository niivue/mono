//
//  NiiVueProp.swift
//  medgfx
//
//  Low-level property cells used by NiiVueModel. Each cell remembers its
//  JS path, its current value, and how to encode/decode itself across the
//  bridge. The model holds a `[String: any AnyPropCell]` dispatch table so
//  incoming propChange events can be routed to the right cell by path.
//

import Foundation

/// Erased protocol so the model can store heterogeneous cells in one dict
/// and forward inbound JSON payloads to them without knowing the concrete type.
@MainActor
protocol AnyPropCell: AnyObject {
    var path: String { get }
    /// Update the cell from a JS-supplied JSON value (the `value` field of
    /// a propChange event). Must NOT echo back to JS.
    func applyFromJS(_ any: Any)
}

/// A single bound property. Generic over any `Codable & Equatable` value.
///
/// Writes to `value` invoke `pusher` with the JS path and new value.
/// Inbound `applyFromJS` calls update `value` without invoking `pusher`.
@MainActor
@Observable
final class NiiVueProp<Value: Codable & Equatable>: AnyPropCell {
    let path: String

    private var _value: Value
    /// Injected by the model after construction. Takes (path, value).
    var pusher: ((String, Value) -> Void)?

    init(path: String, initial: Value) {
        self.path = path
        self._value = initial
    }

    var value: Value {
        get { _value }
        set {
            guard _value != newValue else { return }
            _value = newValue
            pusher?(path, newValue)
        }
    }

    func applyFromJS(_ any: Any) {
        guard let data = try? JSONSerialization.data(
            withJSONObject: any,
            options: [.fragmentsAllowed]
        ) else { return }
        guard let decoded = try? JSONDecoder().decode(Value.self, from: data) else { return }
        if _value != decoded {
            _value = decoded
        }
    }
}
