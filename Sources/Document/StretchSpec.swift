import Foundation

/// A document-space point. Not `CGPoint`: that encodes as an array, and the
/// project file shared with the web app stores `{x, y}` objects.
struct Point: Codable, Equatable, Sendable {
    var x: Double
    var y: Double
}

/// A corner nudge, in the rectangle's own frame: `u` along, `v` outward.
struct WarpOffset: Codable, Equatable, Sendable {
    var u: Double
    var v: Double

    static let zero = WarpOffset(u: 0, v: 0)
}

/// How dragging a corner or an edge control reshapes the band.
/// `straight` keeps every edge a straight line and renders through a true
/// perspective homography; `curved` makes each edge a cubic Bézier and renders
/// the free-form surface they bound.
enum WarpMode: String, Codable, Sendable {
    case straight
    case curved
}

/// Four corner offsets, in `bandCorners` order.
let noWarp: [WarpOffset] = Array(repeating: .zero, count: 4)

/// The two Bézier controls of each edge, as offsets from its straight thirds,
/// in c0→c1, c1→c2, c2→c3, c3→c0 order.
let noEdgeWarp: [[WarpOffset]] = Array(repeating: [.zero, .zero], count: 4)

/// A stretch band.
///
/// Sampling and output geometry are deliberately independent. `points` is a
/// path the user shapes freely — a straight line by default, a smooth spline
/// once they bend it — but it only chooses *which* pixels are read. Those
/// pixels are always laid out across a straight rectangle, so the streaks stay
/// parallel however curved the path is.
///
/// The rectangle lives in the frame defined by the path's chord (first point →
/// last point): `width` runs along it, `length` extrudes at right angles to it,
/// and `anchor` is the corner where both axes start. A negative `length` puts
/// the band on the other side of the path.
struct StretchSpec: Codable, Equatable, Sendable {
    /// Sample path control points, in document pixels. Two or more.
    var points: [Point]
    /// Layer the band samples its pixels from.
    var sourceLayerId: String
    /// Rectangle corner where both local axes begin, in document pixels.
    var anchor: Point
    /// Rectangle extent along the chord direction, in pixels.
    var width: Double
    /// Signed rectangle extent along the chord's perpendicular, in pixels.
    var length: Double
    /// Rectangle rotation in radians, *relative to the path's chord*. Zero keeps
    /// the band square to the path; reshaping the path then carries the rectangle
    /// with it, which is almost always what's wanted.
    var rotation: Double
    /// 0 = solid to the far end, 1 = fully faded out at the far end.
    var fade: Double
    /// Edge softening, as a fraction of the band's size.
    var edgeSoftness: Double
    /// Per-corner distortion, stored in the rectangle's own frame so that moving,
    /// rotating or resizing the rectangle carries the distortion with it. Absent
    /// (or all zeros) means an undistorted rectangle. Exactly four entries.
    var warp: [WarpOffset]?
    /// Cylindrical wrap about the band's length axis. At ±1 the cylinder radius
    /// equals the rectangle width; positive bows toward the viewer, negative away.
    var bend: Double
    /// Whether edges pull straight or curve. Absent means `straight`.
    var warpMode: WarpMode?
    /// Per-edge Bézier controls, stored like `warp` in the rectangle's own frame
    /// as offsets from the straight-edge thirds. Only meaningful in curved mode.
    /// Four edges of two controls each.
    var edges: [[WarpOffset]]?
    /// Corner driving a rounded page fold; its target is stored in `warp`.
    var curlCorner: Int? = nil

    static let defaultFade = 0.0
    static let defaultEdgeSoftness = 0.0

    /// A fresh band pulled off a locked path, with the default look.
    static func initial(points: [Point], sourceLayerId: String, length: Double) -> StretchSpec {
        StretchSpec(
            points: points,
            sourceLayerId: sourceLayerId,
            anchor: points[0],
            width: chordLength(points),
            length: length,
            rotation: 0,
            fade: defaultFade,
            edgeSoftness: defaultEdgeSoftness,
            warp: nil,
            bend: 0,
            warpMode: nil,
            edges: nil
        )
    }
}

typealias Basis = (along: Point, out: Point)

/// Straight-line distance from the path's first point to its last.
func chordLength(_ points: [Point]) -> Double {
    guard points.count >= 2, let a = points.first, let b = points.last else { return 0 }
    return hypot(b.x - a.x, b.y - a.y)
}

/// Angle of the path's chord in radians, for display.
func chordAngle(_ points: [Point]) -> Double {
    guard points.count >= 2, let a = points.first, let b = points.last else { return 0 }
    return atan2(b.y - a.y, b.x - a.x)
}

/// Orthonormal basis for the band rectangle.
/// `along` follows the path's chord; `out` is the extrusion direction for a
/// positive length — chosen so a top-to-bottom path extrudes rightward.
func bandBasis(_ points: [Point]) -> Basis {
    let extent = chordLength(points)
    guard extent >= 1e-6, let a = points.first, let b = points.last else {
        return (Point(x: 1, y: 0), Point(x: 0, y: 1))
    }
    let along = Point(x: (b.x - a.x) / extent, y: (b.y - a.y) / extent)
    return (along, Point(x: along.y, y: -along.x))
}

extension StretchSpec {
    /// Basis for the band rectangle itself — the chord's, turned by the spec's own
    /// rotation. Sampling never uses this: walking the path is orientation-free, so
    /// rotating the rectangle moves where the pixels land, not which ones are read.
    var rectBasis: Basis {
        if rotation == 0 { return bandBasis(points) }
        let angle = chordAngle(points) + rotation
        let along = Point(x: cos(angle), y: sin(angle))
        return (along, Point(x: along.y, y: -along.x))
    }

