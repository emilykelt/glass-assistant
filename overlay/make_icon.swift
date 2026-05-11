import AppKit
import CoreGraphics
import Foundation

let sizes = [16, 32, 64, 128, 256, 512, 1024]
let outDir = "Glass.iconset"
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

func render(size: Int) -> Data {
    let s = CGFloat(size)
    let cs = CGColorSpaceCreateDeviceRGB()
    let ctx = CGContext(data: nil, width: size, height: size,
                        bitsPerComponent: 8, bytesPerRow: 0,
                        space: cs,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!

    // Rounded-rect mask matching macOS icon corner radius (~22.37% of side)
    let radius = s * 0.2237
    let rect = CGRect(x: 0, y: 0, width: s, height: s)
    let path = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
    ctx.addPath(path)
    ctx.clip()

    // Background: vertical gradient, deep slate-blue → softer steel-blue
    let bgColors = [
        CGColor(red: 0.30, green: 0.38, blue: 0.50, alpha: 1.0), // top
        CGColor(red: 0.42, green: 0.52, blue: 0.64, alpha: 1.0), // bottom
    ] as CFArray
    let bgGrad = CGGradient(colorsSpace: cs, colors: bgColors, locations: [0.0, 1.0])!
    ctx.drawLinearGradient(bgGrad, start: CGPoint(x: 0, y: s), end: CGPoint(x: 0, y: 0), options: [])

    // Off-centre white radial "orb" — upper-right
    let centre = CGPoint(x: s * 0.66, y: s * 0.68)
    let orbColors = [
        CGColor(red: 1.0, green: 1.0, blue: 1.0, alpha: 0.95),
        CGColor(red: 1.0, green: 1.0, blue: 1.0, alpha: 0.55),
        CGColor(red: 1.0, green: 1.0, blue: 1.0, alpha: 0.0),
    ] as CFArray
    let orbGrad = CGGradient(colorsSpace: cs, colors: orbColors, locations: [0.0, 0.45, 1.0])!
    ctx.drawRadialGradient(orbGrad,
                           startCenter: centre, startRadius: 0,
                           endCenter: centre, endRadius: s * 0.55,
                           options: [])

    // Subtle inner highlight at the very top edge for "glass" sheen
    ctx.saveGState()
    ctx.addPath(path)
    ctx.clip()
    let sheen = [
        CGColor(red: 1.0, green: 1.0, blue: 1.0, alpha: 0.18),
        CGColor(red: 1.0, green: 1.0, blue: 1.0, alpha: 0.0),
    ] as CFArray
    let sheenGrad = CGGradient(colorsSpace: cs, colors: sheen, locations: [0.0, 1.0])!
    ctx.drawLinearGradient(sheenGrad, start: CGPoint(x: 0, y: s), end: CGPoint(x: 0, y: s * 0.7), options: [])
    ctx.restoreGState()

    let cgImg = ctx.makeImage()!
    let rep = NSBitmapImageRep(cgImage: cgImg)
    return rep.representation(using: .png, properties: [:])!
}

func write(name: String, size: Int) {
    let data = render(size: size)
    try! data.write(to: URL(fileURLWithPath: "\(outDir)/\(name)"))
    print("wrote \(name) (\(size)px)")
}

// macOS .iconset naming convention
write(name: "icon_16x16.png",       size: 16)
write(name: "icon_16x16@2x.png",    size: 32)
write(name: "icon_32x32.png",       size: 32)
write(name: "icon_32x32@2x.png",    size: 64)
write(name: "icon_128x128.png",     size: 128)
write(name: "icon_128x128@2x.png",  size: 256)
write(name: "icon_256x256.png",     size: 256)
write(name: "icon_256x256@2x.png",  size: 512)
write(name: "icon_512x512.png",     size: 512)
write(name: "icon_512x512@2x.png",  size: 1024)
