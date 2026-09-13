import CoreGraphics

/// All values are normalized to the image (fractions of width/height, top-left
/// origin, matching screen space), so the same parameter set renders
/// identically at preview and export resolution with no rescaling step.
struct StretchParameters: Codable, Equatable {
    /// X of the 1px sample column, as a fraction of image width.
    var sampleX: CGFloat = 0.5
    /// Top edge of the band, as a fraction of image height from the top.
    var extentTop: CGFloat = 0.3
    /// Bottom edge of the band, as a fraction of image height from the top.
    var extentBottom: CGFloat = 0.7
    /// Signed band length as a fraction of image width. Positive extends
    /// right of the sample line, negative extends left.
    var length: CGFloat = 0.3
    /// Rotation in radians about the pivot on the sample line
    /// (clockwise-positive in screen space).
    var angle: CGFloat = 0
    /// Warp: bows the band into an arc. Signed; magnitude is the far-end
    /// offset as a fraction of band height, positive droops down-screen.
    var bend: CGFloat = 0
    /// 0 = solid to the far end, 1 = fully faded out at the far end.
    var fade: CGFloat = 0.35
    var opacity: CGFloat = 1.0
    /// Softening of the band edges, as a fraction of band size.
    var edgeSoftness: CGFloat = 0.06

    /// Pivot sits on the sample line at the vertical center of the extent —
    /// this is what keeps the band feeling attached to the subject.
    var pivotY: CGFloat { (extentTop + extentBottom) / 2 }
}
