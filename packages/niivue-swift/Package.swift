// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "NiiVueKit",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
        .macCatalyst(.v17),
        .visionOS(.v1),
    ],
    products: [
        // Transport-level envelope bridge, no NiiVue knowledge. Pair with a
        // web bundle that speaks the matching protocol (@niivue/web-bridge).
        .library(name: "BridgeCore", targets: ["BridgeCore"]),
        // BridgeCore + SwiftUI NiiVueWebView + NiiVue view-model. The common
        // import for apps that embed a NiiVue web view.
        .library(name: "NiiVueKit", targets: ["NiiVueKit"]),
    ],
    targets: [
        .target(
            name: "BridgeCore",
            path: "Sources/BridgeCore"
        ),
        .target(
            name: "NiiVueKit",
            dependencies: ["BridgeCore"],
            path: "Sources/NiiVueKit",
            exclude: ["Resources/WebApp/README.md"],
            resources: [
                .copy("Resources/WebApp"),
            ]
        ),
        .testTarget(
            name: "BridgeCoreTests",
            dependencies: ["BridgeCore"],
            path: "Tests/BridgeCoreTests"
        ),
        .testTarget(
            name: "NiiVueKitTests",
            dependencies: ["NiiVueKit"],
            path: "Tests/NiiVueKitTests"
        ),
    ]
)
