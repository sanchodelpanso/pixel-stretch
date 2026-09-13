import SwiftUI

/// Two-step editor mirroring the Photoshop tutorial workflow:
///  1. Select Subject — the auto-cutout shown highlighted over a dimmed
///     photo with a marching-ants box; confirm or fall back to whole photo.
///  2. Stretch — the band inside a free-transform box: pull the far-edge
///     handle to stretch, corner squares for height, a rotate handle with a
///     live degree badge, drag inside to move, and a Bend slider for the
///     warp. Pinch / two-finger rotate / double-tap-to-flip still work.
struct EditorView: View {
    enum Step {
        case subject, stretch
    }

    @ObservedObject var model: EditorViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var step: Step

    @State private var dragStart: StretchParameters?
    @State private var pinchStartLength: CGFloat?
    @State private var rotateStartAngle: CGFloat?
    @State private var lengthStart: CGFloat?
    @State private var topHandleStart: CGFloat?
    @State private var bottomHandleStart: CGFloat?
    @State private var rotateHandleStart: (paramAngle: CGFloat, touchAngle: CGFloat)?

    @State private var badge: String?
    @State private var exportItem: ExportItem?
    @State private var showExportError = false

    private let psBlue = Color(red: 0.35, green: 0.6, blue: 1.0)

