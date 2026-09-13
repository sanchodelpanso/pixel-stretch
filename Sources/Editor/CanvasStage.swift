import SwiftUI

/// The fitted document: the composited layer stack over a checkerboard, the
/// stretch overlays on top, and one gesture that routes every touch.
///
/// Overlay handles only draw; this view decides what a touch picks up. Handles
/// crowd together when a band is small on screen, so the nearest one to the
/// fingertip wins rather than whichever happens to be drawn on top.
struct CanvasStage: View {
    let model: EditorModel
    /// On-screen size of the whole document.
    let size: CGSize

    private enum ActiveDrag {
        /// The active tool's own gesture: move a layer, draw or pull a band.
        case canvas
        case path(PathEditing.Grab)
        case rect(RectEditing.Grab)
        /// A touch that lands on nothing interactive.
        case ignored
    }

    @State private var activeDrag: ActiveDrag?
    @State private var taps = DoubleTapDetector()

    private var doc: LayerDocument { model.store.doc }
    private var scale: Double { doc.width > 0 ? size.width / Double(doc.width) : 1 }

    var body: some View {
        ZStack(alignment: .topLeading) {
            layerStack
                .frame(width: size.width, height: size.height, alignment: .topLeading)
                .clipped()
            overlays
                .frame(width: size.width, height: size.height, alignment: .topLeading)
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("canvas")
        .coordinateSpace(name: StageSpace.name)
        .contentShape(Rectangle())
        .gesture(stageGesture)
    }

    private var layerStack: some View {
        ZStack(alignment: .topLeading) {
            Image(uiImage: Theme.checkerTile)
                .resizable(resizingMode: .tile)
            ForEach(doc.layers) { layer in
                if layer.visible && layer.opacity > 0 {
                    Image(decorative: layer.bitmap.image, scale: 1)
                        .resizable()
                        .interpolation(.high)
                        .frame(width: Double(layer.width) * scale, height: Double(layer.height) * scale)
                        .opacity(layer.opacity)
                        .offset(x: layer.x * scale, y: layer.y * scale)
                }
            }
        }
        .allowsHitTesting(false)
    }

    /// The transform box belongs to the stretch tool; it would fight Move.
    private var rectSpec: StretchSpec? {
        model.tool == .stretch && model.draft == nil ? model.selectedStretch : nil
    }

    @ViewBuilder
    private var overlays: some View {
        if let spec = rectSpec {
            StretchRectOverlay(spec: spec, scale: scale)
        }
        if let draft = model.draft, !draft.locked {
            StretchPathOverlay(points: draft.points, scale: scale)
        }
        if let draft = model.draft, draft.locked {
            ExtrudePreview(points: draft.points, extruding: model.extruding, scale: scale)
                .allowsHitTesting(false)
        }
    }

    // MARK: - Touch routing

    private var stageGesture: some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .named(StageSpace.name))
            .onChanged { value in
                if let activeDrag {
                    continueDrag(activeDrag, to: value.location)
                } else {
                    activeDrag = beginDrag(at: value.startLocation)
                    if value.location != value.startLocation, let activeDrag {
                        continueDrag(activeDrag, to: value.location)
                    }
                }
            }
            .onEnded { value in
                if let activeDrag { endDrag(activeDrag, value) }
                activeDrag = nil
            }
    }

    private func beginDrag(at location: CGPoint) -> ActiveDrag {
        if model.tool == .stretch, let draft = model.draft, !draft.locked {
            // While a path is open for shaping, bare-canvas drags do nothing —
            // its own handles own the interaction.
            guard let grab = PathEditing.grab(points: draft.points, scale: scale, at: location) else { return .ignored }
            if let inserted = grab.inserted { model.pathChanged(inserted) }
            return .path(grab)
        }
        if let spec = rectSpec, let grab = RectEditing.grab(spec: spec, scale: scale, at: location) {
            model.store.beginHistory()
            return .rect(grab)
        }
        model.canvasBegan(at: Point(view: location, scale: scale))
        return .canvas
    }

    private func continueDrag(_ drag: ActiveDrag, to location: CGPoint) {
        switch drag {
        case .canvas:
            model.canvasMoved(to: Point(view: location, scale: scale))
        case .path(let grab):
            guard let points = model.draft?.points else { return }
            model.pathChanged(PathEditing.moving(points, grab: grab, to: location, scale: scale))
        case .rect(var grab):
            RectEditing.drag(&grab, to: location, scale: scale, model: model)
            activeDrag = .rect(grab)
        case .ignored:
            break
        }
    }

    private func endDrag(_ drag: ActiveDrag, _ value: DragGesture.Value) {
        switch drag {
        case .canvas:
            // A deliberate line is a few points long on screen, however
            // large the document is.
            model.canvasEnded(minimumLine: 10 / scale)
        case .path(let grab):
            // Double-tapping an interior point removes it again.
            guard grab.inserted == nil, taps.registerEnd(key: "point-\(grab.index)", of: value),
                  let points = model.draft?.points,
                  points.count > 2, grab.index > 0, grab.index < points.count - 1 else { return }
            model.pathChanged(points.enumerated().filter { $0.offset != grab.index }.map(\.element))
        case .rect(let grab):
            guard case .edge(let edge, let control) = grab.kind,
                  taps.registerEnd(key: "edge-\(edge)-\(control)", of: value) else { return }
            RectEditing.resetControl(edge: edge, control: control, model: model)
        case .ignored:
            break
        }
    }
}

