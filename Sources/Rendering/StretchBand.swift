import CoreGraphics
import Foundation

struct BandRender {
    /// Band pixels, sized to the rectangle's axis-aligned bounding box.
    let image: CGImage
    /// Where that bounding box sits in the document.
    let x: Double
    let y: Double
}

/// Bands smaller than this in either axis aren't worth rendering.
private let minSize = 1

/// Absorbed when snapping the bounding box to whole pixels. A rotated basis is
/// built from sin/cos, so an axis that should be exactly 40 long comes out at
/// 40.0000000000000006 — enough for `ceil` to add a stray transparent row.
private let pixelEpsilon = 1e-6

/// Boundary samples used to bound a warped or bent band.
private let outlineSteps = 64

/// Grid resolution for the curved-surface renderer, in cells per axis.
private let patchCols = 72
private let patchRows = 24

/// How a band's geometry is evaluated: a flat rectangle, a perspective quad, or
/// a free-form curved patch.
private typealias SurfaceMap = (Double, Double) -> Point

/// Read `columns` pixels along the sample path into a 1px-tall strip — the row
/// of colours the band repeats. The path's whole arc always maps across the
/// whole strip, so widening the rectangle stretches the same pixels rather than
/// reaching for new ones. Sampling is bilinear so a curve doesn't stairstep.
private func samplePathStrip(source: Layer, points: [Point], columns: Int) -> CGImage? {
    let pixels = source.bitmap.rgba
    let along = samplePath(points, count: columns)
    let width = source.width
    let height = source.height
    var out = [UInt8](repeating: 0, count: columns * 4)

    for i in 0..<columns {
        // Into the source layer's own pixel space.
        let sx = along[i].x - source.x
        let sy = along[i].y - source.y
        // Far outside the layer every neighbour is empty; skip before `Int()`
        // could overflow.
        guard sx > -2, sy > -2, sx < Double(width) + 1, sy < Double(height) + 1 else { continue }

        let x0 = Int(floor(sx))
        let y0 = Int(floor(sy))
        let fx = sx - floor(sx)
        let fy = sy - floor(sy)

        for c in 0..<4 {
            var acc = 0.0
            // Bilinear across the four neighbours, treating out-of-bounds as empty.
            for dy in 0...1 {
                for dx in 0...1 {
                    let px = x0 + dx
                    let py = y0 + dy
                    if px < 0 || py < 0 || px >= width || py >= height { continue }
                    let w = (dx == 1 ? fx : 1 - fx) * (dy == 1 ? fy : 1 - fy)
                    acc += Double(pixels[(py * width + px) * 4 + c]) * w
                }
            }
            // Uint8ClampedArray rounds half to even.
            out[i * 4 + c] = UInt8(clamping: Int(acc.rounded(.toNearestOrEven)))
        }
    }

    return BitmapContext.image(straightRGBA: out, width: columns, height: 1)
}

private func alphaGradient(_ stops: [(location: Double, alpha: Double)]) -> CGGradient? {
    CGGradient(
        colorSpace: BitmapContext.colorSpace,
        colorComponents: stops.flatMap { [0, 0, 0, CGFloat($0.alpha)] },
        locations: stops.map { CGFloat($0.location) },
        count: stops.count
    )
}

/// Fade along the extrusion, and soften all four edges. Both are alpha-only, so
/// they're applied as gradients through `destinationIn`, which multiplies.
private func shapeAlpha(_ ctx: CGContext, spec: StretchSpec) {
    let width = CGFloat(ctx.width)
    let height = CGFloat(ctx.height)
    let soft = clamp(spec.edgeSoftness, 0, 0.49)
    let fill: CGGradientDrawingOptions = [.drawsBeforeStartLocation, .drawsAfterEndLocation]
    ctx.setBlendMode(.destinationIn)

    // Along the extrusion: the fade ramp, plus a soft stop at the far end.
    // Local +y always runs away from the path, whichever side the band is on,
    // so this ramp needs no special case for a flipped band.
    let farAlpha = clamp(1 - spec.fade, 0, 1)
    var ramp: [(location: Double, alpha: Double)] = [(0, 1)]
    if soft > 0 {
        ramp.append((clamp(1 - soft, 0, 1), farAlpha))
    }
    ramp.append((1, soft > 0 ? 0 : farAlpha))
    if let gradient = alphaGradient(ramp) {
        ctx.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: height), options: fill)
    }

    // Across the band: soften both ends of the sampled row.
    if soft > 0, let gradient = alphaGradient([(0, 0), (soft, 1), (1 - soft, 1), (1, 0)]) {
        ctx.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: width, y: 0), options: fill)
    }

    ctx.setBlendMode(.normal)
}