    init(model: EditorViewModel) {
        _model = ObservedObject(wrappedValue: model)
        _step = State(initialValue: model.hasSubject ? .subject : .stretch)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                GeometryReader { geo in
                    let rect = fittedRect(in: geo.size)
                    ZStack {
                        Color.black
                        canvasImage(rect: rect)
                        if step == .subject {
                            MarchingAnts(rect: antsRect(in: rect))
                        } else {
                            TransformBox(geometry: bandGeometry(rect: rect), color: psBlue)
                            stretchHandles(rect: rect)
                        }
                    }
                    .coordinateSpace(name: "editorCanvas")
                    .contentShape(Rectangle())
                    .gesture(canvasDrag(rect: rect), including: stretchGestureMask)
                    .simultaneousGesture(pinch, including: stretchGestureMask)
                    .simultaneousGesture(twoFingerRotation, including: stretchGestureMask)
                    .simultaneousGesture(doubleTapFlip, including: stretchGestureMask)
                    .overlay(alignment: .top) {
                        if step == .stretch, let badge {
                            BadgeView(text: badge)
                                .padding(.top, 12)
                        }
                    }
                }
                bottomBar
            }
            .background(Color.black.ignoresSafeArea())
            .toolbar { toolbarContent }
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbarBackground(Color.black, for: .navigationBar)
        }
        .preferredColorScheme(.dark)
        .sheet(item: $exportItem) { item in
            ShareSheet(items: [item.url])
        }
        .alert("Export failed", isPresented: $showExportError) {
            Button("OK", role: .cancel) {}
        }
    }

    // MARK: - Steps

    private var stretchGestureMask: GestureMask {
        step == .stretch ? .all : .subviews
    }

    @ViewBuilder
    private func canvasImage(rect: CGRect) -> some View {
        let image = step == .subject
            ? (model.subjectPreview ?? model.previewImage)
            : model.previewImage
        if let image {
            Image(uiImage: image)
                .resizable()
                .frame(width: rect.width, height: rect.height)
                .position(x: rect.midX, y: rect.midY)
        } else {
            ProgressView()
                .tint(.white)
        }
    }

    private var bottomBar: some View {
        Group {
            switch step {
            case .subject:
                VStack(spacing: 14) {
                    Text("Subject detected — the stretch will go behind it.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    HStack(spacing: 12) {
                        Button("Use Whole Photo") {
                            model.useWholePhoto()
                            step = .stretch
                        }
                        .buttonStyle(.bordered)
                        Button("Use Subject") {
                            step = .stretch
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }
            case .stretch:
                VStack(spacing: 10) {
                    Text("Drag to move · Pull edge handle to stretch · ⟳ to rotate · Double-tap to flip")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    slider("Bend", value: $model.params.bend, in: -1...1)
                    slider("Fade", value: $model.params.fade, in: 0...1)
                    slider("Opacity", value: $model.params.opacity, in: 0.1...1)
                }
                .font(.footnote)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity)
        .background(Color.black)
    }

    private func slider(_ label: String, value: Binding<CGFloat>, in range: ClosedRange<CGFloat>) -> some View {
        HStack {
            Text(label).frame(width: 60, alignment: .leading)
            Slider(value: value, in: range)
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button("Close", systemImage: "xmark") { dismiss() }
        }
        ToolbarItem(placement: .principal) {
            Text(step == .subject ? "Select Subject" : "Stretch")
                .font(.headline)
        }
        if step == .stretch {
            if model.hasSubject {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Subject", systemImage: "chevron.left") { step = .subject }
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                if model.isExporting {
                    ProgressView()
                } else {
                    Button("Export") { export() }
                }
            }
        }
    }

    // MARK: - Whole-canvas gestures

    private func canvasDrag(rect: CGRect) -> some Gesture {
        DragGesture()
            .onChanged { value in
                if dragStart == nil { dragStart = model.params }
                guard let start = dragStart else { return }
                var params = start
                params.sampleX = clamp(start.sampleX + value.translation.width / rect.width, 0, 1)
                let bandHeight = start.extentBottom - start.extentTop
                let top = clamp(start.extentTop + value.translation.height / rect.height, 0, 1 - bandHeight)
                params.extentTop = top
                params.extentBottom = top + bandHeight
                model.params = params
            }
            .onEnded { _ in dragStart = nil }
    }

    private var pinch: some Gesture {
        MagnifyGesture()
            .onChanged { value in
                if pinchStartLength == nil { pinchStartLength = model.params.length }
                guard let start = pinchStartLength else { return }
                let sign: CGFloat = start < 0 ? -1 : 1
                let newLength = sign * clamp(abs(start) * value.magnification, 0.02, 1.5)
                model.params.length = newLength
                badge = widthBadge(for: newLength)
            }
            .onEnded { _ in
                pinchStartLength = nil
                badge = nil
            }
    }

    private var twoFingerRotation: some Gesture {
        RotateGesture()
            .onChanged { value in
                if rotateStartAngle == nil { rotateStartAngle = model.params.angle }
                guard let start = rotateStartAngle else { return }
                model.params.angle = start + value.rotation.radians
                badge = angleBadge()
            }
            .onEnded { _ in
                rotateStartAngle = nil
                badge = nil
            }
    }

    private var doubleTapFlip: some Gesture {
        TapGesture(count: 2)
            .onEnded { model.params.length.negate() }
    }

    // MARK: - Transform-box handles

    @ViewBuilder
    private func stretchHandles(rect: CGRect) -> some View {
        let geometry = bandGeometry(rect: rect)
        handleSquare(at: geometry.world(geometry.nearTop))
            .gesture(extentGesture(rect: rect, isTop: true))
        handleSquare(at: geometry.world(geometry.nearBottom))
            .gesture(extentGesture(rect: rect, isTop: false))
        handleSquare(at: geometry.world(geometry.farMid))
            .gesture(lengthGesture(rect: rect))
        rotateHandleView(at: geometry.world(geometry.rotateHandle), rect: rect)
    }

    private func handleSquare(at point: CGPoint) -> some View {
        Rectangle()
            .fill(.white)
            .overlay(Rectangle().stroke(psBlue, lineWidth: 1.5))
            .frame(width: 12, height: 12)
            .frame(width: 32, height: 32)
            .contentShape(Rectangle())
            .position(point)
    }

    private func rotateHandleView(at point: CGPoint, rect: CGRect) -> some View {
        Circle()
            .fill(.white)
            .overlay(
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(psBlue)
            )
            .frame(width: 22, height: 22)
            .frame(width: 36, height: 36)
            .contentShape(Circle())
            .position(point)
            .gesture(rotateHandleGesture(rect: rect))
    }

    private func lengthGesture(rect: CGRect) -> some Gesture {
        DragGesture()
            .onChanged { value in
                if lengthStart == nil { lengthStart = model.params.length }
                guard let start = lengthStart else { return }
                let angle = model.params.angle
                let along = (value.translation.width * cos(angle)
                             + value.translation.height * sin(angle)) / rect.width
                let newLength = clamp(start + along, -1.5, 1.5)
                model.params.length = newLength
                badge = widthBadge(for: newLength)
            }
            .onEnded { _ in
                lengthStart = nil
                badge = nil
            }
    }

    private func extentGesture(rect: CGRect, isTop: Bool) -> some Gesture {
        DragGesture()
            .onChanged { value in
                // Project the drag onto the band's local vertical axis so
                // handles keep working when rotated.
                let angle = model.params.angle
                let delta = (value.translation.width * -sin(angle)
                             + value.translation.height * cos(angle)) / rect.height
                if isTop {
                    if topHandleStart == nil { topHandleStart = model.params.extentTop }
                    guard let start = topHandleStart else { return }
                    model.params.extentTop = clamp(start + delta, 0, model.params.extentBottom - 0.02)
                } else {
                    if bottomHandleStart == nil { bottomHandleStart = model.params.extentBottom }
                    guard let start = bottomHandleStart else { return }
                    model.params.extentBottom = clamp(start + delta, model.params.extentTop + 0.02, 1)
                }
                let heightPx = (model.params.extentBottom - model.params.extentTop) * model.imagePixelSize.height
                badge = "H: \(Int(heightPx)) px"
            }
            .onEnded { _ in
                topHandleStart = nil
                bottomHandleStart = nil
                badge = nil
            }
    }

    private func rotateHandleGesture(rect: CGRect) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .named("editorCanvas"))
            .onChanged { value in
                let pivot = bandGeometry(rect: rect).pivot
                let touchAngle = atan2(value.location.y - pivot.y, value.location.x - pivot.x)
                if rotateHandleStart == nil {
                    rotateHandleStart = (model.params.angle, touchAngle)
                }
                guard let start = rotateHandleStart else { return }
                model.params.angle = start.paramAngle + (touchAngle - start.touchAngle)
                badge = angleBadge()
            }
            .onEnded { _ in
                rotateHandleStart = nil
                badge = nil
            }
    }

    // MARK: - Badges

    private func widthBadge(for length: CGFloat) -> String {
        "W: \(Int(abs(length) * model.imagePixelSize.width)) px"
    }

    private func angleBadge() -> String {
        String(format: "∠ %.1f°", model.params.angle * 180 / .pi)
    }

    // MARK: - Geometry

    private func fittedRect(in size: CGSize) -> CGRect {
        guard size.width > 0, size.height > 0 else { return .zero }
        let scale = min(size.width / model.imageAspect, size.height)
        let width = scale * model.imageAspect
        let height = scale
        return CGRect(
            x: (size.width - width) / 2,
            y: (size.height - height) / 2,
            width: width,
            height: height
        )
    }

    private func bandGeometry(rect: CGRect) -> BandGeometry {
        let params = model.params
        return BandGeometry(
            pivot: CGPoint(
                x: rect.minX + params.sampleX * rect.width,
                y: rect.minY + params.pivotY * rect.height
            ),
            angle: params.angle,
            vTop: (params.extentTop - params.pivotY) * rect.height,
            vBottom: (params.extentBottom - params.pivotY) * rect.height,
            length: params.length * rect.width,
            droop: params.bend * (params.extentBottom - params.extentTop) * rect.height
        )
    }

    private func antsRect(in rect: CGRect) -> CGRect {
        let box = model.maskBBox ?? CGRect(x: 0.1, y: 0.1, width: 0.8, height: 0.8)
        return CGRect(
            x: rect.minX + box.minX * rect.width,
            y: rect.minY + box.minY * rect.height,
            width: box.width * rect.width,
            height: box.height * rect.height
        ).insetBy(dx: -10, dy: -10)
    }

    private func export() {
        Task {
            do {
                exportItem = ExportItem(url: try await model.exportStill())
            } catch {
                showExportError = true
            }
        }
    }
}

