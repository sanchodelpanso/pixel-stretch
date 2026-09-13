import Foundation

/// Maps the unit square onto an arbitrary convex quadrilateral.
/// `g`/`h` are the perspective terms — zero for a parallelogram, non-zero once
/// a corner is dragged out of line, which is what makes the streaks converge.
struct Homography {
    var a, b, c: Double
    var d, e, f: Double
    var g, h: Double
}

/// Build the projective map taking (0,0), (1,0), (1,1), (0,1) to the four
/// given corners, in that order (Heckbert's unit-square-to-quad).
func quadHomography(_ corners: [Point]) -> Homography {
    let p0 = corners[0], p1 = corners[1], p2 = corners[2], p3 = corners[3]

    let dx1 = p1.x - p2.x
    let dx2 = p3.x - p2.x
    let dx3 = p0.x - p1.x + p2.x - p3.x
    let dy1 = p1.y - p2.y
    let dy2 = p3.y - p2.y
    let dy3 = p0.y - p1.y + p2.y - p3.y

    // No "twist" between the opposite edges: the quad is a parallelogram and the
    // map is a plain affine one.
    if dx3 == 0 && dy3 == 0 {
        return Homography(
            a: p1.x - p0.x, b: p2.x - p1.x, c: p0.x,
            d: p1.y - p0.y, e: p2.y - p1.y, f: p0.y,
            g: 0, h: 0
        )
    }

    let den = dx1 * dy2 - dx2 * dy1
    if den == 0 {
        // Degenerate quad (collinear corners); fall back to the affine reading.
        return Homography(
            a: p1.x - p0.x, b: p3.x - p0.x, c: p0.x,
            d: p1.y - p0.y, e: p3.y - p0.y, f: p0.y,
            g: 0, h: 0
        )
    }

    let g = (dx3 * dy2 - dx2 * dy3) / den
    let h = (dx1 * dy3 - dx3 * dy1) / den
    return Homography(
        a: p1.x - p0.x + g * p1.x,
        b: p3.x - p0.x + h * p3.x,
        c: p0.x,
        d: p1.y - p0.y + g * p1.y,
        e: p3.y - p0.y + h * p3.y,
        f: p0.y,
        g: g,
        h: h
    )
}

/// Project a unit-square coordinate through the homography.
func project(_ m: Homography, _ u: Double, _ v: Double) -> Point {
    let w = m.g * u + m.h * v + 1
    // A point on the horizon divides by zero; nudge it rather than emit NaN.
    let safe = abs(w) < 1e-9 ? 1e-9 : w
    return Point(x: (m.a * u + m.b * v + m.c) / safe, y: (m.d * u + m.e * v + m.f) / safe)
}

/// How far in front of the surface the notional viewer sits, in band widths.
private let cameraDistance = 2.6
/// At wrap 1, a width-sized chord on a width-radius cylinder spans 60°.
private let halfAngleAtWidthRadius = Double.pi / 6

/// Wrap the band around a cylinder whose radius is derived from its width.
///
/// At ±1 the radius equals the rectangle width. Both side corners stay fixed;
/// the interior columns follow the circular surface and are foreshortened.
func bendColumn(_ u: Double, bend: Double) -> (u: Double, scale: Double) {
    if bend == 0 { return (u, 1) }

    let wrap = min(abs(bend), 2)
    let half = wrap * halfAngleAtWidthRadius
    let sinHalf = sin(half)
    if sinHalf < 1e-6 { return (u, 1) }

    let theta = (u - 0.5) * 2 * half
    // Normalising by the endpoint sine keeps both dragged side edges fixed.
    let flat = sin(theta) / (2 * sinHalf)
    // R / width = 1 / (2 sin(half)); at wrap 1 this evaluates to exactly 1.
    let depth = (cos(theta) - cos(half)) / (2 * sinHalf)
    let towards = bend < 0 ? -depth : depth

    let scale = cameraDistance / (cameraDistance - towards)
    return (0.5 + flat * scale, scale)
}

/// Project one point on the cylindrical sheet, scaling around its centreline.
func bendPoint(_ u: Double, _ v: Double, bend: Double) -> Point {
    let column = bendColumn(u, bend: bend)
    return Point(x: column.u, y: 0.5 + (v - 0.5) * column.scale)
}
