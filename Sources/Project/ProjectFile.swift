import CoreGraphics
import Foundation
import SwiftUI
import UniformTypeIdentifiers

extension UTType {
    /// Self-contained JSON projects, shared with the web app.
    static var pixelStretchProject: UTType {
        UTType(importedAs: "com.pixelstretch.project", conformingTo: .json)
    }
}

/// A decoded project, not yet owning any layer ids in the editor.
struct LoadedProject: Sendable {
    let document: LayerDocument
    let selectedLayerId: String?
}

struct ProjectFileError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// The `.pixelstretch` format: one JSON object, layer PNGs embedded as base64,
/// layers bottom-first. Byte-compatible with the web app's `project-file.ts`.
enum ProjectFile {
    static let format = "com.pixelstretch.project"
    static let version = 1

    static func filename(date: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd-HHmm"
        return "PixelStretch-\(formatter.string(from: date))"
    }

    // MARK: - Encoding

    private struct EncodedProject: Encodable {
        let format: String
        let version: Int
        let savedAt: String
        let canvas: Canvas
        let selectedLayerId: String?
        let layers: [EncodedLayer]

        struct Canvas: Encodable {
            let width: Int
            let height: Int
        }

        enum CodingKeys: CodingKey {
            case format, version, savedAt, canvas, selectedLayerId, layers
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(format, forKey: .format)
            try container.encode(version, forKey: .version)
            try container.encode(savedAt, forKey: .savedAt)
            try container.encode(canvas, forKey: .canvas)
            // Written as `null` rather than omitted, like the web app.
            try container.encode(selectedLayerId, forKey: .selectedLayerId)
            try container.encode(layers, forKey: .layers)
        }
    }

    private struct EncodedLayer: Encodable {
        let id: String
        let name: String
        let width: Int
        let height: Int
        let x: Double
        let y: Double
        let visible: Bool
        let opacity: Double
        let locked: Bool
        let bitmap: EncodedBitmap
        let stretch: StretchSpec?
    }

    private struct EncodedBitmap: Encodable {
        let mimeType = "image/png"
        /// `Data` encodes as base64.
        let data: Data
    }

    /// Create a self-contained JSON project. Safe to call off the main actor.
    static func encode(_ document: LayerDocument, selectedLayerId: String?) throws -> Data {
        guard document.width > 0, document.height > 0, !document.layers.isEmpty else {
            throw ProjectFileError(message: "There is no project to save.")
        }
        // Encoded one at a time, so only one PNG encoder's buffers are alive at once.
        let layers = try document.layers.map { layer in
            guard let png = BitmapContext.pngData(layer.bitmap.image) else {
                throw ProjectFileError(message: "A layer could not be encoded.")
            }
            return EncodedLayer(
                id: layer.id, name: layer.name, width: layer.width, height: layer.height,
                x: layer.x, y: layer.y, visible: layer.visible, opacity: layer.opacity, locked: layer.locked,
                bitmap: EncodedBitmap(data: png), stretch: layer.stretch
            )
        }
        let timestamp = ISO8601DateFormatter()
        timestamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let project = EncodedProject(
            format: format,
            version: version,
            savedAt: timestamp.string(from: Date()),
            canvas: .init(width: document.width, height: document.height),
            selectedLayerId: selectedLayerId,
            layers: layers
        )
        let encoder = JSONEncoder()
        // Base64 is full of slashes; escaping them only bloats the file.
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return try encoder.encode(project)
    }

    // MARK: - Decoding

