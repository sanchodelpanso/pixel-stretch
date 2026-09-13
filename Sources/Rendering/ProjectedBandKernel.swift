import CoreGraphics
import CoreImage
import Foundation

/// Draws a perspective-warped and/or bent band on the GPU.
///
/// The web app draws such a band one column at a time. Core Graphics pays for
/// every draw by the bounding box of the transformed column, so once columns
/// tilt — any diagonal path, any perspective pull — that costs seconds. This
/// inverts the mapping per output pixel instead: undo the homography to get the
/// unit-square position, undo the bend by bisection to find the column, then
/// read the upright band there.
enum ProjectedBandKernel {
    private static let kernel: CIKernel? = try? CIKernel.kernels(withMetalString: source).first

    /// Pixel values pass straight through: the band is already in the editor's
    /// sRGB format, and re-encoding it would shift colours at every edit.
    private static let context = CIContext(options: [
        .workingColorSpace: NSNull(),
        .outputColorSpace: NSNull(),
        .cacheIntermediates: false,
    ])

    /// Compile the kernel ahead of the first distorted drag, which would
    /// otherwise stall for the half second it takes.
    static func prepare() {
        _ = kernel
    }

    /// Render `local` through `homography` — which maps the unit square to the
    /// band's quad in output pixels — curled by `bend`. Returns nil if the GPU
    /// path is unavailable, so the caller can fall back to the CPU renderer.
    static func render(local: CGImage, homography m: Homography, bend: Double, width: Int, height: Int) -> CGImage? {
        guard let kernel, let inverse = invert(m) else { return nil }

        let half = min(abs(bend), 2) * .pi / 6
        let sinHalf = sin(half)
        // Matches `bendColumn`: a negligible bend is no bend at all.
        let effectiveBend = sinHalf < 1e-6 ? 0 : bend
        let band = CIImage(cgImage: local, options: [.colorSpace: NSNull()])
        let extent = CGRect(x: 0, y: 0, width: width, height: height)

        guard let output = kernel.apply(
            extent: extent,
            roiCallback: { _, _ in band.extent },
            arguments: [
                band,
                CIVector(x: inverse[0], y: inverse[1], z: inverse[2]),
                CIVector(x: inverse[3], y: inverse[4], z: inverse[5]),
                CIVector(x: inverse[6], y: inverse[7], z: inverse[8]),
                Float(effectiveBend), Float(half), Float(sinHalf),
                Float(height), Float(local.width), Float(local.height),
            ]
        ) else { return nil }

        return context.createCGImage(output, from: extent, format: .RGBA8, colorSpace: BitmapContext.colorSpace)
    }

    /// Inverse of the 3×3 matrix [[a b c] [d e f] [g h 1]], row-major.
    private static func invert(_ m: Homography) -> [CGFloat]? {
        let (a, b, c, d, e, f, g, h, i) = (m.a, m.b, m.c, m.d, m.e, m.f, m.g, m.h, 1.0)
        let c00 = e * i - f * h
        let c01 = -(d * i - f * g)
        let c02 = d * h - e * g
        let det = a * c00 + b * c01 + c * c02
        guard abs(det) > 1e-12, det.isFinite else { return nil }
        let inverse = [
            c00, -(b * i - c * h), b * f - c * e,
            c01, a * i - c * g, -(a * f - c * d),
            c02, -(a * h - b * g), a * e - b * d,
        ]
        return inverse.map { CGFloat($0 / det) }
    }

    /// The same curl as `bendColumn`, so both renderers agree on where columns land.
    private static let source = """
    #include <CoreImage/CoreImage.h>
    using namespace metal;

    namespace pixelstretch {
        inline float bentColumn(float u, float bend, float halfAngle, float sinHalf, thread float &scale) {
            if (bend == 0.0) { scale = 1.0; return u; }
            float theta = (u - 0.5) * 2.0 * halfAngle;
            float flat = sin(theta) / (2.0 * sinHalf);
            float depth = (cos(theta) - cos(halfAngle)) / (2.0 * sinHalf);
            float towards = bend < 0.0 ? -depth : depth;
            scale = 2.6 / (2.6 - towards);
            return 0.5 + flat * scale;
        }
    }

    [[ stitchable ]] float4 projectedBand(coreimage::sampler band,
                                         float3 row0, float3 row1, float3 row2,
                                         float bend, float halfAngle, float sinHalf,
                                         float outHeight, float bandWidth, float bandHeight,
                                         coreimage::destination dest)
    {
        // Output pixel, top-left origin like the rest of the renderer.
        float2 d = dest.coord();
        float3 p = float3(d.x, outHeight - d.y, 1.0);
        float w = dot(row2, p);
        if (abs(w) < 1e-9) { return float4(0.0); }
        float U = dot(row0, p) / w;
        float V = dot(row1, p) / w;
        if (U < 0.0 || U > 1.0) { return float4(0.0); }

        // The curl moves columns sideways; find which column lands at U.
        float u = U;
        float scale = 1.0;
        if (bend != 0.0) {
            float lo = 0.0;
            float hi = 1.0;
            float probe = 1.0;
            for (int i = 0; i < 24; i++) {
                float mid = 0.5 * (lo + hi);
                if (pixelstretch::bentColumn(mid, bend, halfAngle, sinHalf, probe) < U) { lo = mid; } else { hi = mid; }
            }
            u = 0.5 * (lo + hi);
            pixelstretch::bentColumn(u, bend, halfAngle, sinHalf, scale);
        }

        // Foreshortening scales around the cylinder axis at the sheet centre.
        float v = 0.5 + (V - 0.5) / scale;
        if (v < 0.0 || v > 1.0) { return float4(0.0); }
        return band.sample(band.transform(float2(u * bandWidth, (1.0 - v) * bandHeight)));
    }
    """
}