private func surfaceMap(_ spec: StretchSpec, corners: [Point]) -> SurfaceMap {
    if spec.hasCurvedEdges {
        let patch = spec.edgeCurves
        return { u, v in coonsPoint(patch, u, v) }
    }
    let m = quadHomography(corners)
    return { u, v in project(m, u, v) }
}

/// Trace the band's projected outline. A bend pushes columns past the quad's
/// own corners, so the bounding box has to come from the real edges rather
/// than from four points.
private func projectedOutline(_ spec: StretchSpec, at: SurfaceMap) -> [Point] {
    var outline: [Point] = []
    for i in 0...outlineSteps {
        // Curved edges bow sideways too, so sample the interior, not just the rims.
        for j in 0...4 {
            let point = bendPoint(Double(i) / Double(outlineSteps), Double(j) / 4, bend: spec.bend)
            outline.append(at(point.x, point.y))
        }
    }
    return outline
}

private func allFinite(_ values: Double...) -> Bool {
    values.allSatisfy(\.isFinite)
}

private struct CurlMeshVertex {
    let point: Point
    let z: Double
    let u: Double
    let v: Double
}

/// The fine render mesh is independent of the 3 × 3 editing grid.
private func pageCurlMesh(_ spec: StretchSpec) -> [[CurlMeshVertex]] {
    let surface = PageCurlSurface(spec)
    let steps = 72
    var vertices: [[CurlMeshVertex]] = []
    for j in 0...steps {
        var row: [CurlMeshVertex] = []
        for i in 0...steps {
            let u = Double(i) / Double(steps)
            let v = Double(j) / Double(steps)
            let vertex = surface.at(u, v)
            row.append(CurlMeshVertex(point: vertex.point, z: vertex.z, u: u, v: v))
        }
        vertices.append(row)
    }
    var triangles: [[CurlMeshVertex]] = []
    for j in 0..<steps {
        for i in 0..<steps {
            let a = vertices[j][i]
            let b = vertices[j][i + 1]
            let c = vertices[j + 1][i]
            let d = vertices[j + 1][i + 1]
            triangles.append([a, b, c])
            triangles.append([b, d, c])
        }
    }
    // Render the turned page above the untouched section for every corner.
    return triangles.sorted { a, b in
        a.reduce(0) { $0 + $1.z } < b.reduce(0) { $0 + $1.z }
    }
}

