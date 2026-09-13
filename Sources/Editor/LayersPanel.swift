import SwiftUI

/// The layer stack, topmost first, plus the selected layer's properties.
struct LayersPanel: View {
    let store: LayerStore

    @State private var renamingId: String?
    @State private var draftName = ""
    /// A slider drag is one undo step, not one per value change.
    @State private var slidingOpacity = false

    var body: some View {
        let layers = store.doc.layers
        List {
            Section {
                // The panel lists the topmost layer first; the document stores it last.
                ForEach(layers.reversed()) { layer in
                    row(layer)
                }
                .onMove(perform: move)
            } header: {
                HStack {
                    Text("Layers")
                    Spacer()
                    Text(verbatim: "\(layers.count)").monospacedDigit()
                }
            }

            if let selected = store.selectedLayer {
                properties(selected)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .alert("Rename Layer", isPresented: Binding(get: { renamingId != nil }, set: { if !$0 { renamingId = nil } })) {
            TextField("Name", text: $draftName)
            Button("Cancel", role: .cancel) {}
            Button("Rename") {
                if let renamingId { store.rename(renamingId, to: draftName) }
            }
        }
    }

    private func row(_ layer: Layer) -> some View {
        let isSelected = layer.id == store.selectedId
        return HStack(spacing: 10) {
            Button {
                store.update(layer.id) { $0.visible.toggle() }
            } label: {
                Image(systemName: layer.visible ? "eye" : "eye.slash")
                    .frame(width: 26, height: 30)
            }
            .buttonStyle(.borderless)
            .foregroundStyle(layer.visible ? .primary : .secondary)
            .accessibilityLabel(layer.visible ? "Hide layer" : "Show layer")

            Image(decorative: layer.bitmap.thumbnail, scale: 1)
                .resizable()
                .scaledToFit()
                .frame(width: 36, height: 36)
                .background(Image(uiImage: Theme.checkerTile).resizable(resizingMode: .tile))
                .clipShape(RoundedRectangle(cornerRadius: 4))

            VStack(alignment: .leading, spacing: 2) {
                Text(layer.name)
                    .lineLimit(1)
                HStack(spacing: 5) {
                    if layer.stretch != nil {
                        Text("stretch")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Theme.accentPurple.opacity(0.35), in: Capsule())
                    }
                    Text("\(layer.width) × \(layer.height)" + (layer.opacity < 1 ? " · \(jsRound(layer.opacity * 100))%" : ""))
                        .monospacedDigit()
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            .foregroundStyle(layer.visible ? .primary : .secondary)

            Spacer(minLength: 0)

            Button {
                store.update(layer.id) { $0.locked.toggle() }
            } label: {
                Image(systemName: layer.locked ? "lock.fill" : "lock.open")
                    .frame(width: 26, height: 30)
            }
            .buttonStyle(.borderless)
            .foregroundStyle(layer.locked ? Theme.accent : .secondary)
            .accessibilityLabel(layer.locked ? "Unlock layer" : "Lock layer")
        }
        .contentShape(Rectangle())
        .onTapGesture { store.select(layer.id) }
        .listRowBackground(isSelected ? Theme.accent.opacity(0.22) : Color.white.opacity(0.04))
        .contextMenu {
            Button("Rename", systemImage: "pencil") { startRename(layer) }
            Button("Duplicate", systemImage: "plus.square.on.square") { store.duplicate(layer.id) }
            Button("Move Up", systemImage: "arrow.up") { shift(layer.id, by: 1) }
            Button("Move Down", systemImage: "arrow.down") { shift(layer.id, by: -1) }
            Button("Delete", systemImage: "trash", role: .destructive) { store.remove(layer.id) }
                .disabled(store.doc.layers.count <= 1)
        }
    }

    private func properties(_ selected: Layer) -> some View {
        Section(selected.name) {
            HStack {
                Text("Opacity")
                Slider(
                    value: Binding(
                        get: { selected.opacity * 100 },
                        set: { value in
                            let opacity = value.rounded() / 100
                            if slidingOpacity {
                                store.patchTransient(selected.id) { $0.opacity = opacity }
                            } else {
                                store.update(selected.id) { $0.opacity = opacity }
                            }
                        }
                    ),
                    in: 0...100,
                    step: 1,
                    onEditingChanged: { editing in
                        if editing { store.beginHistory() }
                        slidingOpacity = editing
                    }
                )
                .accessibilityLabel("Opacity")
                Text(verbatim: "\(jsRound(selected.opacity * 100))%")
                    .monospacedDigit()
                    .lineLimit(1)
                    .fixedSize()
                    .frame(minWidth: 44, alignment: .trailing)
            }

            LabeledContent("Position", value: "\(formatNumber(selected.x)), \(formatNumber(selected.y))")

            HStack {
                Button("Rename") { startRename(selected) }
                Spacer()
                Button("Duplicate") { store.duplicate(selected.id) }
                Spacer()
                Button("Delete", role: .destructive) { store.remove(selected.id) }
                    .disabled(store.doc.layers.count <= 1)
            }
            .buttonStyle(.borderless)
        }
    }

    private func startRename(_ layer: Layer) {
        draftName = layer.name
        renamingId = layer.id
    }

    /// Reorder from a drag in the top-first list.
    private func move(from source: IndexSet, to destination: Int) {
        guard let displayedFrom = source.first else { return }
        let count = store.doc.layers.count
        // `destination` counts slots before removal; convert to the final slot.
        let displayedTo = destination > displayedFrom ? destination - 1 : destination
        store.reorder(from: count - 1 - displayedFrom, to: count - 1 - displayedTo)
    }

    /// Move a layer up (+1) or down (−1) the stack.
    private func shift(_ id: String, by delta: Int) {
        guard let index = store.doc.layers.firstIndex(where: { $0.id == id }) else { return }
        let target = index + delta
        guard store.doc.layers.indices.contains(target) else { return }
        store.reorder(from: index, to: target)
    }
}

/// Whole numbers without a trailing ".0", anything else as-is.
func formatNumber(_ value: Double) -> String {
    value.rounded() == value && abs(value) < 1e15 ? String(Int(value)) : String(value)
}