enum StageSpace {
    static let name = "editorStage"
}

// MARK: - Sample path

/// Picking up the sample path's handles: its control points, and the hollow
/// midpoint on each segment that turns into a new point when dragged. The path
/// only chooses which pixels get read — the band it produces is always a
/// straight rectangle.
enum PathEditing {
    struct Grab {
        /// The control point being dragged.
        let index: Int
        /// How far the finger landed from the handle's centre.
        let offset: CGSize
        /// Set when the grab materialised a midpoint: the path with it inserted.
        let inserted: [Point]?
    }

    static func midpoint(_ a: Point, _ b: Point) -> Point {
        Point(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
    }

    /// The nearest point or midpoint within reach of the fingertip. Real points
    /// win ties, so a short segment's midpoint can't shadow its ends.
    static func grab(points: [Point], scale: Double, at location: CGPoint) -> Grab? {
        func distance(_ p: Point) -> CGFloat {
            let view = p.view(scale)
            return hypot(view.x - location.x, view.y - location.y)
        }
        func offset(_ p: Point) -> CGSize {
            let view = p.view(scale)
            return CGSize(width: view.x - location.x, height: view.y - location.y)
        }

        let nearestPoint = points.indices.min { distance(points[$0]) < distance(points[$1]) }
        let nearestMid = points.indices.dropLast().min {
            distance(midpoint(points[$0], points[$0 + 1])) < distance(midpoint(points[$1], points[$1 + 1]))
        }
        let pointDistance = nearestPoint.map { distance(points[$0]) } ?? .infinity
        let midDistance = nearestMid.map { distance(midpoint(points[$0], points[$0 + 1])) } ?? .infinity

        if let index = nearestPoint, pointDistance <= touchReach, pointDistance <= midDistance {
            return Grab(index: index, offset: offset(points[index]), inserted: nil)
        }
        if let index = nearestMid, midDistance <= touchReach {
            // Materialise the hollow handle into a real point, then drag that.
            let mid = midpoint(points[index], points[index + 1])
            var inserted = points
            inserted.insert(mid, at: index + 1)
            return Grab(index: index + 1, offset: offset(mid), inserted: inserted)
        }
        return nil
    }

    static func moving(_ points: [Point], grab: Grab, to location: CGPoint, scale: Double) -> [Point] {
        guard points.indices.contains(grab.index) else { return points }
        var next = points
        next[grab.index] = Point(
            view: CGPoint(x: location.x + grab.offset.width, y: location.y + grab.offset.height),
            scale: scale
        )
        return next
    }
}

/// Draws the sample path being shaped.
struct StretchPathOverlay: View {
    let points: [Point]
    let scale: Double

