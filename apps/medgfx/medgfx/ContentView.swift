//
//  ContentView.swift
//  medgfx
//

import NiiVueKit
import SwiftUI
import UniformTypeIdentifiers

struct ContentView: View {
    @State private var bridge: Bridge
    @State private var model: NiiVueModel
    @State private var isInspectorVisible: Bool = true
    @State private var isLoading = false
    @State private var isFileImporterPresented = false
    @State private var isDropTargeted = false

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
                viewer

                if useInlineInspector && isInspectorVisible {
                    Divider()
                    InspectorContainer(model: model)
                        .transition(.move(edge: .trailing))
                }
            }

            Divider()
            footer
        }
        .sheet(isPresented: sheetBinding) {
            #if os(iOS)
            NavigationStack {
                InspectorContainer(
                    model: model,
                    fillsAvailableWidth: true
                )
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
        .fileImporter(
            isPresented: $isFileImporterPresented,
            allowedContentTypes: [.data],
            allowsMultipleSelection: true,
            onCompletion: handleFileImport
        )
    }

    private var viewer: some View {
        ZStack {
            NiiVueWebView(bridge: bridge)

            if isDropTargeted {
                RoundedRectangle(cornerRadius: 12)
                    .fill(.tint.opacity(0.15))
                    .overlay {
                        RoundedRectangle(cornerRadius: 12)
                            .stroke(.tint, lineWidth: 3)
                    }
                    .padding(12)
                    .allowsHitTesting(false)

                Label("Drop images to load", systemImage: "square.and.arrow.down")
                    .font(.headline)
                    .padding()
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
                    .allowsHitTesting(false)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .dropDestination(for: URL.self) { urls, _ in
            guard !urls.isEmpty, !isLoading else { return false }
            Task { await loadFiles(urls) }
            return true
        } isTargeted: { isTargeted in
            isDropTargeted = isTargeted
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
            addImageMenu
        }

        #if os(macOS)
        ToolbarItem(placement: .principal) {
            viewModePicker
                .frame(minWidth: 440)
        }
        #else
        ToolbarItem(placement: .primaryAction) {
            viewModePicker
        }
        #endif

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

    private var addImageMenu: some View {
        Menu {
            Button("Load Example") {
                Task { await loadSample() }
            }

            Button("Browse Files…") {
                isFileImporterPresented = true
            }
            .keyboardShortcut("o", modifiers: .command)
        } label: {
            Label("Add Image", systemImage: "plus")
        }
        .help("Add an image")
        .disabled(isLoading)
    }

    @ViewBuilder
    private var viewModePicker: some View {
        let setting = InspectorSettings.viewMode
        SettingPicker(setting: setting, model: model)
        #if os(macOS)
        .pickerStyle(.segmented)
        .labelsHidden()
        #else
        .pickerStyle(.menu)
        #endif
        .help(setting.help)
    }

    // MARK: Footer

    private var footer: some View {
        HStack(spacing: 12) {
            if isLoading {
                ProgressView()
                    .controlSize(.small)
            }

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

    private func handleFileImport(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            guard !urls.isEmpty else { return }
            Task { await loadFiles(urls) }
        case .failure(let error):
            model.lastStatus = "Open failed: \(error.localizedDescription)"
        }
    }

    private func loadFiles(_ urls: [URL]) async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }

        var loadedCount = 0
        for url in urls {
            let hasAccess = url.startAccessingSecurityScopedResource()
            defer {
                if hasAccess { url.stopAccessingSecurityScopedResource() }
            }

            do {
                model.lastStatus = "Loading \(url.lastPathComponent)…"
                try await model.loadVolume(url: url)
                loadedCount += 1
            } catch {
                model.lastStatus = "Could not load \(url.lastPathComponent): \(error.localizedDescription)"
                return
            }
        }

        if loadedCount == 1, let name = urls.first?.lastPathComponent {
            model.lastStatus = name
        } else {
            model.lastStatus = "\(loadedCount) images"
        }
    }

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
            model.lastStatus = "mni152.nii.gz (\(kb) KB)"
        } catch {
            model.lastStatus = "Load failed: \(error)"
        }
    }
}

#Preview {
    ContentView()
}