private func drawPageCurl(
    _ ctx: CGContext,
    local: CGImage,
    triangles: [[CurlMeshVertex]],
    offsetX: Double,
    offsetY: Double
) {
    let width = Double(local.width)
    let height = Double(local.height)
    for triangle in triangles {
        let a = triangle[0].point
        let b = triangle[1].point
        let c = triangle[2].point
        let p = triangle.map { Point(x: $0.u * width, y: $0.v * height) }
        let ux = p[1].x - p[0].x
        let uy = p[1].y - p[0].y
        let vx = p[2].x - p[0].x
        let vy = p[2].y - p[0].y
        let determinant = ux * vy - uy * vx
        let ax = ((b.x - a.x) * vy - (c.x - a.x) * uy) / determinant
        let ay = ((b.y - a.y) * vy - (c.y - a.y) * uy) / determinant
        let bx = ((c.x - a.x) * ux - (b.x - a.x) * vx) / determinant
        let by = ((c.y - a.y) * ux - (b.y - a.y) * vx) / determinant
        guard allFinite(ax, ay, bx, by), abs(ax * by - ay * bx) >= 1e-8 else { continue }

        ctx.saveGState()
        let center = Point(x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3)
        ctx.beginPath()
        for (index, vertex) in triangle.enumerated() {
            let dx = vertex.point.x - center.x
            let dy = vertex.point.y - center.y
            let expand = 1 + 0.45 / max(1, hypot(dx, dy))
            let position = CGPoint(x: center.x + dx * expand + offsetX, y: center.y + dy * expand + offsetY)
            if index == 0 { ctx.move(to: position) } else { ctx.addLine(to: position) }
        }
        ctx.closePath()
        ctx.clip()
        ctx.concatenate(CGAffineTransform(
            a: ax, b: ay, c: bx, d: by,
            tx: a.x - ax * p[0].x - bx * p[0].y + offsetX,
            ty: a.y - ay * p[0].x - by * p[0].y + offsetY
        ))
        let sx = max(0, p.map(\.x).min()! - 1)
        let sy = max(0, p.map(\.y).min()! - 1)
        let sw = min(width, p.map(\.x).max()! + 1) - sx
        let sh = min(height, p.map(\.y).max()! + 1) - sy
        let crop = CGRect(x: sx, y: sy, width: sw, height: sh).integral
        if let piece = local.cropping(to: crop) {
            ctx.drawUpright(piece, in: crop)
        }
        ctx.restoreGState()
    }
}

/// Draw the band across a curved surface.
///
/// A Coons patch bends columns as well as displacing them, so unlike the
/// projective case a column is no longer a straight segment and one affine per
/// column won't do. The band is diced into a grid instead, each cell mapped by
/// the affine through three of its corners — which converges quickly because
/// the surface is smooth. Cells are drawn a touch oversized so their neighbours
/// cover the seams.
private func drawPatch(_ ctx: CGContext, local: CGImage, spec: StretchSpec, at: SurfaceMap, offsetX: Double, offsetY: Double) {
    let width = local.width
    let height = local.height
    let cols = max(1, min(patchCols, width))
    let rows = max(1, min(patchRows, height))
    let cellW = Double(width) / Double(cols)
    let cellH = Double(height) / Double(rows)

    for i in 0..<cols {
        for j in 0..<rows {
            let uv0 = bendPoint(Double(i) / Double(cols), Double(j) / Double(rows), bend: spec.bend)
            let uv1 = bendPoint(Double(i + 1) / Double(cols), Double(j) / Double(rows), bend: spec.bend)
            let uv2 = bendPoint(Double(i) / Double(cols), Double(j + 1) / Double(rows), bend: spec.bend)
            let topLeft = at(uv0.x, uv0.y)
            let topRight = at(uv1.x, uv1.y)
            let bottomLeft = at(uv2.x, uv2.y)

            let ax = (topRight.x - topLeft.x) / cellW
            let ay = (topRight.y - topLeft.y) / cellW
            let cx = (bottomLeft.x - topLeft.x) / cellH
            let cy = (bottomLeft.y - topLeft.y) / cellH
            guard allFinite(ax, ay, cx, cy) else { continue }

            let sx = Double(i) * cellW
            let sy = Double(j) * cellH
            // Overdraw by a pixel of source on each far side to hide the seams.
            let w = min(cellW + 1, Double(width) - sx)
            let h = min(cellH + 1, Double(height) - sy)

            ctx.saveGState()
            ctx.concatenate(CGAffineTransform(
                a: ax, b: ay, c: cx, d: cy,
                tx: topLeft.x - ax * sx - cx * sy + offsetX,
                ty: topLeft.y - ay * sx - cy * sy + offsetY
            ))
            // Canvas takes a fractional source rect; Core Graphics crops to whole
            // pixels, so crop outward and clip back to the exact cell.
            let cell = CGRect(x: sx, y: sy, width: w, height: h)
            let crop = cell.integral
            if let piece = local.cropping(to: crop) {
                ctx.clip(to: cell)
                ctx.drawUpright(piece, in: crop)
            }
            ctx.restoreGState()
        }
    }
}

