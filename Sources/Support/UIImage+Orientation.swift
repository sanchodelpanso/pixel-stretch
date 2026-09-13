import UIKit

extension UIImage {
    /// Bakes EXIF orientation into the pixels and converts to the editor's
    /// 8-bit sRGB format, so every layer shares one pixel layout. Do this once
    /// at import.
    func uprightSRGBImage() -> CGImage? {
        let pixelSize = CGSize(width: size.width * scale, height: size.height * scale)
        guard let context = BitmapContext.make(width: pixelSize.width, height: pixelSize.height) else { return nil }
        // The context is already flipped to UIKit's top-left orientation.
        UIGraphicsPushContext(context)
        draw(in: CGRect(origin: .zero, size: pixelSize))
        UIGraphicsPopContext()
        return context.makeImage()
    }
}
