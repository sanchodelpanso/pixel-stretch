import CoreGraphics
import Foundation

/// A layer document is a stack of independently-positioned RGBA bitmaps
/// rendered onto a fixed-size canvas. Layer pixels are stored trimmed to
/// their own bounds, so a band costs only its bounding box.
struct Layer: Identifiable, Sendable {
    let id: String
    var name: String
    /// Layer pixels; the layer is exactly as large as its bitmap.
    var bitmap: Bitmap
    /// Top-left position in document pixels.
    var x: Double
    var y: Double
    var visible = true
    /// 0–1.
    var opacity = 1.0
    /// Locked layers can't be moved, edited or selected on canvas.
    var locked = false
    /// Present on generative stretch layers. The pixels are derived from this,
    /// so editing it re-renders the layer rather than replacing it by hand.
    var stretch: StretchSpec?

    var width: Int { bitmap.width }
    var height: Int { bitmap.height }
}

struct LayerDocument: Sendable {
    var width: Int
    var height: Int
    /// Bottom-first: index 0 renders first, the last entry renders on top.
    var layers: [Layer]

    static let empty = LayerDocument(width: 0, height: 0, layers: [])
}

/// Hands out `layer-N` ids, skipping past any a loaded project already uses so
/// a new layer can never collide with one read from disk.
@MainActor
enum LayerID {
    private static var counter = 0

    static func next() -> String {
        counter += 1
        return "layer-\(counter)"
    }

    static func reserve(_ ids: some Sequence<String>) {
        for id in ids {
            guard id.hasPrefix("layer-"), let n = Int(id.dropFirst("layer-".count)) else { continue }
            counter = max(counter, n)
        }
    }
}

/// Alpha below this counts as empty when hit-testing.
private let alphaEpsilon = 0.004

@MainActor
enum LayerOps {
    /// Build the initial background layer from a decoded image.
    static func layer(from image: CGImage, name: String = "Background") -> Layer {
        Layer(id: LayerID.next(), name: name, bitmap: Bitmap(image: image), x: 0, y: 0)
    }

    /// Duplicate a layer. Bitmaps are immutable, so the pixels are shared.
    static func duplicate(_ layer: Layer) -> Layer {
        Layer(
            id: LayerID.next(), name: "\(layer.name) copy", bitmap: layer.bitmap, x: layer.x, y: layer.y,
            visible: layer.visible, opacity: layer.opacity, locked: layer.locked, stretch: layer.stretch
        )
    }

    /// Topmost visible, unlocked layer whose pixel at the given document point is
    /// not transparent. Returns nil when the point hits nothing.
    static func hitTest(_ layers: [Layer], at point: Point) -> Layer? {
        for layer in layers.reversed() where layer.visible && !layer.locked {
            let lx = floor(point.x - layer.x)
            let ly = floor(point.y - layer.y)
            guard lx >= 0, ly >= 0, lx < Double(layer.width), ly < Double(layer.height) else { continue }
            if Double(layer.bitmap.alpha(x: Int(lx), y: Int(ly))) > alphaEpsilon * 255 {
                return layer
            }
        }
        return nil
    }

    /// Move a layer, keeping a stretch layer's geometry in step with it — the band
    /// is defined by document-space points, so a translated band has to carry them
    /// along or the next re-render would snap it back.
    static func translate(_ layer: Layer, dx: Double, dy: Double) -> Layer {
        var moved = layer
        moved.x = jsRounded(layer.x + dx)
        moved.y = jsRounded(layer.y + dy)
        if var stretch = layer.stretch {
            stretch.points = stretch.points.map { Point(x: $0.x + dx, y: $0.y + dy) }
            stretch.anchor = Point(x: stretch.anchor.x + dx, y: stretch.anchor.y + dy)
            moved.stretch = stretch
        }
        return moved
    }

    /// Build a brand-new generative stretch layer, or nil if the band is degenerate.
    static func stretchLayer(_ spec: StretchSpec, source: Layer, name: String) -> Layer? {
        guard let band = renderStretchBand(spec, source: source) else { return nil }
        return Layer(id: LayerID.next(), name: name, bitmap: Bitmap(image: band.image), x: band.x, y: band.y, stretch: spec)
    }

    /// Re-render an existing stretch layer against a new spec, preserving its
    /// identity, name, opacity and everything else the user set on it.
    static func rerender(_ layer: Layer, spec: StretchSpec, source: Layer) -> Layer {
        var updated = layer
        updated.stretch = spec
        // A degenerate spec keeps the old pixels rather than blanking the layer.
        guard let band = renderStretchBand(spec, source: source) else { return updated }
        updated.bitmap = Bitmap(image: band.image)
        updated.x = band.x
        updated.y = band.y
        return updated
    }
}

/// Draw the layer stack, bottom layer first, into a top-left-origin context
/// already scaled to document coordinates.
func compositeDocument(_ ctx: CGContext, _ doc: LayerDocument) {
    for layer in doc.layers where layer.visible && layer.opacity > 0 {
        ctx.saveGState()
        ctx.setAlpha(CGFloat(layer.opacity))
        ctx.drawUpright(layer.bitmap.image, in: CGRect(x: layer.x, y: layer.y, width: Double(layer.width), height: Double(layer.height)))
        ctx.restoreGState()
    }
}

/// Flatten the document to a single image at full document resolution. Areas no
/// layer covers stay transparent.
func flattenDocument(_ doc: LayerDocument) -> CGImage? {
    guard let ctx = BitmapContext.make(width: Double(doc.width), height: Double(doc.height)) else { return nil }
    ctx.interpolationQuality = .high
    compositeDocument(ctx, doc)
    return ctx.makeImage()
}