    /// Decode and validate an untrusted project file before handing it to the
    /// editor. Safe to call off the main actor.
    static func decode(_ data: Data) throws -> LoadedProject {
        let value: Any
        do {
            value = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw ProjectFileError(message: "This is not a valid PixelStretch project.")
        }
        guard let root = value as? [String: Any], root["format"] as? String == format else {
            throw ProjectFileError(message: "This file is not a PixelStretch project.")
        }
        guard let fileVersion = root["version"] as? NSNumber, !isBoolean(fileVersion), fileVersion.doubleValue == Double(version) else {
            throw ProjectFileError(message: "Project version \(describe(root["version"])) is not supported by this app.")
        }
        guard let canvas = root["canvas"] as? [String: Any],
              let entries = root["layers"] as? [Any], !entries.isEmpty, entries.count <= 500 else {
            throw ProjectFileError(message: "The project canvas or layer stack is invalid.")
        }
        let documentWidth = try positiveInteger(canvas["width"], "canvas.width")
        let documentHeight = try positiveInteger(canvas["height"], "canvas.height")
        var ids = Set<String>()

        var layers: [Layer] = []
        for (index, raw) in entries.enumerated() {
            guard let entry = raw as? [String: Any], let id = entry["id"] as? String, !id.isEmpty,
                  let name = entry["name"] as? String else {
                throw ProjectFileError(message: "Project layer \(index + 1) is invalid.")
            }
            guard ids.insert(id).inserted else {
                throw ProjectFileError(message: "Project layer id “\(id)” is duplicated.")
            }
            let width = try positiveInteger(entry["width"], "layers[\(index)].width")
            let height = try positiveInteger(entry["height"], "layers[\(index)].height")
            let opacity = try finiteNumber(entry["opacity"], "layers[\(index)].opacity")
            guard (0...1).contains(opacity), let visible = boolean(entry["visible"]), let locked = boolean(entry["locked"]) else {
                throw ProjectFileError(message: "Project layer \(index + 1) has invalid properties.")
            }
            let bitmap = try decodeBitmap(entry["bitmap"], width: width, height: height)
            layers.append(Layer(
                id: id,
                name: name,
                bitmap: bitmap,
                x: try finiteNumber(entry["x"], "layers[\(index)].x"),
                y: try finiteNumber(entry["y"], "layers[\(index)].y"),
                visible: visible,
                opacity: opacity,
                locked: locked,
                stretch: try entry["stretch"].map(stretch)
            ))
        }

        for layer in layers {
            if let stretch = layer.stretch, !ids.contains(stretch.sourceLayerId) {
                throw ProjectFileError(message: "Stretch layer “\(layer.name)” refers to a missing source layer.")
            }
        }
        let selected = (root["selectedLayerId"] as? String).flatMap { ids.contains($0) ? $0 : nil } ?? layers.last?.id
        return LoadedProject(
            document: LayerDocument(width: documentWidth, height: documentHeight, layers: layers),
            selectedLayerId: selected
        )
    }

    private static func isBoolean(_ number: NSNumber) -> Bool {
        CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    private static func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, isBoolean(number) else { return nil }
        return number.boolValue
    }

    private static func describe(_ value: Any?) -> String {
        guard let value, !(value is NSNull) else { return value == nil ? "undefined" : "null" }
        return "\(value)"
    }

    private static func finiteNumber(_ value: Any?, _ label: String) throws -> Double {
        guard let number = value as? NSNumber, !isBoolean(number), number.doubleValue.isFinite else {
            throw ProjectFileError(message: "Project field “\(label)” must be a finite number.")
        }
        return number.doubleValue
    }

    private static func positiveInteger(_ value: Any?, _ label: String) throws -> Int {
        let number = try finiteNumber(value, label)
        guard number.rounded() == number, number >= 1, number <= 32_768 else {
            throw ProjectFileError(message: "Project field “\(label)” is outside the supported range.")
        }
        return Int(number)
    }

    private static func point(_ value: Any?, _ label: String) throws -> Point {
        guard let record = value as? [String: Any] else {
            throw ProjectFileError(message: "Project field “\(label)” is invalid.")
        }
        return Point(x: try finiteNumber(record["x"], "\(label).x"), y: try finiteNumber(record["y"], "\(label).y"))
    }

    private static func offset(_ value: Any?, _ label: String, invalid: String) throws -> WarpOffset {
        guard let record = value as? [String: Any] else { throw ProjectFileError(message: invalid) }
        return WarpOffset(u: try finiteNumber(record["u"], "\(label).u"), v: try finiteNumber(record["v"], "\(label).v"))
    }