    var body: some View {
        Canvas { context, _ in
            var curve = Path()
            curve.addLines(pathToPolyline(points).map { $0.view(scale) })
            context.stroke(curve, with: .color(.black.opacity(0.55)), style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round))
            context.stroke(curve, with: .color(Theme.accent), style: StrokeStyle(lineWidth: 1.75, lineCap: .round, lineJoin: .round))

            // Hollow midpoint per segment — drag it to bend the path there.
            for index in points.indices.dropLast() {
                let at = PathEditing.midpoint(points[index], points[index + 1]).view(scale)
                let square = Path(CGRect(x: at.x - 5, y: at.y - 5, width: 10, height: 10))
                context.fill(square, with: .color(Theme.panel.opacity(0.5)))
                context.stroke(square, with: .color(.white), lineWidth: 1.5)
            }
            for point in points {
                let at = point.view(scale)
                let square = Path(CGRect(x: at.x - 6, y: at.y - 6, width: 12, height: 12))
                context.fill(square, with: .color(.white))
                context.stroke(square, with: .color(Theme.accent), lineWidth: 1.75)
            }
        }
        .allowsHitTesting(false)
    }
}

// MARK: - Pulling the band out

/// The band's outline as it's being pulled off a locked path, with a grip that
/// makes the pull gesture visible.
struct ExtrudePreview: View {
    let points: [Point]
    let extruding: Double?
    let scale: Double

    var body: some View {
        Canvas { context, _ in
            if let extruding, extruding != 0 {
                let spec = StretchSpec.initial(points: points, sourceLayerId: "", length: extruding)
                var rect = Path()
                rect.addLines(spec.bandCorners.map { $0.view(scale) })
                rect.closeSubpath()
                context.fill(rect, with: .color(Theme.accent.opacity(0.12)))
                context.stroke(rect, with: .color(Theme.accent), style: StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
            }

            var line = Path()
            line.addLines(pathToPolyline(points).map { $0.view(scale) })
            context.stroke(line, with: .color(.white), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))

            // Off the middle of the path, riding along with the drag so it stays
            // under the finger.
            guard let a = points.first, let b = points.last else { return }
            let out = bandBasis(points).out
            let pulled = extruding ?? 0
            // Stand off far enough to stay clear of the path itself.
            let offset = pulled + (pulled < 0 ? -34 : 34) / scale
            let grip = CGPoint(
                x: ((a.x + b.x) / 2 + out.x * offset) * scale,
                y: ((a.y + b.y) / 2 + out.y * offset) * scale
            )
            let circle = Path(ellipseIn: CGRect(x: grip.x - 13, y: grip.y - 13, width: 26, height: 26))
            context.fill(circle, with: .color(Theme.accent))
            context.stroke(circle, with: .color(.white), lineWidth: 2)
            var arrows = Path()
            arrows.move(to: CGPoint(x: grip.x, y: grip.y - 7))
            arrows.addLine(to: CGPoint(x: grip.x, y: grip.y + 7))
            arrows.move(to: CGPoint(x: grip.x - 4, y: grip.y - 3.5))
            arrows.addLine(to: CGPoint(x: grip.x, y: grip.y - 7.5))
            arrows.addLine(to: CGPoint(x: grip.x + 4, y: grip.y - 3.5))
            arrows.move(to: CGPoint(x: grip.x - 4, y: grip.y + 3.5))
            arrows.addLine(to: CGPoint(x: grip.x, y: grip.y + 7.5))
            arrows.addLine(to: CGPoint(x: grip.x + 4, y: grip.y + 3.5))
            context.stroke(arrows, with: .color(.white), style: StrokeStyle(lineWidth: 1.75, lineCap: .round, lineJoin: .round))
        }
    }
}
