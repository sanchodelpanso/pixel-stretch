import CoreGraphics
import Observation

/// The layer document plus its undo history.
///
/// Snapshots share bitmaps — every mutation builds new `Layer` values rather
/// than editing pixels in place — so history is cheap.
@MainActor
@Observable
final class LayerStore {
    private static let maxHistory = 30

    private(set) var doc = LayerDocument.empty
    var selectedId: String?
    private(set) var canUndo = false
    private(set) var canRedo = false

    @ObservationIgnored private var past: [LayerDocument] = []
    @ObservationIgnored private var future: [LayerDocument] = []

    var selectedLayer: Layer? {
        doc.layers.first { $0.id == selectedId }
    }

    func layer(_ id: String) -> Layer? {
        doc.layers.first { $0.id == id }
    }

    // MARK: - Bookkeeping

    private func publish(_ next: LayerDocument) {
        doc = next
        syncHistory()
    }

    private func syncHistory() {
        canUndo = !past.isEmpty
        canRedo = !future.isEmpty
    }

    private func pushPast(_ snapshot: LayerDocument) {
        past = Array(past.suffix(Self.maxHistory - 1)) + [snapshot]
    }

    /// Apply a document change, pushing the previous state onto the undo stack.
    private func commit(_ next: LayerDocument) {
        pushPast(doc)
        future = []
        publish(next)
    }

    private func mapping(_ id: String, _ transform: (Layer) -> Layer) -> LayerDocument {
        var next = doc
        next.layers = doc.layers.map { $0.id == id ? transform($0) : $0 }
        return next
    }

    // MARK: - Lifecycle

    func initFromImage(_ image: CGImage) {
        let background = LayerOps.layer(from: image)
        past = []
        future = []
        publish(LayerDocument(width: image.width, height: image.height, layers: [background]))
        selectedId = background.id
    }

    func initFromDocument(_ document: LayerDocument, selectedLayerId: String?) {
        LayerID.reserve(document.layers.map(\.id))
        past = []
        future = []
        publish(document)
        selectedId = document.layers.contains { $0.id == selectedLayerId }
            ? selectedLayerId
            : document.layers.last?.id
    }

    // MARK: - Layer edits

    func select(_ id: String?) {
        selectedId = id
    }

    func update(_ id: String, _ change: (inout Layer) -> Void) {
        commit(mapping(id) { layer in
            var layer = layer
            change(&layer)
            return layer
        })
    }

    func rename(_ id: String, to name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { update(id) { $0.name = trimmed } }
    }

    func remove(_ id: String) {
        // The document always keeps at least one layer.
        guard doc.layers.count > 1 else { return }
        let remaining = doc.layers.filter { $0.id != id }
        guard remaining.count != doc.layers.count else { return }

        var next = doc
        next.layers = remaining
        commit(next)
        if selectedId == id { selectedId = remaining.last?.id }
    }

    func duplicate(_ id: String) {
        guard let index = doc.layers.firstIndex(where: { $0.id == id }) else { return }
        let copy = LayerOps.duplicate(doc.layers[index])
        var next = doc
        next.layers.insert(copy, at: index + 1)
        commit(next)
        selectedId = copy.id
    }

    /// Move a layer within the stack. Both indices are bottom-first.
    func reorder(from: Int, to: Int) {
        guard from != to, doc.layers.indices.contains(from) else { return }
        var next = doc
        let moved = next.layers.remove(at: from)
        next.layers.insert(moved, at: clamp(to, 0, next.layers.count))
        commit(next)
    }

    /// Move a layer by a delta, as one undo step.
    func nudge(_ id: String, dx: Double, dy: Double) {
        commit(mapping(id) { LayerOps.translate($0, dx: dx, dy: dy) })
    }

    /// Snapshot the current document for undo without changing it. Call once at
    /// the start of a continuous gesture, then use the transient edits freely.
    func beginHistory() {
        pushPast(doc)
        future = []
        syncHistory()
    }

    /// Replace a layer without touching the undo stack — for continuous gestures.
    func patchTransient(_ id: String, _ change: (inout Layer) -> Void) {
        doc = mapping(id) { layer in
            var layer = layer
            change(&layer)
            return layer
        }
    }

    // MARK: - Stretch

    /// Create a generative stretch layer directly below its source layer.
    /// Returns the new layer's id, or nil if the band would be degenerate.
    @discardableResult
    func addStretchLayer(_ spec: StretchSpec, name: String = "Stretch") -> String? {
        guard let sourceIndex = doc.layers.firstIndex(where: { $0.id == spec.sourceLayerId }),
              let band = LayerOps.stretchLayer(spec, source: doc.layers[sourceIndex], name: name) else { return nil }

        // Directly below its source, so the band reads as being behind it.
        var next = doc
        next.layers.insert(band, at: sourceIndex)
        commit(next)
        selectedId = band.id
        return band.id
    }

    /// Re-render a stretch layer against an edited spec. Pass `transient` while a
    /// handle or slider is still being dragged so the drag stays one undo step.
    func updateStretch(_ id: String, transient: Bool = false, _ change: (inout StretchSpec) -> Void) {
        guard let layer = layer(id), var spec = layer.stretch else { return }
        change(&spec)
        // Without its source layer the band can't be re-rendered; keep the pixels.
        let updated: Layer
        if let source = self.layer(spec.sourceLayerId) {
            updated = LayerOps.rerender(layer, spec: spec, source: source)
        } else {
            updated = { var copy = layer; copy.stretch = spec; return copy }()
        }
        let next = mapping(id) { _ in updated }

        if transient {
            doc = next
        } else {
            commit(next)
        }
    }

    // MARK: - History

    func undo() {
        guard let previous = past.popLast() else { return }
        future.append(doc)
        publish(previous)
    }

    func redo() {
        guard let next = future.popLast() else { return }
        past.append(doc)
        publish(next)
    }
}