// MARK: - Band geometry

/// The band in its local frame: origin at the pivot (on the sample line),
/// x along the stretch direction, y down. `world` rotates about the pivot
/// and translates into canvas coordinates.
private struct BandGeometry {
    let pivot: CGPoint
    let angle: CGFloat
    let vTop: CGFloat
    let vBottom: CGFloat
    let length: CGFloat
    let droop: CGFloat

    var nearTop: CGPoint { CGPoint(x: 0, y: vTop) }
    var nearBottom: CGPoint { CGPoint(x: 0, y: vBottom) }
    var farTop: CGPoint { CGPoint(x: length, y: vTop + droop) }
    var farBottom: CGPoint { CGPoint(x: length, y: vBottom + droop) }
    var farMid: CGPoint { CGPoint(x: length, y: (vTop + vBottom) / 2 + droop) }
    var rotateHandle: CGPoint {
        let sign: CGFloat = length < 0 ? -1 : 1
        return CGPoint(x: length + 36 * sign, y: (vTop + vBottom) / 2 + droop)
    }
    /// Control points give the exact quadratic droop curve the kernel draws:
    /// with the control at zero offset, the Bézier's y is droop · t².
    var topControl: CGPoint { CGPoint(x: length / 2, y: vTop) }
    var bottomControl: CGPoint { CGPoint(x: length / 2, y: vBottom) }

