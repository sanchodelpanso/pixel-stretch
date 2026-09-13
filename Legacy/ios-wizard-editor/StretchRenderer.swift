import CoreImage
import CoreImage.CIFilterBuiltins
import Metal

/// The stretch engine: one Metal CIKernel that draws the band, plus the
/// three-layer composite (band over background, subject over band).
/// Parameters arrive normalized and are converted to Core Image pixel
/// coordinates (bottom-left origin) here and nowhere else.
final class StretchRenderer {

    static let shared = StretchRenderer()

    let context: CIContext
    private let bandKernel: CIKernel

    private init() {
        let device = MTLCreateSystemDefaultDevice()!
        context = CIContext(mtlDevice: device, options: [.cacheIntermediates: false])
        bandKernel = try! CIKernel.kernels(withMetalString: Self.kernelSource)[0]
    }

    func render(original: CIImage, mask: CIImage, params: StretchParameters) -> CIImage {
        let w = original.extent.width
        let h = original.extent.height

        // Normalized top-left-origin params -> CI bottom-left pixel coords.
        let pivotX = params.sampleX * w
        let bandTop = (1 - params.extentTop) * h
        let bandBottom = (1 - params.extentBottom) * h
        let pivotY = (bandTop + bandBottom) / 2
        let sign: CGFloat = params.length < 0 ? -1 : 1
        let length = max(abs(params.length), 0.002) * w * sign
        // Screen-space clockwise rotation is counterclockwise in CI's
        // y-up coordinates.
        let angle = -params.angle

        guard let band = bandKernel.apply(
            extent: original.extent,
            roiCallback: { _, _ in original.extent },
            arguments: [
                original,
                Float(pivotX), Float(pivotY),
                Float(bandBottom), Float(bandTop),
                Float(length), Float(angle),
                // Screen-space "down" is negative y in CI coordinates.
                Float(-params.bend),
                Float(params.fade.clamped01),
                Float(params.opacity.clamped01),
                Float(max(params.edgeSoftness, 0.001)),
            ]
        ) else {
            return original
        }

        let blend = CIFilter.blendWithMask()
        blend.inputImage = original
        blend.backgroundImage = band.composited(over: original)
        blend.maskImage = mask
        return blend.outputImage ?? original
    }

    /// The band kernel, compiled at runtime so no custom Metal build flags
    /// are needed. Geometry: rotate the destination pixel into band space
    /// about the pivot, then the band is u in [0, length] along the stretch
    /// direction and v in [y0, y1] vertically. Color is a single clamped
    /// sample of the 1px column at the pivot's x; alpha is opacity shaped by
    /// the fade ramp and edge softening. Output is premultiplied.
    private static let kernelSource = """
    #include <CoreImage/CoreImage.h>
    using namespace metal;

    [[ stitchable ]] float4 stretchBand(coreimage::sampler src,
                                  float pivotX, float pivotY,
                                  float y0, float y1,
                                  float len, float angle,
                                  float bend,
                                  float fade, float opacity, float soft,
                                  coreimage::destination dest)
    {
        float2 p = dest.coord() - float2(pivotX, pivotY);
        float c = cos(-angle);
        float s = sin(-angle);
        float u = c * p.x - s * p.y;
        float v = s * p.x + c * p.y + pivotY;

        float t = u / len;
        if (t < 0.0 || t > 1.0) { return float4(0.0); }

        // Warp: each column of the band shifts by a quadratic droop, bowing
        // it into an arc that stays anchored at the sample line.
        float vb = v - bend * (y1 - y0) * t * t;
        if (vb < y0 || vb > y1) { return float4(0.0); }

        float4 col = src.sample(src.transform(float2(pivotX, vb)));

        float a = opacity;
        a *= 1.0 - fade * t;
        float sy = soft * (y1 - y0);
        a *= smoothstep(y0, y0 + sy, vb) * (1.0 - smoothstep(y1 - sy, y1, vb));
        a *= 1.0 - smoothstep(1.0 - soft, 1.0, t);

        return col * a;
    }
    """
}

private extension CGFloat {
    var clamped01: CGFloat { Swift.min(Swift.max(self, 0), 1) }
}
