import SwiftUI

/// The web app's palette, so both editors read as the same product.
enum Theme {
    static let background = Color(red: 10 / 255, green: 10 / 255, blue: 10 / 255)
    static let panel = Color(red: 10 / 255, green: 10 / 255, blue: 15 / 255)
    static let accent = Color(red: 90 / 255, green: 153 / 255, blue: 1)
    static let accentPurple = Color(red: 124 / 255, green: 106 / 255, blue: 1)
    static let chip = Color(red: 10 / 255, green: 10 / 255, blue: 15 / 255).opacity(0.88)
    static let chipBorder = Color.white.opacity(0.15)
    static let warning = Color(red: 251 / 255, green: 191 / 255, blue: 36 / 255)
    static let error = Color(red: 244 / 255, green: 63 / 255, blue: 94 / 255)

    /// Transparency checkerboard tile, matching the web canvas.
    static let checkerTile: UIImage = {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: 16, height: 16), format: format).image { context in
            UIColor(red: 0x1b / 255, green: 0x1b / 255, blue: 0x20 / 255, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 16, height: 16))
            UIColor(red: 0x23 / 255, green: 0x23 / 255, blue: 0x29 / 255, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
            context.fill(CGRect(x: 8, y: 8, width: 8, height: 8))
        }
    }()
}

extension Point {
    func view(_ scale: Double) -> CGPoint {
        CGPoint(x: x * scale, y: y * scale)
    }

    init(view point: CGPoint, scale: Double) {
        self.init(x: point.x / scale, y: point.y / scale)
    }
}

/// Recognises a double tap from inside a drag gesture. Handles start dragging
/// the moment they're touched, like pointer-down on the web, so a separate
/// tap gesture would never get a chance to fire.
struct DoubleTapDetector {
    private var lastTap: (key: String, time: Date)?

    /// Call when a drag on the handle `key` ends; true when it completes a
    /// double tap on that same handle.
    mutating func registerEnd(key: String, of value: DragGesture.Value) -> Bool {
        let isTap = hypot(value.translation.width, value.translation.height) < 6
        guard isTap else {
            lastTap = nil
            return false
        }
        if let lastTap, lastTap.key == key, value.time.timeIntervalSince(lastTap.time) < 0.4 {
            self.lastTap = nil
            return true
        }
        lastTap = (key, value.time)
        return false
    }
}
