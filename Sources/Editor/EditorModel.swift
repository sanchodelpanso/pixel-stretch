import CoreGraphics
import Foundation
import Observation

enum EditorTool: CaseIterable, Identifiable {
    case move
    case stretch

    var id: Self { self }

    var label: String {
        switch self {
        case .move: "Move"
        case .stretch: "Stretch"
        }
    }

    var systemImage: String {
        switch self {
        case .move: "arrow.up.and.down.and.arrow.left.and.right"
        case .stretch: "arrow.right.to.line.compact"
        }
    }
}

enum EditorSource {
    case image(CGImage)
    case project(LoadedProject)
}

/// The sample path being shaped, before (and while) it drives a band.
/// `layerId` is set when an existing band's path is reopened for editing.
struct StretchDraft {
    var points: [Point]
    var locked: Bool
    var layerId: String?
}

/// Editor state and canvas interaction, independent of layout.
@MainActor
@Observable
final class EditorModel: Identifiable {
    /// Shorter than this and the drag was probably a stray touch, not a line.
    static let minSampleLine = 6.0

    let id = UUID()
    let store: LayerStore

    var tool = EditorTool.move
    /// The sample path being shaped, before it becomes a band.
    var draft: StretchDraft?
    /// Live rectangle length while the band is being pulled off a locked path.
    var extruding: Double?
    var notice: String?
    var isExporting = false
    var isSavingProject = false

    private struct MoveDrag {
        let id: String
        let start: Point
        let original: Layer
        var moved: Bool
    }

    private enum StretchGesture {
        case draw
        case extrude
    }

    @ObservationIgnored private var moveDrag: MoveDrag?
    @ObservationIgnored private var stretchGesture: StretchGesture?

    init(source: EditorSource) {
        Task.detached(priority: .utility) { ProjectedBandKernel.prepare() }
        store = LayerStore()
        switch source {
        case .image(let image):
            store.initFromImage(image)
        case .project(let project):
            store.initFromDocument(project.document, selectedLayerId: project.selectedLayerId)
        }
    }

    var selectedStretch: StretchSpec? { store.selectedLayer?.stretch }

    var statusText: String {
        switch tool {
        case .move:
            return "Tap a layer to select it · drag to reposition"
        case .stretch:
            if let draft {
                return draft.locked
                    ? "Drag away from the path to pull the band out"
                    : "Drag the hollow midpoints to bend the path · double-tap a point to remove it · Lock when done"
            }
            if let stretch = selectedStretch {
                return stretch.warpMode == .curved
                    ? "Purple handles make a 2D wave · corner handles keep the fold effect"
                    : "Drag a corner to skew the rectangle in 2D · use Curved for waves"
            }
            return "Drag a line across the layer to choose which pixels to sample"
        }
    }

    // MARK: - Tools

    func selectTool(_ next: EditorTool) {
        // An unfinished path doesn't survive leaving the tool.
        if next != .stretch { draft = nil }
        tool = next
    }

    /// Escape: drop whatever is in progress and go back to Move.
    func cancel() {
        draft = nil
        extruding = nil
        notice = nil
        tool = .move
    }

    /// Throw away an unfinished sample path, staying in the stretch tool.
    func discardDraft() {
        draft = nil
        extruding = nil
    }

    func nudge(dx: Double, dy: Double) {
        guard let id = store.selectedId else { return }
        store.nudge(id, dx: dx, dy: dy)
    }

    // MARK: - Canvas gestures

    func canvasBegan(at point: Point) {
        switch tool {
        case .stretch:
            guard store.selectedLayer != nil else { return }
            notice = nil
            if draft == nil {
                // Nothing yet: drag out the initial straight two-point path.
                stretchGesture = .draw
                draft = StretchDraft(points: [point, point], locked: false, layerId: nil)
            } else if let draft, draft.locked, draft.layerId == nil {
                // Path is committed: this drag pulls the band off it.
                stretchGesture = .extrude
                extruding = 0
            }
            // While a path is open for shaping, bare-canvas drags do nothing —
            // its own handles own the interaction.

        case .move:
            guard let hit = LayerOps.hitTest(store.doc.layers, at: point) else { return }
            store.select(hit.id)
            moveDrag = MoveDrag(id: hit.id, start: point, original: hit, moved: false)
        }
    }

