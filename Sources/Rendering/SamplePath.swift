import Foundation

/// Polyline resolution per spline segment. Plenty for arc-length accuracy.
private let stepsPerSegment = 24

/// Centripetal Catmull-Rom exponent; 0.5 is what avoids cusps and loops.
private let alpha = 0.5

private func distance(_ a: Point, _ b: Point) -> Double {
    hypot(b.x - a.x, b.y - a.y)
}

private func mix(_ a: Point, _ b: Point, _ t: Double) -> Point {
    Point(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
}

/// One centripetal Catmull-Rom segment, from p1 to p2, using p0/p3 as tangent
/// neighbours. Barry-Goldman form — knots spaced by the square root of chord
/// length, which is what keeps unevenly-placed points from overshooting into
/// loops the way uniform Catmull-Rom does.
private func segmentPoints(_ p0: Point, _ p1: Point, _ p2: Point, _ p3: Point, steps: Int) -> [Point] {
    let t0 = 0.0
    let t1 = t0 + pow(distance(p0, p1), alpha)
    let t2 = t1 + pow(distance(p1, p2), alpha)
    let t3 = t2 + pow(distance(p2, p3), alpha)

    // Coincident points collapse a knot span; fall back to the straight chord.
    if t1 == t0 || t2 == t1 || t3 == t2 {
        return (0..<steps).map { mix(p1, p2, Double($0) / Double(steps)) }
    }

    return (0..<steps).map { i in
        let t = t1 + (t2 - t1) * Double(i) / Double(steps)
        let a1 = mix(p0, p1, (t - t0) / (t1 - t0))
        let a2 = mix(p1, p2, (t - t1) / (t2 - t1))
        let a3 = mix(p2, p3, (t - t2) / (t3 - t2))
        let b1 = mix(a1, a2, (t - t0) / (t2 - t0))
        let b2 = mix(a2, a3, (t - t1) / (t3 - t1))
        return mix(b1, b2, (t - t1) / (t2 - t1))
    }
}

/// Flatten the control points into a dense polyline following a smooth spline
/// through every one of them. Two points give a straight line.
func pathToPolyline(_ points: [Point]) -> [Point] {
    guard points.count > 2, let first = points.first, let last = points.last else { return points }

    // Reflect the ends so the first and last segments get a tangent neighbour.
    let before = points[1]
    let after = points[points.count - 2]
    let padded = [Point(x: 2 * first.x - before.x, y: 2 * first.y - before.y)]
        + points
        + [Point(x: 2 * last.x - after.x, y: 2 * last.y - after.y)]

    var out: [Point] = []
    for i in 1..<(padded.count - 2) {
        out += segmentPoints(padded[i - 1], padded[i], padded[i + 1], padded[i + 2], steps: stepsPerSegment)
    }
    out.append(last)
    return out
}

/// Total length of a polyline in document pixels.
func polylineLength(_ polyline: [Point]) -> Double {
    zip(polyline, polyline.dropFirst()).reduce(0) { $0 + distance($1.0, $1.1) }
}

/// Resample a polyline into `count` points spaced evenly by arc length, so the
/// pixels read off a curve are as evenly spread as those read off a line.
func resamplePolyline(_ polyline: [Point], count: Int) -> [Point] {
    guard count > 0, let first = polyline.first else { return [] }
    if polyline.count == 1 || count == 1 { return Array(repeating: first, count: count) }

    // Cumulative arc length at each vertex.
    var cumulative = [0.0]
    for i in 1..<polyline.count {
        cumulative.append(cumulative[i - 1] + distance(polyline[i - 1], polyline[i]))
    }
    let total = cumulative[cumulative.count - 1]
    if total == 0 { return Array(repeating: first, count: count) }

    var out: [Point] = []
    out.reserveCapacity(count)
    var vertex = 1
    for i in 0..<count {
        let target = total * Double(i) / Double(count - 1)
        while vertex < cumulative.count - 1 && cumulative[vertex] < target { vertex += 1 }
        let span = cumulative[vertex] - cumulative[vertex - 1]
        let t = span == 0 ? 0 : (target - cumulative[vertex - 1]) / span
        out.append(mix(polyline[vertex - 1], polyline[vertex], t))
    }
    return out
}

/// Sample the control path at `count` evenly-spaced points along its arc.
func samplePath(_ points: [Point], count: Int) -> [Point] {
    resamplePolyline(pathToPolyline(points), count: count)
}
