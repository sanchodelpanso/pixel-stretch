import Foundation
import UIKit
import UniformTypeIdentifiers

extension UTType {
    /// The web app writes self-contained JSON files with this extension.
    static var pixelStretchProject: UTType {
        UTType(importedAs: "com.pixelstretch.project", conformingTo: .json)
    }
}

struct PixelStretchProject: Codable {
    static let currentFormat = "com.pixelstretch.project"
    static let currentVersion = 1

    let format: String
    let version: Int
    let savedAt: String
    let canvas: Canvas
    let selectedLayerId: String?
    let layers: [Layer]

    struct Canvas: Codable {
        let width: Int
        let height: Int
    }

    struct Layer: Codable, Identifiable {
        let id: String
        let name: String
        let width: Int
        let height: Int
        let x: Double
        let y: Double
        let visible: Bool
        let opacity: Double
        let locked: Bool
        let bitmap: Bitmap
        let stretch: Stretch?
    }

    struct Bitmap: Codable {
        let mimeType: String
        /// Swift's Codable representation of Data is base64, matching the web file.
        let data: Data
    }

    struct Point: Codable {
        let x: Double
        let y: Double
    }

    struct Offset: Codable {
        let u: Double
        let v: Double
    }

    struct Stretch: Codable {
        let points: [Point]
        let sourceLayerId: String
        let anchor: Point
        let width: Double
        let length: Double
        let rotation: Double
        let fade: Double
        let edgeSoftness: Double
        let bend: Double
        let warp: [Offset]?
        let warpMode: String?
        let edges: [[Offset]]?
    }

    static func decode(_ data: Data) throws -> PixelStretchProject {
        let project: PixelStretchProject
        do {
            project = try JSONDecoder().decode(PixelStretchProject.self, from: data)
        } catch {
            throw ProjectError.invalidFile
        }
        try project.validate()
        return project
    }

    func flattenedImage() throws -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let size = CGSize(width: canvas.width, height: canvas.height)
        return try UIGraphicsImageRenderer(size: size, format: format).image { context in
            for layer in layers where layer.visible && layer.opacity > 0 {
                guard let image = UIImage(data: layer.bitmap.data) else {
                    context.cgContext.clear(CGRect(origin: .zero, size: size))
                    return
                }
                image.draw(
                    in: CGRect(x: layer.x, y: layer.y, width: Double(layer.width), height: Double(layer.height)),
                    blendMode: .normal,
                    alpha: layer.opacity
                )
            }
        }
    }

    private func validate() throws {
        guard format == Self.currentFormat else { throw ProjectError.wrongFormat }
        guard version == Self.currentVersion else { throw ProjectError.unsupportedVersion(version) }
        guard (1...32_768).contains(canvas.width),
              (1...32_768).contains(canvas.height),
              (1...500).contains(layers.count) else {
            throw ProjectError.invalidDimensions
        }
        let ids = Set(layers.map(\.id))
        guard ids.count == layers.count else { throw ProjectError.duplicateLayer }
        for layer in layers {
            guard !layer.id.isEmpty,
                  (1...32_768).contains(layer.width),
                  (1...32_768).contains(layer.height),
                  layer.opacity.isFinite,
                  (0...1).contains(layer.opacity),
                  layer.x.isFinite,
                  layer.y.isFinite,
                  layer.bitmap.mimeType == "image/png",
                  UIImage(data: layer.bitmap.data) != nil else {
                throw ProjectError.invalidLayer(layer.name)
            }
            if let stretch = layer.stretch {
                guard ids.contains(stretch.sourceLayerId),
                      stretch.points.count >= 2,
                      stretch.points.allSatisfy({ $0.x.isFinite && $0.y.isFinite }),
                      stretch.width.isFinite,
                      stretch.length.isFinite,
                      stretch.rotation.isFinite,
                      stretch.fade.isFinite,
                      stretch.edgeSoftness.isFinite,
                      stretch.bend.isFinite else {
                    throw ProjectError.invalidStretch(layer.name)
                }
            }
        }
    }
}

enum ProjectError: LocalizedError {
    case invalidFile
    case wrongFormat
    case unsupportedVersion(Int)
    case invalidDimensions
    case duplicateLayer
    case invalidLayer(String)
    case invalidStretch(String)
    case renderFailed

    var errorDescription: String? {
        switch self {
        case .invalidFile: "This is not a valid PixelStretch project."
        case .wrongFormat: "This file was not created by PixelStretch."
        case .unsupportedVersion(let version): "PixelStretch project version \(version) is not supported."
        case .invalidDimensions: "The project canvas or layer stack is invalid."
        case .duplicateLayer: "The project contains duplicate layer identifiers."
        case .invalidLayer(let name): "The layer “\(name)” is damaged or unsupported."
        case .invalidStretch(let name): "The stretch geometry in “\(name)” is invalid."
        case .renderFailed: "The project preview could not be rendered."
        }
    }
}

@MainActor
final class ImportedProject: Identifiable {
    let id = UUID()
    let document: PixelStretchProject
    let image: UIImage

    init(data: Data) throws {
        document = try PixelStretchProject.decode(data)
        image = try document.flattenedImage()
    }

    var stretchCount: Int { document.layers.filter { $0.stretch != nil }.count }

    func exportFlattenedPNG() throws -> URL {
        guard let data = image.pngData() else { throw ProjectError.renderFailed }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("PixelStretch-Project-\(Int(Date().timeIntervalSince1970)).png")
        try data.write(to: url, options: .atomic)
        return url
    }
}