    func canvasMoved(to point: Point) {
        if stretchGesture == .draw, var draft {
            draft.points = [draft.points[0], point]
            self.draft = draft
            return
        }

        if stretchGesture == .extrude, let draft {
            // Distance from the path, measured along its perpendicular.
            let out = bandBasis(draft.points).out
            let from = draft.points[0]
            extruding = (point.x - from.x) * out.x + (point.y - from.y) * out.y
            return
        }

        guard var drag = moveDrag else { return }
        // Snapshot once, on the first actual movement, so one drag is one undo.
        if !drag.moved {
            drag.moved = true
            moveDrag = drag
            store.beginHistory()
        }
        // Measured from where the drag started: touches move in fractions of a
        // pixel, which per-event rounding of the layer position would swallow.
        let moved = LayerOps.translate(drag.original, dx: point.x - drag.start.x, dy: point.y - drag.start.y)
        store.patchTransient(drag.id) { $0 = moved }
    }

    /// `minimumLine` is the shortest deliberate sample line, in document pixels.
    func canvasEnded(minimumLine: Double) {
        moveDrag = nil
        let gesture = stretchGesture
        stretchGesture = nil
        guard let gesture, let draft else { return }

        switch gesture {
        case .draw:
            // Too short to be a deliberate line — throw the draft away.
            if chordLength(draft.points) < max(Self.minSampleLine, minimumLine) { self.draft = nil }

        case .extrude:
            // Turn the locked path into an actual band layer.
            let length = Double(jsRound(extruding ?? 0))
            extruding = nil
            guard let selected = store.selectedLayer, abs(length) >= 1 else { return }

            let spec = StretchSpec.initial(points: draft.points, sourceLayerId: selected.id, length: length)
            let wasBottomLayer = store.doc.layers.first?.id == selected.id
            let created = store.addStretchLayer(spec, name: "\(selected.name) stretch")
            self.draft = nil
            if created != nil && wasBottomLayer {
                notice = "Band added behind “\(selected.name)”, the backmost layer — drag it up in the layers panel to see it."
            }
        }
    }

    // MARK: - Stretch editing

    /// Shaping the path re-renders an existing band live.
    func pathChanged(_ points: [Point]) {
        guard var draft else { return }
        draft.points = points
        self.draft = draft
        if let id = draft.layerId {
            store.updateStretch(id, transient: true) { $0.points = points }
        }
    }

    func lockPath() {
        guard var draft else { return }
        if draft.layerId != nil {
            // Reopened bands already have their rectangle; just hand it back.
            self.draft = nil
        } else {
            draft.locked = true
            self.draft = draft
        }
    }

    /// Reopen the selected band's sample path.
    func editPath() {
        guard let layer = store.selectedLayer, let spec = layer.stretch else { return }
        store.beginHistory()
        tool = .stretch
        draft = StretchDraft(points: spec.points, locked: false, layerId: layer.id)
    }

    func changeStretch(transient: Bool, _ change: (inout StretchSpec) -> Void) {
        guard let id = store.selectedId else { return }
        store.updateStretch(id, transient: transient, change)
    }

    // MARK: - Output

    /// Flatten the document to a transparent PNG in the temporary directory.
    func exportPNG() async -> URL? {
        guard store.doc.width > 0 else { return nil }
        let doc = store.doc
        isExporting = true
        defer { isExporting = false }
        do {
            return try await Task.detached(priority: .userInitiated) {
                guard let image = flattenDocument(doc), let data = BitmapContext.pngData(image) else {
                    throw ProjectFileError(message: "Canvas encoding failed")
                }
                let url = FileManager.default.temporaryDirectory
                    .appendingPathComponent("PixelStretch-\(Int(Date().timeIntervalSince1970 * 1000)).png")
                try data.write(to: url, options: .atomic)
                return url
            }.value
        } catch {
            notice = "Export failed: \(error.localizedDescription)"
            return nil
        }
    }

    /// Encode the project for saving; nil (with a notice) on failure.
    func encodeProject() async -> ProjectDocument? {
        guard store.doc.width > 0, !isSavingProject else { return nil }
        let doc = store.doc
        let selectedId = store.selectedId
        isSavingProject = true
        notice = nil
        defer { isSavingProject = false }
        do {
            let data = try await Task.detached(priority: .userInitiated) {
                try ProjectFile.encode(doc, selectedLayerId: selectedId)
            }.value
            return ProjectDocument(data: data)
        } catch {
            notice = "Project save failed: \(error.localizedDescription)"
            return nil
        }
    }

    func projectSaved(_ result: Result<URL, Error>) {
        switch result {
        case .success:
            let count = store.doc.layers.count
            notice = "Project saved · \(count) layer\(count == 1 ? "" : "s")"
        case .failure(let error as CocoaError) where error.code == .userCancelled:
            break
        case .failure(let error):
            notice = "Project save failed: \(error.localizedDescription)"
        }
    }
}
