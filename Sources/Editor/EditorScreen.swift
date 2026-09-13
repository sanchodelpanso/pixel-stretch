import SwiftUI

/// The single persistent editor: canvas on top, tools and status in the
/// middle, and the stretch and layers panels underneath.
struct EditorScreen: View {
    let model: EditorModel
    @Environment(\.dismiss) private var dismiss

    private enum PanelTab: Hashable {
        case layers
        case stretch
    }

    @State private var tab = PanelTab.layers
    @State private var exportItem: ExportItem?
    @State private var projectDocument: ProjectDocument?
    @State private var showProjectExporter = false
    @State private var confirmClose = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                stage
                statusBar
                panels
            }
            .background(Theme.background.ignoresSafeArea())
            .toolbar { toolbar }
            .toolbarBackground(Theme.panel, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .navigationBarTitleDisplayMode(.inline)
            .background { keyboardShortcuts }
        }
        .preferredColorScheme(.dark)
        .sheet(item: $exportItem) { item in
            ShareSheet(items: [item.url])
        }
        .fileExporter(
            isPresented: $showProjectExporter,
            document: projectDocument,
            contentType: .pixelStretchProject,
            defaultFilename: ProjectFile.filename(),
            onCompletion: { model.projectSaved($0) }
        )
        .confirmationDialog("Close this project?", isPresented: $confirmClose, titleVisibility: .visible) {
            Button("Discard Changes", role: .destructive) { dismiss() }
        } message: {
            Text("Save the project first to keep working on it later.")
        }
        .onAppear {
            if model.selectedStretch != nil { tab = .stretch }
        }
        .onChange(of: model.store.selectedId) {
            // A freshly created or picked band brings its controls forward.
            if model.selectedStretch != nil { tab = .stretch }
        }
    }

    // MARK: - Stage

    private var stage: some View {
        GeometryReader { geometry in
            let size = fittedSize(in: geometry.size)
            if size.width > 0 {
                CanvasStage(model: model, size: size)
                    .position(x: geometry.size.width / 2, y: geometry.size.height / 2)
            }
        }
    }

    private func fittedSize(in container: CGSize) -> CGSize {
        let doc = model.store.doc
        let available = CGSize(width: container.width - 24, height: container.height - 24)
        guard doc.width > 0, doc.height > 0, available.width > 0, available.height > 0 else { return .zero }
        let scale = min(available.width / Double(doc.width), available.height / Double(doc.height))
        return CGSize(width: (Double(doc.width) * scale).rounded(), height: (Double(doc.height) * scale).rounded())
    }

    // MARK: - Tools and status

    private var statusBar: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Titles where they fit; icons alone on narrow screens or large text.
            ViewThatFits(in: .horizontal) {
                toolRow(showTitles: true)
                toolRow(showTitles: false)
            }

            Text(model.notice ?? model.statusText)
                .font(.caption)
                .foregroundStyle(model.notice == nil ? Color.secondary : Theme.warning)
                .lineLimit(2, reservesSpace: true)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Theme.panel)
    }

    private func toolRow(showTitles: Bool) -> some View {
        HStack(spacing: 8) {
            ForEach(EditorTool.allCases) { tool in
                let active = model.tool == tool
                chip(tool.label, systemImage: tool.systemImage, showTitle: true, fill: active ? Theme.accent : Color.white.opacity(0.08), foreground: active ? .white : .secondary) {
                    model.selectTool(tool)
                }
                .accessibilityAddTraits(active ? .isSelected : [])
            }
            Spacer(minLength: 4)
            contextActions(showTitles: showTitles)
        }
    }

    /// Buttons for whatever the stretch tool is in the middle of. They live here
    /// rather than beside the overlays, where they'd crowd the handles.
    @ViewBuilder
    private func contextActions(showTitles: Bool) -> some View {
        if let draft = model.draft {
            if !draft.locked {
                chip("Lock", systemImage: "lock", showTitle: showTitles, fill: Theme.accentPurple) { model.lockPath() }
                    .accessibilityLabel("Lock path")
            }
            chip("Cancel", systemImage: "xmark", showTitle: showTitles, fill: Color.white.opacity(0.1)) { model.discardDraft() }
                .accessibilityLabel("Cancel path")
        } else if model.tool == .stretch, let spec = model.selectedStretch {
            chip("Path", systemImage: "lock.open", showTitle: showTitles, fill: Color.white.opacity(0.1)) { model.editPath() }
                .accessibilityLabel("Edit path")
            let curved = spec.warpMode == .curved
            chip("Curved", systemImage: "point.bottomleft.forward.to.point.topright.scurvepath", showTitle: showTitles, fill: curved ? Theme.accentPurple : Color.white.opacity(0.1)) {
                model.changeStretch(transient: false) {
                    $0.warpMode = curved ? .straight : .curved
                    $0.bend = 0
                    $0.curlCorner = nil
                }
            }
            .accessibilityLabel("Curved edges")
            .accessibilityAddTraits(curved ? .isSelected : [])
        }
    }

    private func chip(
        _ title: String,
        systemImage: String,
        showTitle: Bool,
        fill: Color,
        foreground: Color = .white,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Group {
                if showTitle {
                    Label(title, systemImage: systemImage)
                } else {
                    Label(title, systemImage: systemImage).labelStyle(.iconOnly)
                }
            }
            .font(.footnote.weight(.medium))
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(fill, in: Capsule())
        }
        .buttonStyle(.plain)
        .foregroundStyle(foreground)
    }

    // MARK: - Panels

    private var panels: some View {
        let stretchLayer = model.store.selectedLayer.flatMap { layer in layer.stretch.map { (layer, $0) } }
        let shown = stretchLayer == nil ? PanelTab.layers : tab
        return VStack(spacing: 0) {
            Picker("Panel", selection: Binding(get: { shown }, set: { tab = $0 })) {
                Text("Layers").tag(PanelTab.layers)
                Text("Stretch").tag(PanelTab.stretch)
            }
            .pickerStyle(.segmented)
            .disabled(stretchLayer == nil)
            .padding(.horizontal, 16)
            .padding(.top, 8)

            if shown == .stretch, let (layer, spec) = stretchLayer {
                StretchPanel(model: model, layer: layer, spec: spec)
            } else {
                LayersPanel(store: model.store)
            }
        }
        .frame(height: 300)
        .background(Theme.panel)
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button("Close", systemImage: "xmark") {
                if model.store.canUndo { confirmClose = true } else { dismiss() }
            }
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button("Undo", systemImage: "arrow.uturn.backward") { model.store.undo() }
                .disabled(!model.store.canUndo)
                .keyboardShortcut("z", modifiers: .command)
            Button("Redo", systemImage: "arrow.uturn.forward") { model.store.redo() }
                .disabled(!model.store.canRedo)
                .keyboardShortcut("z", modifiers: [.command, .shift])
            if model.isExporting || model.isSavingProject {
                ProgressView()
            } else {
                Menu {
                    Button("Save Project", systemImage: "doc.badge.arrow.up") { saveProject() }
                    Button("Export PNG", systemImage: "photo") { exportPNG() }
                } label: {
                    Label("Share", systemImage: "square.and.arrow.up")
                }
            }
        }
    }

    /// Hardware-keyboard equivalents of the web editor's shortcuts.
    private var keyboardShortcuts: some View {
        Group {
            Button("Cancel") { model.cancel() }
                .keyboardShortcut(.escape, modifiers: [])
            ForEach([false, true], id: \.self) { big in
                let step = big ? 10.0 : 1.0
                let modifiers: EventModifiers = big ? .shift : []
                Button("Nudge left") { model.nudge(dx: -step, dy: 0) }
                    .keyboardShortcut(.leftArrow, modifiers: modifiers)
                Button("Nudge right") { model.nudge(dx: step, dy: 0) }
                    .keyboardShortcut(.rightArrow, modifiers: modifiers)
                Button("Nudge up") { model.nudge(dx: 0, dy: -step) }
                    .keyboardShortcut(.upArrow, modifiers: modifiers)
                Button("Nudge down") { model.nudge(dx: 0, dy: step) }
                    .keyboardShortcut(.downArrow, modifiers: modifiers)
            }
        }
        .opacity(0)
        .accessibilityHidden(true)
    }

    private func exportPNG() {
        Task {
            if let url = await model.exportPNG() {
                exportItem = ExportItem(url: url)
            }
        }
    }

    private func saveProject() {
        Task {
            guard let document = await model.encodeProject() else { return }
            projectDocument = document
            showProjectExporter = true
        }
    }
}
