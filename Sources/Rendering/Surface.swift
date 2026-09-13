import Foundation

struct PageCurlVertex {
    let point: Point
    let z: Double
}

/// A rounded fold with independently pinned corners, matching the web map.
/// A smooth correction allows the sheet to distort while all four corners
/// land exactly at their stored targets, including after successive drags.
struct PageCurlSurface {
    let spec: StretchSpec
    let along: Point
    let out: Point
    let midpoint: Point
    let nx: Double
    let ny: Double
    let radius: Double
    private var corrections: [PageCurlVertex] = []

    init(_ spec: StretchSpec) {
        self.spec = spec
        let basis = spec.rectBasis
        along = basis.along
        out = basis.out
        let corner = spec.curlCorner ?? 0
        let original = spec.bandCorners[corner]
        let target = spec.warpedCorners[corner]
        let dx = original.x - target.x
        let dy = original.y - target.y
        let distance = hypot(dx, dy)
        nx = distance > 1e-6 ? dx / distance : 0
        ny = distance > 1e-6 ? dy / distance : 0
        midpoint = Point(x: (original.x + target.x) / 2, y: (original.y + target.y) / 2)
        radius = min(abs(spec.width) * 0.16, distance * 0.24)
        let targets = spec.warpedCorners
        let uvCorners = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]
        for (index, uv) in uvCorners.enumerated() {
            let folded = foldedAt(uv.0, uv.1)
            corrections.append(PageCurlVertex(
                point: Point(x: targets[index].x - folded.point.x, y: targets[index].y - folded.point.y),
                z: index == corner ? 0 : -folded.z
            ))
        }
    }

    private func foldedAt(_ u: Double, _ v: Double) -> PageCurlVertex {
        let x = spec.anchor.x + along.x * spec.width * u + out.x * spec.length * v
        let y = spec.anchor.y + along.y * spec.width * u + out.y * spec.length * v
        let halfArc = Double.pi * radius / 2
        let s = (x - midpoint.x) * nx + (y - midpoint.y) * ny
        guard radius >= 1e-6, s > -halfArc else {
            return PageCurlVertex(point: Point(x: x, y: y), z: 0)
        }
        let angle = min(Double.pi, (s + halfArc) / radius)
        let folded = s >= halfArc ? -s : -halfArc + radius * sin(angle)
        let shift = folded - s
        return PageCurlVertex(
            point: Point(x: x + nx * shift, y: y + ny * shift),
            z: radius * (1 - cos(angle))
        )
    }

    func at(_ u: Double, _ v: Double) -> PageCurlVertex {
        let folded = foldedAt(u, v)
        let su = u * u * (3 - 2 * u)
        let sv = v * v * (3 - 2 * v)
        let weights = [(1 - su) * (1 - sv), su * (1 - sv), su * sv, (1 - su) * sv]
        var x = folded.point.x
        var y = folded.point.y
        var z = folded.z
        for index in 0..<4 {
            x += corrections[index].point.x * weights[index]
            y += corrections[index].point.y * weights[index]
            z += corrections[index].z * weights[index]
        }
        return PageCurlVertex(point: Point(x: x, y: y), z: max(0, z))
    }
}

/// A cubic Bézier edge: start, two controls, end.
struct CubicEdge {
    var p0: Point
    var c0: Point
    var c1: Point
    var p1: Point

    /// Point at parameter `t` along the curve.
    func at(_ t: Double) -> Point {
        let s = 1 - t
        let a = s * s * s
        let b = 3 * s * s * t
        let c = 3 * s * t * t
        let d = t * t * t
        return Point(
            x: a * p0.x + b * c0.x + c * c1.x + d * p1.x,
            y: a * p0.y + b * c0.y + c * c1.y + d * p1.y
        )
    }
}

/// Bilinearly-blended Coons patch: the surface that interpolates all four
/// boundary curves, given as c0→c1, c1→c2, c2→c3, c3→c0.
///
/// The two ruled surfaces (one spanning top-to-bottom, one left-to-right) are
/// summed, and the bilinear surface through the corners is subtracted back out
/// — otherwise the corners would be counted twice.
///
/// With straight edges this degenerates to plain bilinear interpolation, which
/// is why curved mode trades the perspective foreshortening of the homography
/// for free-form shaping.
func coonsPoint(_ edges: [CubicEdge], _ u: Double, _ v: Double) -> Point {
    let top = edges[0], right = edges[1], bottom = edges[2], left = edges[3]

    // Corner positions, taken from the curves themselves so they can't drift.
    let p00 = top.p0
    let p10 = top.p1
    let p11 = bottom.p0
    let p01 = bottom.p1

    let cTop = top.at(u)
    let cRight = right.at(v)
    // The stored bottom edge runs c2→c3, i.e. backwards in u; likewise the left
    // edge runs c3→c0, backwards in v.
    let cBottom = bottom.at(1 - u)
    let cLeft = left.at(1 - v)

    let ruledV = Point(x: (1 - v) * cTop.x + v * cBottom.x, y: (1 - v) * cTop.y + v * cBottom.y)
    let ruledU = Point(x: (1 - u) * cLeft.x + u * cRight.x, y: (1 - u) * cLeft.y + u * cRight.y)
    let bilinear = Point(
        x: (1 - u) * (1 - v) * p00.x + u * (1 - v) * p10.x + u * v * p11.x + (1 - u) * v * p01.x,
        y: (1 - u) * (1 - v) * p00.y + u * (1 - v) * p10.y + u * v * p11.y + (1 - u) * v * p01.y
    )

    return Point(x: ruledV.x + ruledU.x - bilinear.x, y: ruledV.y + ruledU.y - bilinear.y)
}
