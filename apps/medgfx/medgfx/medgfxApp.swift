//
//  medgfxApp.swift
//  medgfx
//

import SwiftUI

@main
struct medgfxApp: App {
    var body: some Scene {
        #if os(macOS)
        WindowGroup {
            ContentView()
        }
        .commands {
            AboutCommands()
        }

        Window("About medgfx", id: "about") {
            AboutView()
        }
        .windowResizability(.contentSize)
        #else
        WindowGroup {
            ContentView()
        }
        #endif
    }
}
