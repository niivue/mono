//
//  AboutView.swift
//  medgfx
//

#if os(macOS)
import SwiftUI

struct AboutView: View {
    private var versionDescription: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "Unknown"
        let build = info?["CFBundleVersion"] as? String

        guard let build, !build.isEmpty else { return version }
        return "\(version) (\(build))"
    }

    var body: some View {
        VStack(spacing: 16) {
            VStack(spacing: 6) {
                Text("medgfx")
                    .font(.largeTitle.bold())
                Text("Version \(versionDescription)")
                    .foregroundStyle(.secondary)
            }

            Text("A native medical image viewer powered by NiiVue.")
                .multilineTextAlignment(.center)

            VStack(spacing: 4) {
                Text("Authors")
                    .font(.headline)

                ForEach(MedgfxAboutAuthors.names, id: \.self) { author in
                    Text(author)
                }
            }

            HStack(spacing: 16) {
                if let repositoryURL = URL(string: "https://github.com/niivue/mono") {
                    Link("GitHub Repository", destination: repositoryURL)
                }

                if let websiteURL = URL(string: "https://niivue.com") {
                    Link("niivue.com", destination: websiteURL)
                }
            }
        }
        .padding(28)
        .frame(width: 420)
    }
}

struct AboutCommands: Commands {
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(replacing: .appInfo) {
            Button("About medgfx") {
                openWindow(id: "about")
            }
        }
    }
}
#endif
