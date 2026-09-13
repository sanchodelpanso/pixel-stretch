import SwiftUI

/// Controls for the selected generative stretch layer.
struct StretchPanel: View {
    let model: EditorModel
    let layer: Layer
    let spec: StretchSpec

    /// A slider drag is one undo step; a VoiceOver adjustment is its own.
    @State private var sliding = false

    private var sourceName: String? { model.store.layer(spec.sourceLayerId)?.name }
    private var maxLength: Double { Double(max(model.store.doc.width, model.store.doc.height)) }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 3) {
                    let arc = jsRound(polylineLength(pathToPolyline(spec.points)))
                    let angle = jsRound(degrees(chordAngle(spec.points)))
                    Text(verbatim: "Path \(arc)px · \(spec.points.count) point\(spec.points.count == 1 ? "" : "s") · \(angle)°")
                    if spec.rotation != 0 {
                        Text(verbatim: "Rectangle turned \(jsRound(degrees(spec.rotation)))° off the path")
                    }
                    if spec.curlCorner != nil {
                        Text("Bend and distort · the other corners stay pinned")
                    }
                    if spec.warpMode == .curved && spec.curlCorner == nil {
                        Text("Curved shape · purple controls make a flat 2D wave")
                    }
                    if spec.warpMode != .curved && spec.isWarped {
                        Text("2D skew · drag any corner while the edges are straight")
                    }
                    if let sourceName {
                        Text(verbatim: "from \(sourceName)")
                    } else {
                        Text("source layer is gone").foregroundStyle(Theme.warning)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            } header: {
                HStack {
                    Text("Stretch")
                    Text(layer.name)
                        .textCase(nil)
                        .lineLimit(1)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Theme.accentPurple.opacity(0.35), in: Capsule())
                }
            }

            Section {
                HStack {
                    Button("Edit path") { model.editPath() }
                    Spacer()
                    Button("Flip side") {
                        model.changeStretch(transient: false) { $0.length = -$0.length }
                    }
                    Spacer()
                    Button("Unrotate") {
                        model.changeStretch(transient: false) { $0.rotation = 0 }
                    }
                    .disabled(spec.rotation == 0)
                    Spacer()
                    Button("Reset shape") {
                        model.changeStretch(transient: false) { spec in
                            spec.warp = noWarp
                            spec.edges = noEdgeWarp
                            spec.bend = 0
                            spec.curlCorner = nil
                        }
                    }
                    .disabled(!spec.isWarped && spec.bend == 0 && !spec.hasCurvedEdges)
                }
                .buttonStyle(.borderless)
                .font(.subheadline)
            }

            Section {
                slider("Width", value: spec.width, range: 1...maxLength, step: 1, format: { "\(jsRound($0))px" }) { spec, value in
                    spec.width = value
                }
                slider("Length", value: spec.length, range: -maxLength...maxLength, step: 1, format: { "\(jsRound($0))px" }) { spec, value in
                    spec.length = value
                }
                slider("Rotate", value: Double(jsRound(degrees(spec.rotation))), range: -180...180, step: 1, format: { "\(jsRound($0))°" }) { spec, value in
                    spec.rotation = value * .pi / 180
                }
                slider("Fade", value: spec.fade, range: 0...1, step: 0.01, format: { "\(jsRound($0 * 100))%" }) { spec, value in
                    spec.fade = value
                }
                slider("Softness", value: spec.edgeSoftness, range: 0...0.5, step: 0.005, format: { "\(jsRound($0 * 100))%" }) { spec, value in
                    spec.edgeSoftness = value
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
    }

    private func slider(
        _ label: String,
        value: Double,
        range: ClosedRange<Double>,
        step: Double,
        format: @escaping (Double) -> String,
        apply: @escaping (inout StretchSpec, Double) -> Void
    ) -> some View {
        HStack(spacing: 10) {
            Text(label)
                .frame(width: 68, alignment: .leading)
            Slider(
                value: Binding(
                    get: { clamp(value, range.lowerBound, range.upperBound) },
                    set: { newValue in model.changeStretch(transient: sliding) { apply(&$0, newValue) } }
                ),
                in: range,
                step: step,
                onEditingChanged: { editing in
                    // Snapshot the pre-drag state once; the drag's edits are transient.
                    if editing { model.store.beginHistory() }
                    sliding = editing
                }
            )
            .accessibilityLabel(label)
            Text(format(value))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .frame(width: 58, alignment: .trailing)
        }
        .font(.subheadline)
    }

    private func degrees(_ radians: Double) -> Double {
        radians * 180 / .pi
    }
}
