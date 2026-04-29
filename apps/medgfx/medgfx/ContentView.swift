//
//  ContentView.swift
//  medgfx
//

import NiiVueKit
import SwiftUI

struct ContentView: View {
    @State private var bridge: Bridge
    @State private var model: NiiVueModel
    @State private var isInspectorVisible: Bool = true
    @State private var isLoading = false

    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif

    init() {
        // medgfx ships its own web bundle under Contents/Resources/WebApp/
        // (copied by the "Build and embed medgfx-web" Run Script phase).
        // We start from BridgeConfig.default (handler "niivue" + scheme
        // "niivue-app://" + Bundle.main/WebApp/) and layer on the dev
        // server URL used in DEBUG builds so Vite HMR works.
        let config = BridgeConfig.default.withDevServer(port: 8083)
        let b = Bridge(config: config)
        _bridge = State(initialValue: b)
        _model = State(initialValue: NiiVueModel(bridge: b))
    }

    var body: some View {
        #if os(macOS)
        mainLayout
            .toolbar { toolbarContent }
        #else
        NavigationStack {
            mainLayout
                .toolbar { toolbarContent }
                .navigationTitle("medgfx")
                .navigationBarTitleDisplayMode(.inline)
        }
        #endif
    }

    // MARK: Layout

    /// True when the inline sidebar layout should be used. iPhone (compact)
    /// falls back to a sheet instead so the WebView isn't squeezed.
    private var useInlineInspector: Bool {
        #if os(macOS)
        return true
        #else
        return horizontalSizeClass == .regular
        #endif
    }

    @ViewBuilder
    private var mainLayout: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                NiiVueWebView(bridge: bridge)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)

                if useInlineInspector && isInspectorVisible {
                    Divider()
                    InspectorContainer(model: model, panels: InspectorPanels.all)
                        .transition(.move(edge: .trailing))
                }
            }

            Divider()
            footer
        }
        .sheet(isPresented: sheetBinding) {
            #if os(iOS)
            NavigationStack {
                InspectorContainer(model: model, panels: InspectorPanels.all)
                    .navigationTitle("Inspector")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { isInspectorVisible = false }
                        }
                    }
            }
            .presentationDetents([.medium, .large])
            #else
            EmptyView()
            #endif
        }
    }

    /// A binding that only drives the sheet on iPhone — on macOS and iPad
    /// the sheet is never presented (inline sidebar handles it).
    private var sheetBinding: Binding<Bool> {
        Binding(
            get: { !useInlineInspector && isInspectorVisible },
            set: { newValue in
                if !useInlineInspector { isInspectorVisible = newValue }
            }
        )
    }

    // MARK: Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isInspectorVisible.toggle()
                }
            } label: {
                Label(
                    isInspectorVisible ? "Hide Inspector" : "Show Inspector",
                    systemImage: "sidebar.trailing"
                )
            }
        }
    }

    // MARK: Footer

    private var footer: some View {
        HStack(spacing: 12) {
            Button {
                Task { await loadSample() }
            } label: {
                if isLoading {
                    ProgressView().controlSize(.small)
                } else {
                    Text("Load sample")
                }
            }
            .disabled(isLoading)

            Text(model.lastStatus)
                .font(.caption)
                .foregroundStyle(.secondary)

            Spacer()

            Text(model.locationText)
                .font(.system(.caption, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        #if os(macOS)
        .background(.regularMaterial)
        #else
        .background(Color(.systemBackground))
        #endif
    }

    // MARK: Actions

    private func loadSample() async {
        guard let url = Bundle.main.url(forResource: "mni152", withExtension: "nii.gz") else {
            model.lastStatus = "mni152.nii.gz not in bundle"
            return
        }
        isLoading = true
        defer { isLoading = false }
        do {
            try await model.loadVolume(url: url)
            let kb = (try? Data(contentsOf: url).count).map { $0 / 1024 } ?? 0
            model.lastStatus = "Loaded mni152.nii.gz (\(kb) KB)"
        } catch {
            model.lastStatus = "Load failed: \(error)"
        }
    }
}

#Preview {
    ContentView()
}
