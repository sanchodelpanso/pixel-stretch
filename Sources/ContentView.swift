import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct ContentView: View {
    @State private var selection: PhotosPickerItem?
    @State private var editor: EditorModel?
    @State private var isLoading = false
    @State private var loadingMessage = "Opening image…"
    @State private var errorMessage: String?
    @State private var showProjectImporter = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Spacer()
                Image("Logo")
                    .resizable()
                    .frame(width: 88, height: 88)
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .shadow(color: .black.opacity(0.18), radius: 12, y: 4)
                    .accessibilityHidden(true)
                Text("PixelStretch")
                    .font(.largeTitle.bold())
                Text("Pick a photo or open a project —\nthen pull stretch bands out of any layer.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Spacer()
                if isLoading {
                    ProgressView(loadingMessage)
                        .padding(.bottom, 8)
                }
                PhotosPicker(selection: $selection, matching: .images) {
                    Label("Choose Photo", systemImage: "photo.on.rectangle")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.borderedProminent)
                .disabled(isLoading)
                Button {
                    showProjectImporter = true
                } label: {
                    Label("Open Project", systemImage: "doc.badge.arrow.up")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.bordered)
                .disabled(isLoading)
            }
            .padding(24)
        }
        .onChange(of: selection) { _, item in
            guard let item else { return }
            Task { await load(item) }
        }
        .fullScreenCover(item: $editor) { model in
            EditorScreen(model: model)
        }
        .fileImporter(
            isPresented: $showProjectImporter,
            allowedContentTypes: [.pixelStretchProject],
            allowsMultipleSelection: false
        ) { result in
            switch result {
            case .success(let urls):
                guard let url = urls.first else { return }
                Task { await loadProject(url) }
            case .failure(let error):
                errorMessage = error.localizedDescription
            }
        }
        .onOpenURL { url in
            Task { await loadProject(url) }
        }
        .alert(
            errorMessage ?? "Something went wrong.",
            isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        }
    }

    @MainActor
    private func load(_ item: PhotosPickerItem) async {
        isLoading = true
        loadingMessage = "Opening image…"
        defer {
            isLoading = false
            selection = nil
        }

        guard let data = try? await item.loadTransferable(type: Data.self),
              let image = await Task.detached(priority: .userInitiated, operation: {
                  UIImage(data: data)?.uprightSRGBImage()
              }).value else {
            errorMessage = "That photo couldn't be read."
            return
        }
        editor = EditorModel(source: .image(image))
    }

    @MainActor
    private func loadProject(_ url: URL) async {
        isLoading = true
        loadingMessage = "Opening project…"
        defer { isLoading = false }

        let hasAccess = url.startAccessingSecurityScopedResource()
        defer { if hasAccess { url.stopAccessingSecurityScopedResource() } }
        do {
            let project = try await Task.detached(priority: .userInitiated) {
                try ProjectFile.decode(Data(contentsOf: url, options: .mappedIfSafe))
            }.value
            editor = EditorModel(source: .project(project))
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription
                ?? "That project couldn't be opened."
        }
    }
}