    private static func warp(_ value: Any?) throws -> [WarpOffset]? {
        guard let value else { return nil }
        guard let entries = value as? [Any], entries.count == 4 else {
            throw ProjectFileError(message: "Project field “stretch.warp” is invalid.")
        }
        return try entries.enumerated().map { index, entry in
            try offset(entry, "stretch.warp[\(index)]", invalid: "Project field “stretch.warp[\(index)]” is invalid.")
        }
    }

    private static func edges(_ value: Any?) throws -> [[WarpOffset]]? {
        guard let value else { return nil }
        guard let edges = value as? [Any], edges.count == 4 else {
            throw ProjectFileError(message: "Project stretch edges are invalid.")
        }
        return try edges.enumerated().map { edgeIndex, edge in
            guard let controls = edge as? [Any], controls.count == 2 else {
                throw ProjectFileError(message: "Project stretch edge \(edgeIndex) is invalid.")
            }
            return try controls.enumerated().map { controlIndex, control in
                try offset(control, "edges[\(edgeIndex)][\(controlIndex)]", invalid: "Project stretch edge control is invalid.")
            }
        }
    }

    private static func stretch(_ value: Any) throws -> StretchSpec {
        guard let record = value as? [String: Any], let rawPoints = record["points"] as? [Any], rawPoints.count >= 2 else {
            throw ProjectFileError(message: "A project stretch object is invalid.")
        }
        guard let sourceLayerId = record["sourceLayerId"] as? String, !sourceLayerId.isEmpty else {
            throw ProjectFileError(message: "A project stretch object has no source layer.")
        }
        var warpMode: WarpMode?
        if let rawMode = record["warpMode"] {
            guard let mode = (rawMode as? String).flatMap(WarpMode.init(rawValue:)) else {
                throw ProjectFileError(message: "A project stretch object has an unsupported warp mode.")
            }
            warpMode = mode
        }
        var curlCorner: Int?
        if let rawCorner = record["curlCorner"] {
            let value = try finiteNumber(rawCorner, "stretch.curlCorner")
            guard value.rounded() == value, value >= 0, value <= 3 else {
                throw ProjectFileError(message: "A project stretch object has an invalid curl corner.")
            }
            curlCorner = Int(value)
        }
        return StretchSpec(
            points: try rawPoints.enumerated().map { try point($1, "points[\($0)]") },
            sourceLayerId: sourceLayerId,
            anchor: try point(record["anchor"], "anchor"),
            width: try finiteNumber(record["width"], "stretch.width"),
            length: try finiteNumber(record["length"], "stretch.length"),
            rotation: try finiteNumber(record["rotation"], "stretch.rotation"),
            fade: try finiteNumber(record["fade"], "stretch.fade"),
            edgeSoftness: try finiteNumber(record["edgeSoftness"], "stretch.edgeSoftness"),
            warp: try warp(record["warp"]),
            bend: try finiteNumber(record["bend"], "stretch.bend"),
            warpMode: warpMode,
            edges: try edges(record["edges"]),
            curlCorner: curlCorner
        )
    }

    private static func decodeBitmap(_ value: Any?, width: Int, height: Int) throws -> Bitmap {
        guard let record = value as? [String: Any], record["mimeType"] as? String == "image/png",
              let base64 = record["data"] as? String else {
            throw ProjectFileError(message: "A project layer has an unsupported bitmap.")
        }
        guard let bytes = Data(base64Encoded: base64) else {
            throw ProjectFileError(message: "A project layer contains invalid image data.")
        }
        // Drawn into the declared size, whatever size the PNG itself turns out to be.
        guard let decoded = BitmapContext.decodeImage(bytes),
              let image = BitmapContext.normalized(decoded, width: width, height: height) else {
            throw ProjectFileError(message: "A project layer image could not be decoded.")
        }
        return Bitmap(image: image)
    }
}

/// Hands encoded project bytes to `fileExporter`.
struct ProjectDocument: FileDocument {
    static let readableContentTypes: [UTType] = [.pixelStretchProject]

    let data: Data

    init(data: Data) {
        self.data = data
    }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents else {
            throw ProjectFileError(message: "This is not a valid PixelStretch project.")
        }
        self.data = data
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}