    /// The rectangle's four corners in document space, anchor first, clockwise.
    var bandCorners: [Point] {
        let (along, out) = rectBasis
        let w = Point(x: along.x * width, y: along.y * width)
        let l = Point(x: out.x * length, y: out.y * length)
        return [
            anchor,
            Point(x: anchor.x + w.x, y: anchor.y + w.y),
            Point(x: anchor.x + w.x + l.x, y: anchor.y + w.y + l.y),
            Point(x: anchor.x + l.x, y: anchor.y + l.y),
        ]
    }

    /// Whether any edge has been bowed away from straight.
    var hasCurvedEdges: Bool {
        warpMode == .curved
            && (edges?.contains { $0.contains { $0.u != 0 || $0.v != 0 } } ?? false)
    }

    /// Whether the band is distorted away from a plain rectangle.
    var isWarped: Bool {
        warp?.contains { $0.u != 0 || $0.v != 0 } ?? false
    }

    /// The band's actual quad: the rectangle's corners with each corner's warp
    /// offset applied in the rectangle's own frame.
    var warpedCorners: [Point] {
        let corners = bandCorners
        guard let warp else { return corners }
        let (along, out) = rectBasis
        return corners.enumerated().map { i, c in
            let w = warp[i]
            return Point(x: c.x + along.x * w.u + out.x * w.v, y: c.y + along.y * w.u + out.y * w.v)
        }
    }

    /// The four Bézier edges of the band, in document space. Each control sits at
    /// its straight-edge third plus the stored offset, rotated into the rect frame
    /// so the curve travels with the rectangle.
    var edgeCurves: [CubicEdge] {
        let corners = warpedCorners
        let (along, out) = rectBasis
        let controls = edges ?? noEdgeWarp

        return corners.indices.map { i in
            let from = corners[i]
            let to = corners[(i + 1) % 4]
            func knot(_ fraction: Double, _ offset: WarpOffset) -> Point {
                Point(
                    x: from.x + (to.x - from.x) * fraction + along.x * offset.u + out.x * offset.v,
                    y: from.y + (to.y - from.y) * fraction + along.y * offset.u + out.y * offset.v
                )
            }
            return CubicEdge(p0: from, c0: knot(1.0 / 3, controls[i][0]), c1: knot(2.0 / 3, controls[i][1]), p1: to)
        }
    }

    /// Express a document point as an edge-control offset in the rectangle's frame.
    func toEdgeOffset(edge: Int, control: Int, target: Point) -> WarpOffset {
        let corners = warpedCorners
        let from = corners[edge]
        let to = corners[(edge + 1) % 4]
        let fraction = control == 0 ? 1.0 / 3 : 2.0 / 3
        let base = Point(x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction)
        let (along, out) = rectBasis
        let dx = target.x - base.x
        let dy = target.y - base.y
        return WarpOffset(u: dx * along.x + dy * along.y, v: dx * out.x + dy * out.y)
    }

    /// Build a flexible page surface after one corner is pulled away from the
    /// rectangle. Only the two adjacent edges curve; their far ends keep the
    /// original page tangents and the other three corners remain pinned.
    func pageCurlEdges(corner: Int) -> [[WarpOffset]] {
        guard (0..<4).contains(corner) else { return noEdgeWarp }

        var result = noEdgeWarp
        let base = bandCorners
        let warped = warpedCorners
        let previous = (corner + 3) % 4
        let next = (corner + 1) % 4
        let target = warped[corner]
        let incoming = Point(
            x: base[corner].x - base[previous].x,
            y: base[corner].y - base[previous].y
        )
        let outgoing = Point(
            x: base[next].x - base[corner].x,
            y: base[next].y - base[corner].y
        )

        result[previous][0] = toEdgeOffset(
            edge: previous,
            control: 0,
            target: Point(
                x: base[previous].x + incoming.x / 3,
                y: base[previous].y + incoming.y / 3
            )
        )
        result[previous][1] = toEdgeOffset(
            edge: previous,
            control: 1,
            target: Point(x: target.x - incoming.x / 3, y: target.y - incoming.y / 3)
        )
        result[corner][0] = toEdgeOffset(
            edge: corner,
            control: 0,
            target: Point(x: target.x + outgoing.x / 3, y: target.y + outgoing.y / 3)
        )
        result[corner][1] = toEdgeOffset(
            edge: corner,
            control: 1,
            target: Point(
                x: base[corner].x + outgoing.x * 2 / 3,
                y: base[corner].y + outgoing.y * 2 / 3
            )
        )
        return result
    }

    /// Express a document-space point as a corner offset in the rectangle's frame.
    func toWarpOffset(corner: Int, target: Point) -> WarpOffset {
        let base = bandCorners[corner]
        let (along, out) = rectBasis
        let dx = target.x - base.x
        let dy = target.y - base.y
        return WarpOffset(u: dx * along.x + dy * along.y, v: dx * out.x + dy * out.y)
    }

    /// Centre of the rectangle, which is what rotation turns about.
    var rectCenter: Point {
        let (along, out) = rectBasis
        return Point(
            x: anchor.x + along.x * width / 2 + out.x * length / 2,
            y: anchor.y + along.y * width / 2 + out.y * length / 2
        )
    }

    /// The anchor that keeps `centre` fixed for a given rotation — rotating about
    /// the middle means the corner has to move.
    func anchorForCentre(_ centre: Point, rotation: Double) -> Point {
        var turned = self
        turned.rotation = rotation
        let (along, out) = turned.rectBasis
        return Point(
            x: centre.x - along.x * width / 2 - out.x * length / 2,
            y: centre.y - along.y * width / 2 - out.y * length / 2
        )
    }
}
