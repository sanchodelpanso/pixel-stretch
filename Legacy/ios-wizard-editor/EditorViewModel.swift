import SwiftUI
import CoreImage
import CoreImage.CIFilterBuiltins

@MainActor
final class EditorViewModel: ObservableObject, Identifiable {

    let id = UUID()

    @Published var previewImage: UIImage?
    /// Subject-step preview: dimmed photo with the cutout at full brightness,
    /// the app's version of Photoshop's Select Subject state.
    @Published var subjectPreview: UIImage?
    @Published var params = StretchParameters() {
        didSet { scheduleRender() }
    }
    @Published var isExporting = false

    /// Aspect ratio of the source image (width / height), for layout.
    let imageAspect: CGFloat
    /// Native pixel size, for the W/H/angle badges shown while dragging.
    let imagePixelSize: CGSize
    /// False when segmentation failed; the editor skips the subject step.
    let hasSubject: Bool
    /// Normalized (top-left origin) bounding box of the subject mask,
    /// for the marching-ants rectangle.
    private(set) var maskBBox: CGRect?

    private let renderer = StretchRenderer.shared
    private let fullOriginal: CIImage
    private var fullMask: CIImage
    private let previewOriginal: CIImage
    private var previewMask: CIImage
    private let previewScale: CGFloat

    private var isRendering = false
    private var needsRender = false

    init(image: CGImage, mask: CIImage?) {
        let original = CIImage(cgImage: image)
        fullOriginal = original
        imagePixelSize = original.extent.size
        imageAspect = original.extent.width / original.extent.height
        hasSubject = mask != nil
        // No mask (segmentation failed) degrades gracefully: a black mask
        // means the band simply draws over the whole photo.
        fullMask = mask ?? CIImage(color: .black).cropped(to: original.extent)

        let maxDim = max(original.extent.width, original.extent.height)
        previewScale = min(1, 1600 / maxDim)
        previewOriginal = fullOriginal.downscaled(by: previewScale)
        previewMask = fullMask.downscaled(by: previewScale)

        if hasSubject,
           let box = Self.maskBoundingBox(previewMask, context: renderer.context) {
            maskBBox = box
            params.sampleX = box.midX
            params.extentTop = box.minY
            params.extentBottom = box.maxY
        }
        scheduleRender()
        if hasSubject {
            renderSubjectPreview()
        }
    }

    /// "Deselect": the band will draw over the whole photo instead of
    /// behind the subject.
    func useWholePhoto() {
        fullMask = CIImage(color: .black).cropped(to: fullOriginal.extent)
        previewMask = fullMask.downscaled(by: previewScale)
        scheduleRender()
    }

    // MARK: - Preview rendering

    /// Coalesces bursts of param changes: at most one render in flight, and
    /// at most one queued behind it, so gestures never back up.
    private func scheduleRender() {
        if isRendering {
            needsRender = true
            return
        }
        isRendering = true
        let params = params
        let source = previewOriginal
        let mask = previewMask
        let renderer = renderer

        Task.detached(priority: .userInitiated) {
            let output = renderer.render(original: source, mask: mask, params: params)
            let cgImage = renderer.context.createCGImage(output, from: source.extent)
            await MainActor.run { [weak self] in
                guard let self else { return }
                if let cgImage {
                    self.previewImage = UIImage(cgImage: cgImage)
                }
                self.isRendering = false
                if self.needsRender {
                    self.needsRender = false
                    self.scheduleRender()
                }
            }
        }
    }

    private func renderSubjectPreview() {
        let source = previewOriginal
        let mask = previewMask
        let renderer = renderer

        Task.detached(priority: .userInitiated) {
            let dimmed = source.applyingFilter("CIColorMatrix", parameters: [
                "inputRVector": CIVector(x: 0.35, y: 0, z: 0, w: 0),
                "inputGVector": CIVector(x: 0, y: 0.35, z: 0, w: 0),
                "inputBVector": CIVector(x: 0, y: 0, z: 0.35, w: 0),
            ])
            let blend = CIFilter.blendWithMask()
            blend.inputImage = source
            blend.backgroundImage = dimmed
            blend.maskImage = mask
            guard let output = blend.outputImage,
                  let cgImage = renderer.context.createCGImage(output, from: source.extent) else {
                return
            }
            await MainActor.run { [weak self] in
                self?.subjectPreview = UIImage(cgImage: cgImage)
            }
        }
    }

    // MARK: - Export

    /// Re-runs the same shader once at native resolution. Parameters are
    /// normalized, so no scaling step exists to get wrong.
    func exportStill() async throws -> URL {
        isExporting = true
        defer { isExporting = false }

        let params = params
        let source = fullOriginal
        let mask = fullMask
        let renderer = renderer

        return try await Task.detached(priority: .userInitiated) {
            let output = renderer.render(original: source, mask: mask, params: params)
            let colorSpace = source.colorSpace
                ?? CGColorSpace(name: CGColorSpace.displayP3)!
            guard let data = renderer.context.jpegRepresentation(
                of: output,
                colorSpace: colorSpace,
                options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.95]
            ) else {
                throw ExportError.renderFailed
            }
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("PixelStretch-\(Int(Date().timeIntervalSince1970)).jpg")
            try data.write(to: url)
            return url
        }.value
    }

    enum ExportError: Error {
        case renderFailed
    }

    // MARK: - Mask bounding box

    /// Scans a small grayscale rendering of the mask to place the initial
    /// band on the subject. Returns a normalized rect in top-left-origin
    /// coordinates, or nil if the mask is empty.
    private static func maskBoundingBox(_ mask: CIImage, context: CIContext) -> CGRect? {
        let sampleWidth = 64
        let scale = CGFloat(sampleWidth) / mask.extent.width
        let sampleHeight = max(1, Int(mask.extent.height * scale))
        let scaled = mask.downscaled(by: scale)

        var pixels = [UInt8](repeating: 0, count: sampleWidth * sampleHeight)
        context.render(
            scaled,
            toBitmap: &pixels,
            rowBytes: sampleWidth,
            bounds: CGRect(x: 0, y: 0, width: sampleWidth, height: sampleHeight),
            format: .L8,
            colorSpace: CGColorSpaceCreateDeviceGray()
        )

        var minX = sampleWidth, maxX = -1, minY = sampleHeight, maxY = -1
        for y in 0..<sampleHeight {
            for x in 0..<sampleWidth where pixels[y * sampleWidth + x] > 25 {
                minX = min(minX, x); maxX = max(maxX, x)
                minY = min(minY, y); maxY = max(maxY, y)
            }
        }
        guard maxX >= 0 else { return nil }

        return CGRect(
            x: CGFloat(minX) / CGFloat(sampleWidth),
            y: CGFloat(minY) / CGFloat(sampleHeight),
            width: CGFloat(maxX - minX + 1) / CGFloat(sampleWidth),
            height: CGFloat(maxY - minY + 1) / CGFloat(sampleHeight)
        )
    }
}

private extension CIImage {
    func downscaled(by scale: CGFloat) -> CIImage {
        guard scale < 1 else { return self }
        return transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    }
}