/// Draw the band through a projective map, one column at a time.
///
/// A homography takes straight lines to straight lines, so each column of the
/// upright band lands as a straight segment — which is why the streaks stay
/// straight however the quad is pulled about. Each column gets its own affine
/// approximation, exact for that column's own geometry, and is drawn one pixel
/// wider than its slot so the next column covers the seam.
private func drawProjected(_ ctx: CGContext, local: CGImage, spec: StretchSpec, at: SurfaceMap, offsetX: Double, offsetY: Double) {
    let width = local.width
    let height = local.height

    for i in 0..<width {
        let nearTop = bendPoint(Double(i) / Double(width), 0, bend: spec.bend)
        let farTop = bendPoint(Double(i + 1) / Double(width), 0, bend: spec.bend)
        let nearBottom = bendPoint(Double(i) / Double(width), 1, bend: spec.bend)

        let topLeft = at(nearTop.x, nearTop.y)
        let topRight = at(farTop.x, farTop.y)
        let bottomLeft = at(nearBottom.x, nearBottom.y)

        var ax = topRight.x - topLeft.x
        var ay = topRight.y - topLeft.y
        let span = hypot(ax, ay)
        guard span.isFinite, span != 0 else { continue }
        // Overdraw by a pixel; the next column paints over the excess.
        let widen = (span + 1) / span
        ax *= widen
        ay *= widen

        let cx = (bottomLeft.x - topLeft.x) / Double(height)
        let cy = (bottomLeft.y - topLeft.y) / Double(height)
        guard allFinite(ax, ay, cx, cy) else { continue }

        let slot = CGRect(x: i, y: 0, width: 1, height: height)
        guard let column = local.cropping(to: slot) else { continue }
        ctx.saveGState()
        ctx.concatenate(CGAffineTransform(
            a: ax, b: ay, c: cx, d: cy,
            tx: topLeft.x - ax * Double(i) + offsetX,
            ty: topLeft.y - ay * Double(i) + offsetY
        ))
        ctx.drawUpright(column, in: slot)
        ctx.restoreGState()
    }
}

/// The last upright band built. Moving, rotating, distorting or bending a band
/// leaves its upright pixels alone, so a drag doing any of those re-renders
/// without re-sampling the source.
private struct UprightKey: Equatable {
    let source: ObjectIdentifier
    let sourceX: Double
    let sourceY: Double
    let points: [Point]
    let width: Int
    let height: Int
    let fade: Double
    let edgeSoftness: Double
}

private let uprightLock = NSLock()
nonisolated(unsafe) private var uprightCache: (key: UprightKey, image: CGImage, bitmap: Bitmap)?

/// The band built upright in local space: the sampled row across the top,
/// extruded straight down, with the fade and soft edges applied.
private func uprightBand(_ spec: StretchSpec, source: Layer, width: Int, height: Int) -> CGImage? {
    let key = UprightKey(
        source: ObjectIdentifier(source.bitmap), sourceX: source.x, sourceY: source.y,
        points: spec.points, width: width, height: height, fade: spec.fade, edgeSoftness: spec.edgeSoftness
    )
    uprightLock.lock()
    // The cached bitmap is held alongside its id, so the id can't be reused.
    if let cached = uprightCache, cached.key == key, cached.bitmap === source.bitmap {
        uprightLock.unlock()
        return cached.image
    }
    uprightLock.unlock()

    guard let lctx = BitmapContext.make(width: Double(width), height: Double(height)),
          let strip = samplePathStrip(source: source, points: spec.points, columns: width) else { return nil }
    // Every output row is the same row of colours; no resampling wanted.
    lctx.interpolationQuality = .none
    lctx.drawUpright(strip, in: CGRect(x: 0, y: 0, width: width, height: height))
    shapeAlpha(lctx, spec: spec)
    guard let image = lctx.makeImage() else { return nil }

    uprightLock.lock()
    uprightCache = (key, image, source.bitmap)
    uprightLock.unlock()
    return image
}

