import SwiftUI

/// Picking up and dragging the selected band's transform box: eight handles in
/// the rectangle's own rotated frame, a rotate grip, curved-edge controls, and
/// the body itself.
///
/// In straight mode corner handles skew a flat quadrilateral. In curved mode
/// they retain the rounded page fold. Edge handles resize, while the purple
/// controls shape a free-form 2D Bézier surface.
@MainActor
enum RectEditing {
    enum Handle: CaseIterable {
        case nw, n, ne, w, e, sw, s, se

        /// Position in normalised rect space.
        var position: (u: Double, v: Double) {
            switch self {
            case .nw: (0, 0)
            case .n: (0.5, 0)
            case .ne: (1, 0)
            case .w: (0, 0.5)
            case .e: (1, 0.5)
            case .sw: (0, 1)
            case .s: (0.5, 1)
            case .se: (1, 1)
            }
        }

        /// Index into `bandCorners` for the four corner handles.
        var corner: Int? {
            switch self {
            case .nw: 0
            case .ne: 1
            case .se: 2
            case .sw: 3
            default: nil
            }
        }
    }

    enum Kind {
        case resize(Handle)
        case warp(corner: Int)
        case edge(Int, control: Int)
        case move(last: Point)
        case rotate
    }

    struct Grab {
        var kind: Kind
        /// How far the finger landed from the handle's centre.
        let offset: CGSize
    }

    /// Where every piece of the box sits on screen, for drawing and hit-testing.
    struct Layout {
        let corners: [Point]
        let curves: [CubicEdge]
        let curvedMode: Bool
        let handles: [(handle: Handle, at: CGPoint)]
        let controls: [(edge: Int, control: Int, at: CGPoint)]
        let badge: CGPoint
        let rotate: CGPoint
        let outline: Path
        let source: Path
        let helperGrid: [Path]

        init(spec: StretchSpec, scale: Double) {
            let corners = spec.warpedCorners
            let curves = spec.edgeCurves
            self.corners = corners
            self.curves = curves
            curvedMode = spec.warpMode == .curved
            handles = Handle.allCases.map { handle in
                (handle, RectEditing.surfacePoint(spec, handle.position.u, handle.position.v).view(scale))
            }
            controls = curvedMode && spec.curlCorner == nil
                ? curves.indices.flatMap { edge in
                    [(edge, 0, curves[edge].c0.view(scale)), (edge, 1, curves[edge].c1.view(scale))]
                }
                : []
            badge = RectEditing.surfacePoint(spec, 0.5, 0).view(scale)
            // Rotate grip stands off the edge the badge sits on, clear of the handles.
            let out = spec.rectBasis.out
            let side = spec.length < 0 ? -1.0 : 1.0
            rotate = CGPoint(x: badge.x - out.x * 34 * side, y: badge.y - out.y * 34 * side)

            let steps = 32
            var boundary = Path()
            boundary.move(to: RectEditing.surfacePoint(spec, 0, 0).view(scale))
            for i in 1...steps { boundary.addLine(to: RectEditing.surfacePoint(spec, Double(i) / Double(steps), 0).view(scale)) }
            for i in 1...steps { boundary.addLine(to: RectEditing.surfacePoint(spec, 1, Double(i) / Double(steps)).view(scale)) }
            for i in 1...steps { boundary.addLine(to: RectEditing.surfacePoint(spec, 1 - Double(i) / Double(steps), 1).view(scale)) }
            for i in 1..<steps { boundary.addLine(to: RectEditing.surfacePoint(spec, 0, 1 - Double(i) / Double(steps)).view(scale)) }
            boundary.closeSubpath()
            outline = boundary

            var sourcePath = Path()
            sourcePath.move(to: RectEditing.surfacePoint(spec, 0, 0).view(scale))
            for i in 1...steps {
                sourcePath.addLine(to: RectEditing.surfacePoint(spec, Double(i) / Double(steps), 0).view(scale))
            }
            source = sourcePath

            helperGrid = (1...2).map { index in
                let u = Double(index) / 3
                return RectEditing.gridLine(spec: spec, scale: scale, steps: steps) { _, v in (u, v) }
            } + (1...2).map { index in
                let v = Double(index) / 3
                return RectEditing.gridLine(spec: spec, scale: scale, steps: steps) { u, _ in (u, v) }
            }
        }
    }

    /// Project a point through the same cylinder and page surface as the pixel
    /// renderer, so the overlay accurately describes the rendered geometry.
    nonisolated static func surfacePoint(_ spec: StretchSpec, _ u: Double, _ v: Double) -> Point {
        if spec.curlCorner != nil { return PageCurlSurface(spec).at(u, v).point }
        let bent = bendPoint(u, v, bend: spec.bend)
        if spec.warpMode == .curved {
            return coonsPoint(spec.edgeCurves, bent.x, bent.y)
        }
        return project(quadHomography(spec.warpedCorners), bent.x, bent.y)
    }