    func world(_ p: CGPoint) -> CGPoint {
        let c = cos(angle)
        let s = sin(angle)
        return CGPoint(x: pivot.x + c * p.x - s * p.y, y: pivot.y + s * p.x + c * p.y)
    }
}

// MARK: - Overlay views

/// Free-transform box around the band: solid white sample line, blue edges
/// (curved when bent), and a connector out to the rotate handle.
private struct TransformBox: View {
    let geometry: BandGeometry
    let color: Color

    var body: some View {
        Canvas { context, _ in
            var sampleLine = Path()
            sampleLine.move(to: geometry.world(geometry.nearTop))
            sampleLine.addLine(to: geometry.world(geometry.nearBottom))
            context.stroke(sampleLine, with: .color(.white), lineWidth: 2)

            var box = Path()
            box.move(to: geometry.world(geometry.nearTop))
            box.addQuadCurve(
                to: geometry.world(geometry.farTop),
                control: geometry.world(geometry.topControl)
            )
            box.addLine(to: geometry.world(geometry.farBottom))
            box.addQuadCurve(
                to: geometry.world(geometry.nearBottom),
                control: geometry.world(geometry.bottomControl)
            )
            context.stroke(box, with: .color(color), lineWidth: 1.5)

            var connector = Path()
            connector.move(to: geometry.world(geometry.farMid))
            connector.addLine(to: geometry.world(geometry.rotateHandle))
            context.stroke(connector, with: .color(color.opacity(0.8)), lineWidth: 1)
        }
        .allowsHitTesting(false)
    }
}

/// Photoshop-style animated selection border.
private struct MarchingAnts: View {
    let rect: CGRect

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
            Canvas { context, _ in
                let phase = CGFloat(
                    timeline.date.timeIntervalSinceReferenceDate * 24
                ).truncatingRemainder(dividingBy: 12)
                let path = Path(rect)
                context.stroke(
                    path,
                    with: .color(.black.opacity(0.8)),
                    style: StrokeStyle(lineWidth: 1.5, dash: [6, 6], dashPhase: phase + 6)
                )
                context.stroke(
                    path,
                    with: .color(.white),
                    style: StrokeStyle(lineWidth: 1.5, dash: [6, 6], dashPhase: phase)
                )
            }
        }
        .allowsHitTesting(false)
    }
}

private struct BadgeView: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption.monospacedDigit().weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(.black.opacity(0.75), in: Capsule())
    }
}

private func clamp(_ value: CGFloat, _ lower: CGFloat, _ upper: CGFloat) -> CGFloat {
    min(max(value, lower), upper)
}
