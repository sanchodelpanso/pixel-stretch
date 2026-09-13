import Accelerate
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// Layer pixels. Immutable — anything that changes pixels builds a new bitmap
/// — so undo snapshots can share one freely, and the caches below never go
/// stale (the same trick as keying the web app's caches on the canvas).
final class Bitmap: @unchecked Sendable {
    let image: CGImage
    var width: Int { image.width }
    var height: Int { image.height }

    private let lock = NSLock()
    private var cachedRGBA: [UInt8]?
    private var cachedThumbnail: CGImage?

    init(image: CGImage) {
        self.image = image
    }

    /// Straight-alpha RGBA, row-major, top row first — what canvas
    /// `getImageData` returns. Reading a full-resolution layer is the
    /// expensive part of a stretch render, so it happens once per bitmap.
    var rgba: [UInt8] {
        lock.lock()
        defer { lock.unlock() }
        if let cachedRGBA { return cachedRGBA }
        let pixels = BitmapContext.straightRGBA(of: image)
        cachedRGBA = pixels
        return pixels
    }

    /// A small preview for the layers panel, drawn on transparency so cut-outs
    /// read as cut-outs.
    var thumbnail: CGImage {
        lock.lock()
        defer { lock.unlock() }
        if let cachedThumbnail { return cachedThumbnail }
        let maxSize = 96.0
        let scale = min(maxSize / Double(width), maxSize / Double(height), 1)
        let size = CGSize(width: Double(width) * scale, height: Double(height) * scale)
        let thumb = BitmapContext.make(width: size.width, height: size.height).flatMap { ctx -> CGImage? in
            ctx.interpolationQuality = .high
            ctx.drawUpright(image, in: CGRect(x: 0, y: 0, width: ctx.width, height: ctx.height))
            return ctx.makeImage()
        } ?? image
        cachedThumbnail = thumb
        return thumb
    }

    /// Alpha (0–255) of one pixel, without reading the whole bitmap back.
    func alpha(x: Int, y: Int) -> UInt8 {
        guard x >= 0, y >= 0, x < width, y < height,
              let ctx = CGContext(
                data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 1,
                space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.alphaOnly.rawValue
              ) else { return 0 }
        // Shift the image so pixel (x, y) — counted from the top — covers the
        // single output pixel; bitmap space has its origin at the bottom-left.
        ctx.interpolationQuality = .none
        ctx.draw(image, in: CGRect(x: -x, y: y - height + 1, width: width, height: height))
        return ctx.data?.assumingMemoryBound(to: UInt8.self).pointee ?? 0
    }
}

/// Canvas-style drawing surfaces: 8-bit sRGB, premultiplied, and with user
/// space flipped so the origin is the top-left and y runs down, which lets the
/// web app's geometry and transforms carry over unchanged.
enum BitmapContext {
    static let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

    /// A transparent surface of at least 1×1, sized like `createCanvas`.
    static func make(width: Double, height: Double) -> CGContext? {
        let w = max(1, jsRound(width))
        let h = max(1, jsRound(height))
        guard let ctx = CGContext(
            data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
            space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        ctx.translateBy(x: 0, y: CGFloat(h))
        ctx.scaleBy(x: 1, y: -1)
        return ctx
    }

    /// Redraw any image into the editor's pixel format, optionally resized.
    static func normalized(_ image: CGImage, width: Int? = nil, height: Int? = nil) -> CGImage? {
        let w = width ?? image.width
        let h = height ?? image.height
        guard let ctx = make(width: Double(w), height: Double(h)) else { return nil }
        ctx.interpolationQuality = .high
        ctx.drawUpright(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage()
    }

    /// Straight-alpha RGBA bytes, top row first.
    static func straightRGBA(of image: CGImage) -> [UInt8] {
        let w = image.width
        let h = image.height
        var pixels = [UInt8](repeating: 0, count: w * h * 4)
        pixels.withUnsafeMutableBytes { raw in
            guard let ctx = CGContext(
                data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return }
            // Unflipped: an image drawn normally lands top row first in memory.
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
            var buffer = vImage_Buffer(data: raw.baseAddress, height: vImagePixelCount(h), width: vImagePixelCount(w), rowBytes: w * 4)
            vImageUnpremultiplyData_RGBA8888(&buffer, &buffer, vImage_Flags(kvImageNoFlags))
        }
        return pixels
    }

    /// An image from straight-alpha RGBA bytes, like `putImageData`.
    static func image(straightRGBA pixels: [UInt8], width: Int, height: Int) -> CGImage? {
        guard let provider = CGDataProvider(data: Data(pixels) as CFData) else { return nil }
        return CGImage(
            width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
            space: colorSpace, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent
        )
    }

    static func pngData(_ image: CGImage) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
            return nil
        }
        CGImageDestinationAddImage(destination, image, nil)
        return CGImageDestinationFinalize(destination) ? data as Data : nil
    }

    static func decodeImage(_ data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }
}

extension CGContext {
    /// Draw an image into a rect of the flipped, top-left user space without
    /// turning it upside down — the equivalent of canvas `drawImage`.
    func drawUpright(_ image: CGImage, in rect: CGRect) {
        saveGState()
        translateBy(x: rect.minX, y: rect.maxY)
        scaleBy(x: 1, y: -1)
        draw(image, in: CGRect(origin: .zero, size: rect.size))
        restoreGState()
    }
}

/// `Math.round`: halves go toward +∞, unlike Swift's schoolbook rounding.
func jsRounded(_ value: Double) -> Double {
    (value + 0.5).rounded(.down)
}

/// `Math.round` for pixel sizes, saturating instead of trapping on overflow.
func jsRound(_ value: Double) -> Int {
    guard value.isFinite else { return 0 }
    return Int(clamp(jsRounded(value), -1e15, 1e15))
}

func clamp<T: Comparable>(_ value: T, _ lower: T, _ upper: T) -> T {
    min(max(value, lower), upper)
}
