import Vision
import CoreImage

enum SegmentationError: Error {
    case noSubjectFound
}

/// Segmentation layer: image in, soft alpha mask out. The implementation
/// behind this interface is swappable; nothing downstream knows about Vision.
struct SubjectSegmenter {

    /// Returns a soft alpha mask with the same pixel dimensions as the input.
    /// The input image is expected to already be orientation-normalized (.up).
    func mask(for image: CGImage) throws -> CIImage {
        let request = VNGenerateForegroundInstanceMaskRequest()
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        try handler.perform([request])

        guard let result = request.results?.first,
              !result.allInstances.isEmpty else {
            throw SegmentationError.noSubjectFound
        }

        // Phase 1 uses all detected instances as one subject; tap-to-select
        // per instance comes later and only changes the IndexSet passed here.
        let buffer = try result.generateScaledMaskForImage(
            forInstances: result.allInstances,
            from: handler
        )
        return CIImage(cvPixelBuffer: buffer)
    }
}
