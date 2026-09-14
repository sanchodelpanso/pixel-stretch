// Optional macOS photo filter, independent of the app and its future iOS port.
// Usage: detect-people path/to/photo.jpg [...]
import Foundation
import ImageIO
import Vision

for path in CommandLine.arguments.dropFirst() {
    autoreleasepool {
        do {
            let url = URL(fileURLWithPath: path)
            let source = CGImageSourceCreateWithURL(url as CFURL, nil)
            let properties = source.flatMap { CGImageSourceCopyPropertiesAtIndex($0, 0, nil) as? [CFString: Any] }
            let rawOrientation = (properties?[kCGImagePropertyOrientation] as? UInt32) ?? 1
            let orientation = CGImagePropertyOrientation(rawValue: rawOrientation) ?? .up
            let faces = VNDetectFaceRectanglesRequest()
            let bodies = VNDetectHumanRectanglesRequest()
            bodies.upperBodyOnly = false
            try VNImageRequestHandler(url: url, orientation: orientation).perform([faces, bodies])
            let faceCount = (faces.results ?? []).filter { $0.confidence >= 0.5 }.count
            let bodyCount = (bodies.results ?? []).filter { $0.confidence >= 0.5 }.count
            let result: [String: Any] = ["file": path, "faces": faceCount, "bodies": bodyCount]
            let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
            print(String(decoding: data, as: UTF8.self))
        } catch {
            let data = try! JSONSerialization.data(withJSONObject: ["file": path, "error": error.localizedDescription])
            print(String(decoding: data, as: UTF8.self))
        }
    }
}
