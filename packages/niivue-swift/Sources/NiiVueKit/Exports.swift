//
//  Exports.swift
//  NiiVueKit
//
//  Re-export BridgeCore so consumers need only `import NiiVueKit` to see
//  `Bridge`, `BridgeConfig`, wire helpers, and related types.
//
//  `@_exported` is an underscore-prefixed Swift compiler feature, i.e. not
//  covered by Swift's stability guarantees. It has been stable in practice
//  for years and is widely used (SwiftUI itself relies on it). If it ever
//  breaks, callers can add an explicit `import BridgeCore` alongside
//  `import NiiVueKit`.
//

@_exported import BridgeCore
