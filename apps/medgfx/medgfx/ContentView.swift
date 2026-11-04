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
    @State private var importAddsOverlays = false
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
            .navigationTitle(model.volumes.first?.title ?? "medgfx")
            .navigationSubtitle(documentSubtitle)
        #else
        NavigationStack {
            mainLayout
                .toolbar { toolbarContent }
                .navigationTitle(model.volumes.first?.title ?? "medgfx")
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

                if useInlineInspector && isInspectorVisible && hasImage {
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

            // Opaque, so it also covers NiiVue's own "No image loaded" banner.
            if !hasImage {
                emptyState
            } else if isDropTargeted {
                RoundedRectangle(cornerRadius: 12)
                    .fill(.tint.opacity(0.15))
                    .overlay {
                        RoundedRectangle(cornerRadius: 12)
                            .stroke(.tint, lineWidth: 3)
                    }
                    .padding(12)
                    .allowsHitTesting(false)

                Label(dropHint, systemImage: "square.and.arrow.down")
                    .font(.headline)
                    .padding()
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
                    .allowsHitTesting(false)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .dropDestination(for: URL.self) { urls, _ in
            guard !urls.isEmpty, !isLoading else { return false }
            Task { await loadFiles(urls, addingToCurrent: isAddModifierHeld) }
            return true
        } isTargeted: { isTargeted in
            isDropTargeted = isTargeted
        }
    }

    #if os(macOS)
    private let dropHint = "Drop to replace · hold ⌘ to add"
    private var isAddModifierHeld: Bool {
        !NSEvent.modifierFlags.isDisjoint(with: [.command, .control])
    }
    #else
    // SwiftUI drops carry no modifier state on iOS; Add Overlay… adds there.
    private let dropHint = "Drop to replace"
    private let isAddModifierHeld = false
    #endif

    private var hasImage: Bool { !model.volumes.isEmpty || !model.meshes.isEmpty || model.hasSignal }

    private var emptyState: some View {
        ZStack {
            Color.black

            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [6, 5]))
                .foregroundStyle(isDropTargeted ? AnyShapeStyle(.tint) : AnyShapeStyle(.quaternary))
                .padding(24)

            VStack(spacing: 0) {
                Image(systemName: "square.3.layers.3d")
                    .font(.system(size: 44, weight: .ultraLight))
                    .foregroundStyle(.secondary)
                Text("Open an image")
                    .font(.title2.weight(.semibold))
                    .padding(.top, 20)
                Text("Drop a volume or mesh anywhere in this window.\nFiles are read on this device and never uploaded.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                    .padding(.top, 6)
                HStack(spacing: 10) {
                    Button("Open…") { isFileImporterPresented = true }
                        .buttonStyle(.borderedProminent)
                    Button("Try Sample Brain") { Task { await loadSample() } }
                }
                .controlSize(.large)
                .disabled(isLoading || !model.isReady)
                .padding(.top, 22)
            }
            .padding(40)
        }
        .environment(\.colorScheme, .dark)
    }

    /// "207 × 256 × 215 · 0.74 mm · 2 layers" for the base volume.
    private var documentSubtitle: String {
        guard let base = model.volumes.first else { return "" }
        let dims = base.dims.map(String.init).joined(separator: " × ")
        let voxel = base.pixDims.map { $0.formatted(.number.precision(.significantDigits(1...3))) }
        let size = Set(voxel).count == 1 ? "\(voxel[0]) mm" : voxel.joined(separator: " × ") + " mm"
        let layers = model.volumes.count == 1 ? "1 layer" : "\(model.volumes.count) layers"
        return [dims, size, layers].joined(separator: " · ")
    }

    /// A binding that only drives the sheet on iPhone — on macOS and iPad
    /// the sheet is never presented (inline sidebar handles it).
    private var sheetBinding: Binding<Bool> {
        Binding(
            get: { !useInlineInspector && isInspectorVisible && hasImage },
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
            .disabled(!hasImage)
        }
    }

    private var addImageMenu: some View {
        Menu {
            Button("Open…") {
                importAddsOverlays = false
                isFileImporterPresented = true
            }
            .keyboardShortcut("o", modifiers: .command)

            Button("Add Overlay…") {
                importAddsOverlays = true
                isFileImporterPresented = true
            }
            .keyboardShortcut("o", modifiers: [.command, .shift])
            .disabled(!hasImage)

            Button("Sample Brain") {
                Task { await loadSample() }
            }
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
        HStack(spacing: 16) {
            if isLoading {
                ProgressView()
                    .controlSize(.mini)
            }

            if hasImage, let mm = model.locationMM, mm.count == 3 {
                Text(mm.map { $0.formatted(.number.precision(.fractionLength(1))) }
                    .joined(separator: ", ") + " mm")
                    .foregroundStyle(.primary)
                ForEach(Array(model.locationValues.enumerated()), id: \.offset) { _, entry in
                    Text("\(imageTitle(entry.name)) \(entry.value.formatted(.number.precision(.significantDigits(1...4))))")
                }
            }

            Spacer(minLength: 12)

            Text(model.lastStatus)
                .lineLimit(1)
                .truncationMode(.middle)

            if let backend = model.currentBackend {
                Text(backend.label)
            }
        }
        .font(.caption.monospacedDigit())
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        #if os(macOS)
        .background(.bar)
        #else
        .background(Color(.systemBackground))
        #endif
    }

    // MARK: Actions

    private func handleFileImport(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            guard !urls.isEmpty else { return }
            Task { await loadFiles(urls, addingToCurrent: importAddsOverlays) }
        case .failure(let error):
            model.lastStatus = "Open failed: \(error.localizedDescription)"
        }
    }

    /// The first file replaces the scene unless `addingToCurrent`; the rest
    /// are always added, so a multi-file drop yields base + overlays.
    private func loadFiles(_ urls: [URL], addingToCurrent: Bool) async {
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
                try await model.loadVolume(url: url, add: addingToCurrent || loadedCount > 0)
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
