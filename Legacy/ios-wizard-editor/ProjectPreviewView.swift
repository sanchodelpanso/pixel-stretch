import SwiftUI

struct ProjectPreviewView: View {
    let project: ImportedProject
    @Environment(\.dismiss) private var dismiss
    @State private var exportItem: ExportItem?
    @State private var showExportError = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                GeometryReader { geometry in
                    Image(uiImage: project.image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Color.black)
                        .accessibilityLabel("Flattened PixelStretch project preview")
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text("\(project.document.layers.count) layers · \(project.stretchCount) stretch objects")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(project.document.layers.reversed()) { layer in
                                HStack(spacing: 6) {
                                    Image(systemName: layer.stretch == nil ? "photo" : "rectangle.and.hand.point.up.left")
                                    Text(layer.name).lineLimit(1)
                                }
                                .font(.caption)
                                .foregroundStyle(layer.visible ? .primary : .secondary)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 7)
                                .background(.thinMaterial, in: Capsule())
                            }
                        }
                    }
                    Text("All layer pixels, ordering, properties, and stretch geometry remain stored in the project file.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .padding()
                .background(Color(uiColor: .secondarySystemBackground))
            }
            .navigationTitle("PixelStretch Project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Export PNG", systemImage: "square.and.arrow.up") { export() }
                }
            }
        }
        .sheet(item: $exportItem) { item in
            ShareSheet(items: [item.url])
        }
        .alert("Export failed", isPresented: $showExportError) {
            Button("OK", role: .cancel) {}
        }
    }

    private func export() {
        do {
            exportItem = ExportItem(url: try project.exportFlattenedPNG())
        } catch {
            showExportError = true
        }
    }
}