/// Render a stretch band to its own bitmap.
///
/// The band is built upright in local space — the sampled row across the top,
/// extruded straight down — then blitted into the output with a single affine
/// transform built from the path's chord. Because every column is a constant
/// colour, the extrusion is one draw that scales a 1px-tall strip to full
/// height rather than any per-pixel work.
///
/// Returns nil when the rectangle is degenerate.
func renderStretchBand(_ spec: StretchSpec, source: Layer) -> BandRender? {
    let width = jsRound(abs(spec.width))
    let height = jsRound(abs(spec.length))
    guard spec.points.count >= 2, width >= minSize, height >= minSize else { return nil }

    let (along, out) = spec.rectBasis
    let flipped = spec.length < 0
    // Local +y always points the way the band actually extrudes.
    let outSigned = Point(x: out.x * (flipped ? -1 : 1), y: out.y * (flipped ? -1 : 1))

    guard let local = uprightBand(spec, source: source, width: width, height: height) else { return nil }

    // Local (0,0) is the anchor on the path for either sign of `length` — the
    // side is carried entirely by `outSigned`, so the origin never moves.
    let origin = spec.anchor
    let curved = spec.hasCurvedEdges
    let projected = curved || spec.isWarped || spec.bend != 0

    // The corner order already matches local (0,0)→(w,0)→(w,h)→(0,h): local
    // (0,height) lands on corner 3 for either sign of `length`, because
    // `outSigned` and `|length|` flip together.
    let quad = spec.warpedCorners
    let at = surfaceMap(spec, corners: quad)
    let curlMesh = spec.curlCorner != nil ? pageCurlMesh(spec) : nil

    let bounds = curlMesh?.flatMap { $0.map(\.point) } ?? (projected ? projectedOutline(spec, at: at) : quad)
    let xs = bounds.map(\.x)
    let ys = bounds.map(\.y)
    guard let lowX = xs.min(), let highX = xs.max(), let lowY = ys.min(), let highY = ys.max(),
          allFinite(lowX, highX, lowY, highY) else { return nil }
    let minX = floor(lowX + pixelEpsilon)
    let minY = floor(lowY + pixelEpsilon)
    let maxX = ceil(highX - pixelEpsilon)
    let maxY = ceil(highY - pixelEpsilon)
    guard maxX - minX >= Double(minSize), maxY - minY >= Double(minSize) else { return nil }

    if projected && !curved && curlMesh == nil {
        // Homography in output pixels: small numbers keep the GPU's floats exact.
        let shifted = quad.map { Point(x: $0.x - minX, y: $0.y - minY) }
        if let image = ProjectedBandKernel.render(
            local: local, homography: quadHomography(shifted), bend: spec.bend,
            width: Int(maxX - minX), height: Int(maxY - minY)
        ) {
            return BandRender(image: image, x: minX, y: minY)
        }
    }

    guard let octx = BitmapContext.make(width: maxX - minX, height: maxY - minY) else { return nil }
    octx.interpolationQuality = .high

    if let curlMesh {
        drawPageCurl(octx, local: local, triangles: curlMesh, offsetX: -minX, offsetY: -minY)
    } else if curved {
        drawPatch(octx, local: local, spec: spec, at: at, offsetX: -minX, offsetY: -minY)
    } else if projected {
        drawProjected(octx, local: local, spec: spec, at: at, offsetX: -minX, offsetY: -minY)
    } else {
        // Undistorted: one blit, columns of the matrix are the local axes.
        octx.saveGState()
        octx.concatenate(CGAffineTransform(
            a: along.x, b: along.y, c: outSigned.x, d: outSigned.y,
            tx: origin.x - minX, ty: origin.y - minY
        ))
        octx.drawUpright(local, in: CGRect(x: 0, y: 0, width: width, height: height))
        octx.restoreGState()
    }

    guard let image = octx.makeImage() else { return nil }
    return BandRender(image: image, x: minX, y: minY)
}