    nonisolated static func gridLine(
        spec: StretchSpec,
        scale: Double,
        steps: Int,
        point: (_ u: Double, _ v: Double) -> (Double, Double)
    ) -> Path {
        var path = Path()
        for i in 0...steps {
            let t = Double(i) / Double(steps)
            let uv = point(t, t)
            let position = surfacePoint(spec, uv.0, uv.1).view(scale)
            if i == 0 { path.move(to: position) } else { path.addLine(to: position) }
        }
        return path
    }

    /// Handle centre in document space. Bilinear across the quad, so handles ride
    /// the distorted shape rather than floating off the rectangle it started as.
    nonisolated static func handlePoint(_ c: [Point], _ u: Double, _ v: Double) -> Point {
        Point(
            x: (c[0].x * (1 - u) + c[1].x * u) * (1 - v) + (c[3].x * (1 - u) + c[2].x * u) * v,
            y: (c[0].y * (1 - u) + c[1].y * u) * (1 - v) + (c[3].y * (1 - u) + c[2].y * u) * v
        )
    }

    /// What a touch at `location` picks up: the nearest handle within reach of
    /// a fingertip, else the band's body, else nothing.
    static func grab(spec: StretchSpec, scale: Double, at location: CGPoint) -> Grab? {
        let layout = Layout(spec: spec, scale: scale)
        var candidates: [(kind: Kind, at: CGPoint)] = layout.controls.map { (.edge($0.edge, control: $0.control), $0.at) }
        candidates += layout.handles.map { item in
            (item.handle.corner.map { Kind.warp(corner: $0) } ?? .resize(item.handle), item.at)
        }
        candidates.append((.rotate, layout.rotate))

        // Inside a small band every spot is near some handle, so there a touch
        // has to land close to one; otherwise the body could never be dragged.
        let inside = layout.outline.contains(location)
        let reach = inside ? touchReach * 0.6 : touchReach
        let nearest = candidates
            .map { (kind: $0.kind, at: $0.at, distance: hypot($0.at.x - location.x, $0.at.y - location.y)) }
            .filter { $0.distance <= reach }
            .min { $0.distance < $1.distance }
        if let nearest {
            return Grab(kind: nearest.kind, offset: CGSize(width: nearest.at.x - location.x, height: nearest.at.y - location.y))
        }
        if inside {
            return Grab(kind: .move(last: Point(view: location, scale: scale)), offset: .zero)
        }
        return nil
    }

    /// Continue a drag. Edits are transient: the caller snapshotted for undo
    /// when the drag began, so the whole drag is one undo step.
    static func drag(_ grab: inout Grab, to location: CGPoint, scale: Double, model: EditorModel) {
        let point = Point(
            view: CGPoint(x: location.x + grab.offset.width, y: location.y + grab.offset.height),
            scale: scale
        )

        switch grab.kind {
        case .move(let last):
            // Only the rectangle moves; the path keeps sampling where it was.
            model.changeStretch(transient: true) { spec in
                spec.anchor = Point(x: spec.anchor.x + point.x - last.x, y: spec.anchor.y + point.y - last.y)
            }
            grab.kind = .move(last: point)

        case .warp(let corner):
            model.changeStretch(transient: true) { spec in
                var warp = spec.warp ?? noWarp
                warp[corner] = spec.toWarpOffset(corner: corner, target: point)
                spec.warp = warp
                if spec.warpMode == .curved {
                    // Keep the existing localized page-fold gesture in curved mode.
                    spec.edges = noEdgeWarp
                    spec.curlCorner = corner
                    spec.bend = 0
                } else {
                    // Straight edges are an ordinary flat 2D skew/perspective edit.
                    spec.curlCorner = nil
                    spec.warpMode = .straight
                    spec.bend = 0
                }
            }

        case .edge(let edge, let control):
            model.changeStretch(transient: true) { spec in
                var edges = spec.edges ?? noEdgeWarp
                edges[edge][control] = spec.toEdgeOffset(edge: edge, control: control, target: point)
                spec.edges = edges
                spec.curlCorner = nil
                spec.warpMode = .curved
            }

        case .rotate:
            model.changeStretch(transient: true) { spec in
                let centre = spec.rectCenter
                // The grip stands off the rectangle's outer side, a quarter turn
                // from its `along` axis — which quarter depends on the side the
                // band extrudes to — so back that quarter turn out of the angle.
                let quarter = (spec.length < 0 ? -1.0 : 1.0) * .pi / 2
                let angle = atan2(point.y - centre.y, point.x - centre.x) - quarter
                let rotation = angle - chordAngle(spec.points)
                spec.anchor = spec.anchorForCentre(centre, rotation: rotation)
                spec.rotation = rotation
            }

        case .resize(let handle):
            let position = handle.position
            model.changeStretch(transient: true) { spec in
                let (along, out) = spec.rectBasis
                // Pointer position in the rectangle's own frame, relative to the anchor.
                let rel = Point(x: point.x - spec.anchor.x, y: point.y - spec.anchor.y)
                let u = rel.x * along.x + rel.y * along.y
                let v = rel.x * out.x + rel.y * out.y

                if position.v == 0.5 {
                    // Side handles drive the width.
                    if position.u == 0 {
                        // Dragging the near edge moves the anchor and shrinks the span.
                        spec.width -= u
                        spec.anchor = Point(x: spec.anchor.x + along.x * u, y: spec.anchor.y + along.y * u)
                    } else {
                        spec.width = u
                    }
                } else if position.v == 0 {
                    spec.length -= v
                    spec.anchor = Point(x: spec.anchor.x + out.x * v, y: spec.anchor.y + out.y * v)
                } else {
                    spec.length = v
                }
            }
        }
    }

    /// Double-tapping an edge control straightens that control again.
    static func resetControl(edge: Int, control: Int, model: EditorModel) {
        model.changeStretch(transient: false) { spec in
            var edges = spec.edges ?? noEdgeWarp
            edges[edge][control] = .zero
            spec.edges = edges
        }
    }
}

/// Draws the selected band's transform box and its size readout. Touches are
/// routed by `CanvasStage` through `RectEditing`.
struct StretchRectOverlay: View {
    let spec: StretchSpec
    let scale: Double

    var body: some View {
        let layout = RectEditing.Layout(spec: spec, scale: scale)

        ZStack(alignment: .topLeading) {
            Canvas { context, _ in
                let warped = spec.isWarped || layout.curvedMode
                context.fill(layout.outline, with: .color(Theme.accent.opacity(0.06)))
                context.stroke(
                    layout.outline,
                    with: .color(warped ? Theme.accentPurple : Theme.accent),
                    style: StrokeStyle(lineWidth: 1.5, dash: warped ? [6, 3] : [])
                )
                // Where the pixels came from.
                for line in layout.helperGrid {
                    context.stroke(
                        line,
                        with: .color(.white.opacity(0.75)),
                        style: StrokeStyle(lineWidth: 1)
                    )
                }
                for index in 1...2 {
                    let t = Double(index) / 3
                    for uv in [(t, 0.0), (t, 1.0), (0.0, t), (1.0, t)] {
                        let point = RectEditing.surfacePoint(spec, uv.0, uv.1).view(scale)
                        let dot = Path(ellipseIn: CGRect(x: point.x - 3, y: point.y - 3, width: 6, height: 6))
                        context.fill(dot, with: .color(.gray))
                        context.stroke(dot, with: .color(.white), lineWidth: 1)
                    }
                }

                context.stroke(layout.source, with: .color(.white.opacity(0.85)), style: StrokeStyle(lineWidth: 2, lineCap: .round))

                if layout.curvedMode && spec.curlCorner == nil {
                    var tangents = Path()
                    for edge in layout.curves {
                        tangents.move(to: edge.p0.view(scale))
                        tangents.addLine(to: edge.c0.view(scale))
                        tangents.move(to: edge.p1.view(scale))
                        tangents.addLine(to: edge.c1.view(scale))
                    }
                    context.stroke(tangents, with: .color(Theme.accentPurple.opacity(0.75)), style: StrokeStyle(lineWidth: 1, dash: [3, 2]))
                }

                var stem = Path()
                stem.move(to: layout.badge)
                stem.addLine(to: layout.rotate)
                context.stroke(stem, with: .color(Theme.accent), style: StrokeStyle(lineWidth: 1.25, dash: [3, 3]))

                for item in layout.handles {
                    let square = Path(CGRect(x: item.at.x - 5, y: item.at.y - 5, width: 10, height: 10))
                    context.fill(square, with: .color(.white))
                    context.stroke(square, with: .color(Theme.accent), lineWidth: 1.5)
                }

                // Controls above the handles: in curved mode they're what gets shaped.
                for item in layout.controls {
                    let dot = Path(ellipseIn: CGRect(x: item.at.x - 6, y: item.at.y - 6, width: 12, height: 12))
                    context.fill(dot, with: .color(Theme.accentPurple))
                    context.stroke(dot, with: .color(.white), lineWidth: 1.5)
                }

                let grip = Path(ellipseIn: CGRect(x: layout.rotate.x - 11, y: layout.rotate.y - 11, width: 22, height: 22))
                context.fill(grip, with: .color(Theme.panel.opacity(0.9)))
                context.stroke(grip, with: .color(Theme.accent), lineWidth: 1.75)
                if let arrow = context.resolveSymbol(id: "rotate") {
                    context.draw(arrow, at: layout.rotate)
                }
            } symbols: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.white)
                    .tag("rotate")
            }
            .allowsHitTesting(false)

            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: "W: \(jsRound(abs(spec.width))) px")
                Text(verbatim: "H: \(jsRound(abs(spec.length))) px")
            }
            .font(.system(size: 11.5, weight: .semibold).monospacedDigit())
            .foregroundStyle(.white)
            .padding(.horizontal, 10)
            .frame(width: 92, height: 38, alignment: .leading)
            .background(Theme.chip, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.chipBorder, lineWidth: 1))
            .position(x: layout.badge.x + 14 + 46, y: layout.badge.y - 40 + 19)
            .allowsHitTesting(false)
        }
    }
}

/// How far from a handle's centre a fingertip still picks it up, in points.
let touchReach: CGFloat = 24
