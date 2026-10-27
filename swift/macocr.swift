// macos-ocr — Apple Vision Framework OCR 引擎（图片 + PDF）
//
// 构建: swiftc -O -module-cache-path <cache> macocr.swift -o macocr
// 用法: macocr <path> [--json] [--langs en-US,ar-SA] [--pages 1-3,5]
//                    [--dpi 200] [--fast] [--min-conf 0.0] [--list-langs]
//
// 输出: --json 时为单对象 JSON（stdout）；否则逐行文本。错误走 stderr，退出码 2。

import Foundation
import Vision
import CoreGraphics
import ImageIO
import PDFKit

// MARK: - 常量

let MAX_PAGE_PIXELS: Double = 40_000_000   // 单页位图上限，防止畸形 PDF 撑爆内存
let MIN_SIDE_PIXELS: Double = 1600         // 短边不足则放大，小字号是 OCR 失败主因
let MAX_SIDE_PIXELS: Double = 4000         // 单边超过就降采样，控制内存
let MAX_IMAGE_PIXELS: Double = 24_000_000  // 面积上限（约 24MP），手机直出大图会被缩

// MARK: - 工具函数

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(("macos-ocr: " + message + "\n").utf8))
    exit(2)
}

func warn(_ message: String) {
    FileHandle.standardError.write(Data(("macos-ocr: " + message + "\n").utf8))
}

// MARK: - 参数

struct Options {
    var path = ""
    var json = false
    var fast = false
    var langs: [String] = ["en-US"]
    var pages: String?
    var dpi: Double = 200
    var minConf: Float = 0
    var listLangs = false
    var noCorrect = false
    var autoRotate = true
    var textLayer = true
}

func parseArgs() -> Options {
    var o = Options()
    let args = Array(CommandLine.arguments.dropFirst())
    var i = 0
    func value(_ flag: String) -> String {
        i += 1
        guard i < args.count else { fail("\(flag) 缺少取值") }
        return args[i]
    }
    while i < args.count {
        let a = args[i]
        switch a {
        case "--json": o.json = true
        case "--fast": o.fast = true
        case "--no-correct": o.noCorrect = true
        case "--no-auto-rotate": o.autoRotate = false
        case "--no-text-layer": o.textLayer = false
        case "--list-langs": o.listLangs = true
        case "--langs": o.langs = value(a).split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        case "--pages": o.pages = value(a)
        case "--dpi":
            let v = value(a)
            guard let d = Double(v), d >= 40, d <= 600 else { fail("--dpi 需要在 40–600 之间") }
            o.dpi = d
        case "--min-conf":
            let v = value(a)
            guard let f = Float(v), f >= 0, f <= 1 else { fail("--min-conf 需要在 0–1 之间") }
            o.minConf = f
        case "-h", "--help":
            print("usage: macocr <image|pdf> [--json] [--langs a,b] [--pages 1-3] [--dpi 200] [--fast] [--min-conf 0.5] [--list-langs]")
            exit(0)
        default:
            if a.hasPrefix("-") { fail("未知参数 \(a)") }
            o.path = a
        }
        i += 1
    }
    if o.listLangs {
        let r = VNRecognizeTextRequest()
        let langs = (try? VNRecognizeTextRequest.supportedRecognitionLanguages(for: .accurate, revision: r.revision)) ?? []
        print(langs.joined(separator: "\n"))
        exit(0)
    }
    if o.path.isEmpty { fail("缺少图片或 PDF 路径（--help 查看用法）") }
    return o
}

// MARK: - 输出结构

struct Line: Encodable {
    let text: String
    let confidence: Float
    let box: [Double]     // [x, y, w, h]：左上角原点、该页像素坐标
}

struct Page: Encodable {
    let page: Int
    let width: Int
    let height: Int
    let rotation: Int     // 实际生效的顺时针旋转角度（0/90/180/270）
    let source: String    // "text-layer"（PDF 文字层直出）或 "ocr"
    let lines: [Line]
}

struct Result: Encodable {
    let engine: String
    let file: String
    let kind: String
    let pageCount: Int
    let languages: [String]
    let pages: [Page]
    let text: String
}

// MARK: - 识别

func recognize(_ image: CGImage, orientation: CGImagePropertyOrientation, opts: Options) -> [Line] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = opts.fast ? .fast : .accurate
    request.usesLanguageCorrection = !opts.noCorrect
    request.recognitionLanguages = opts.langs
    // revision 用系统支持的最新版；不硬钉 2，否则新语言报不出来（macOCR 踩过）
    request.revision = VNRecognizeTextRequestRevision3

    let handler = VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:])
    do {
        try handler.perform([request])
    } catch {
        fail("Vision 识别失败: \(error.localizedDescription)")
    }

    let W = Double(image.width), H = Double(image.height)
    var lines: [Line] = []
    for observation in request.results ?? [] {
        guard let candidate = observation.topCandidates(1).first else { continue }
        if candidate.confidence < opts.minConf { continue }
        let bb = observation.boundingBox        // 归一化，原点左下
        lines.append(Line(
            text: candidate.string,
            confidence: (candidate.confidence * 100).rounded() / 100,
            box: [
                (bb.minX * W * 10).rounded() / 10,
                ((1 - bb.maxY) * H * 10).rounded() / 10,
                (bb.width * W * 10).rounded() / 10,
                (bb.height * H * 10).rounded() / 10,
            ]
        ))
    }
    // Vision 的顺序基本就是阅读序；再按 y 再按 x 稳定一次，便于下游还原表格
    return lines.enumerated().sorted { a, b in
        let dy = a.element.box[1] - b.element.box[1]
        if abs(dy) > 3 { return dy < 0 }
        return a.element.box[0] < b.element.box[0]
    }.map { $0.element }
}

/// 顺时针旋转整页位图（quarterTurns: 0–3），用于纠正横放的扫描件
func rotate(_ image: CGImage, quarterTurns: Int) -> CGImage {
    let turns = ((quarterTurns % 4) + 4) % 4
    if turns == 0 { return image }
    let w = image.width, h = image.height
    let nw = turns % 2 == 0 ? w : h
    let nh = turns % 2 == 0 ? h : w
    guard let ctx = CGContext(data: nil, width: nw, height: nh, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return image }
    ctx.translateBy(x: CGFloat(nw) / 2, y: CGFloat(nh) / 2)
    ctx.rotate(by: CGFloat(turns) * .pi / 2)
    ctx.draw(image, in: CGRect(x: -CGFloat(w) / 2, y: -CGFloat(h) / 2, width: CGFloat(w), height: CGFloat(h)))
    return ctx.makeImage() ?? image
}

/// 结果质量分：行数 × 平均置信度 × 文本长度权重。横放的字被读成碎片时分数会明显塌下去。
func score(_ lines: [Line]) -> Double {
    guard !lines.isEmpty else { return 0 }
    let meanConf = lines.reduce(0.0) { $0 + Double($1.confidence) } / Double(lines.count)
    let chars = lines.reduce(0) { $0 + $1.text.count }
    return Double(lines.count) * meanConf * log(Double(chars) + 1)
}

/// 定向探测：用 .fast 把 0/90/180/270 各读一遍（每次 ~0.2s），挑分最高的一向，
/// 再用调用方要的精度正式读一次。直接用 .accurate 四向全扫会让每次调用变成 4 倍成本，
/// 所以探测和正式识别分开。
func recognizeAdaptive(_ bitmap: CGImage, orientation: CGImagePropertyOrientation,
                       opts: Options) -> ([Line], Int) {
    guard opts.autoRotate else { return (recognize(bitmap, orientation: orientation, opts: opts), 0) }

    var probe = opts
    probe.fast = true
    var bestTurns = 0
    var bestScore = -Double.infinity
    for turns in 0..<4 {
        let image = rotate(bitmap, quarterTurns: turns)
        let s = score(recognize(image, orientation: turns == 0 ? orientation : .up, opts: probe))
        if s > bestScore { bestScore = s; bestTurns = turns }
    }
    if bestTurns == 0 {
        return (recognize(bitmap, orientation: orientation, opts: opts), 0)
    }
    let image = rotate(bitmap, quarterTurns: bestTurns)
    return (recognize(image, orientation: .up, opts: opts), bestTurns * 90)
}

// MARK: - PDF 文字层

/// 数字型 PDF 自带文字层：直接抽出来比栅格化再 OCR 准确得多，
/// 而且不会把小字号读错（实测 200dpi OCR 会把 12655 读成 14055）。
/// 扫描件没有文字层，函数返回空数组，调用方回落到 OCR。
func textLayerLines(_ page: PDFPage, dpi: Double) -> [Line] {
    guard let text = page.string, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        return []
    }
    let box = page.bounds(for: .cropBox)
    guard box.width > 0, box.height > 0 else { return [] }

    var scale = dpi / 72.0
    let pixels = Double(box.width) * Double(box.height) * scale * scale
    if pixels > MAX_PAGE_PIXELS { scale *= (MAX_PAGE_PIXELS / pixels).squareRoot() }

    let ns = text as NSString
    var lines: [Line] = []
    var loc = 0
    while loc < ns.length {
        var lineStart = 0, lineEnd = 0, contentsEnd = 0
        ns.getLineStart(&lineStart, end: &lineEnd, contentsEnd: &contentsEnd,
                        for: NSRange(location: loc, length: 0))
        let range = NSRange(location: lineStart, length: max(0, contentsEnd - lineStart))
        let raw = range.length > 0 ? ns.substring(with: range) : ""
        loc = max(lineEnd, loc + 1)

        guard !raw.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
        guard let selection = page.selection(for: range) else { continue }
        let r = selection.bounds(for: page)
        guard r.width > 0, r.height > 0 else { continue }

        lines.append(Line(
            text: raw,
            confidence: 1,          // 文字层是精确文本，不存在识别置信度
            box: [
                ((r.minX - box.minX) * scale * 10).rounded() / 10,
                ((Double(box.height) - (r.maxY - box.minY)) * scale * 10).rounded() / 10,
                (r.width * scale * 10).rounded() / 10,
                (r.height * scale * 10).rounded() / 10,
            ]
        ))
    }
    return lines
}

/// 文字层是否够可信：太短的（水印、页码残留）交给 OCR 反而更完整
func textLayerUsable(_ lines: [Line]) -> Bool {
    let chars = lines.reduce(0) { $0 + $1.text.count }
    return lines.count >= 1 && chars >= 12
}

// MARK: - 位图

/// 尺寸归一：小图放大到短边 MIN_SIDE（Vision 对 1500px 以下的小字很吃力），
/// 大图先降采样（8000×8000 原样喂进去峰值 606MB，缩到 ≤4000 边长后回到百 MB 量级）。
func normalizeSize(_ image: CGImage) -> CGImage {
    let w = Double(image.width), h = Double(image.height)
    guard w > 0, h > 0 else { return image }

    let longest = max(w, h)
    let area = w * h
    var k = 1.0
    if longest > MAX_SIDE_PIXELS {
        k = MAX_SIDE_PIXELS / longest
    } else if area > MAX_IMAGE_PIXELS {
        k = (MAX_IMAGE_PIXELS / area).squareRoot()
    }
    if k < 1 {
        let nw = max(3, Int((w * k).rounded())), nh = max(3, Int((h * k).rounded()))
        guard let ctx = CGContext(data: nil, width: nw, height: nh, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return image }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: nw, height: nh))
        return ctx.makeImage() ?? image
    }
    return upscaleIfSmall(image)
}

/// 小图放大到短边 MIN_SIDE（Vision 对 1500px 以下的小字很吃力）
func upscaleIfSmall(_ image: CGImage) -> CGImage {
    let w = Double(image.width), h = Double(image.height)
    let shortSide = min(w, h)
    guard shortSide < MIN_SIDE_PIXELS else { return image }
    let k = min(3.0, (MIN_SIDE_PIXELS / shortSide).rounded(.up))
    let nw = Int(w * k), nh = Int(h * k)
    guard Double(nw * nh) < MAX_PAGE_PIXELS,
          let ctx = CGContext(data: nil, width: nw, height: nh, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return image }
    ctx.interpolationQuality = .high
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: nw, height: nh))
    return ctx.makeImage() ?? image
}

/// PDF 页 → 位图。getDrawingTransform 负责 /Rotate 与缩放，不用手搓旋转矩阵。
func renderPDFPage(_ page: CGPDFPage, dpi: Double) -> CGImage? {
    let box = page.getBoxRect(.cropBox)
    guard box.width > 0, box.height > 0 else { return nil }

    var scale = dpi / 72.0
    let pixels = Double(box.width) * Double(box.height) * scale * scale
    if pixels > MAX_PAGE_PIXELS { scale *= (MAX_PAGE_PIXELS / pixels).squareRoot() }
    // 小页同样放大到短边下限
    let shortSide = min(Double(box.width), Double(box.height)) * scale
    if shortSide < MIN_SIDE_PIXELS { scale *= MIN_SIDE_PIXELS / shortSide }

    let widthPx = (Double(box.width) * scale).rounded()
    let heightPx = (Double(box.height) * scale).rounded()
    guard widthPx.isFinite, heightPx.isFinite, widthPx >= 3, heightPx >= 3 else { return nil }
    guard widthPx * heightPx < MAX_PAGE_PIXELS else { return nil }

    let w = Int(widthPx), h = Int(heightPx)
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))   // PDF 背景透明，衬白底更利于识别
    ctx.fill(CGRect(x: 0, y: 0, width: CGFloat(w), height: CGFloat(h)))
    ctx.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
    ctx.concatenate(page.getDrawingTransform(.cropBox, rect: box, rotate: 0, preserveAspectRatio: true))
    ctx.drawPDFPage(page)
    return ctx.makeImage()
}

// MARK: - 页码选择

func parsePages(_ spec: String, pageCount: Int) -> [Int] {
    var wanted: [Int] = []
    for chunk in spec.split(separator: ",") {
        let part = chunk.trimmingCharacters(in: .whitespaces)
        if part.isEmpty { continue }
        let bounds = part.split(separator: "-", omittingEmptySubsequences: false)
        if bounds.count == 2, let a = Int(bounds[0]), let b = Int(bounds[1]) {
            guard a >= 1 else { continue }
            let hi = min(max(a, b), pageCount)
            if a <= hi { wanted.append(contentsOf: a...hi) }
        } else if let single = Int(part), single >= 1, single <= pageCount {
            wanted.append(single)
        }
    }
    var seen = Set<Int>()
    return wanted.filter { seen.insert($0).inserted }
}

// MARK: - 主流程

let opts = parseArgs()
let url = URL(fileURLWithPath: opts.path)
guard FileManager.default.fileExists(atPath: opts.path) else { fail("文件不存在: \(opts.path)") }

let ext = url.pathExtension.lowercased()
let isPDF = ext == "pdf"
var pages: [Page] = []
var kind = "image"

if isPDF {
    kind = "pdf"
    guard let provider = CGDataProvider(url: url as CFURL),
          let doc = CGPDFDocument(provider) else { fail("PDF 打不开: \(opts.path)") }
    guard !doc.isEncrypted || doc.isUnlocked else { fail("PDF 有密码保护，无法读取") }
    let pageCount = doc.numberOfPages
    guard pageCount > 0 else { fail("PDF 没有页面") }

    let wanted = opts.pages.map { parsePages($0, pageCount: pageCount) } ?? Array(1...pageCount)
    guard !wanted.isEmpty else { fail("--pages 没有选中任何有效页") }

    // 文字层走 PDFKit，栅格化走 CGPDFDocument：两条路各取所长
    let kit = opts.textLayer ? PDFDocument(url: url) : nil

    for number in wanted {
        // 路径 A：有文字层就直接抽，精确且快（不经过像素，识别错误归零）
        if let kitPage = kit?.page(at: number - 1), opts.textLayer {
            let textLines = textLayerLines(kitPage, dpi: opts.dpi)
            if textLayerUsable(textLines) {
                let box = kitPage.bounds(for: .cropBox)
                var scale = opts.dpi / 72.0
                let px = Double(box.width) * Double(box.height) * scale * scale
                if px > MAX_PAGE_PIXELS { scale *= (MAX_PAGE_PIXELS / px).squareRoot() }
                if min(Double(box.width), Double(box.height)) * scale < MIN_SIDE_PIXELS {
                    scale *= MIN_SIDE_PIXELS / (min(Double(box.width), Double(box.height)) * scale)
                }
                pages.append(Page(page: number,
                                  width: Int((Double(box.width) * scale).rounded()),
                                  height: Int((Double(box.height) * scale).rounded()),
                                  rotation: 0, source: "text-layer", lines: textLines))
                continue
            }
        }
        // 路径 B：扫描件没有文字层，渲染后做 OCR
        guard let pageRef = doc.page(at: number), let bitmap = renderPDFPage(pageRef, dpi: opts.dpi) else {
            warn("第 \(number) 页渲染失败，已跳过")
            continue
        }
        let (lines, turns) = recognizeAdaptive(bitmap, orientation: .up, opts: opts)
        pages.append(Page(page: number, width: bitmap.width, height: bitmap.height,
                          rotation: turns, source: "ocr", lines: lines))
    }
} else {
    // 用 ImageIO 直接按目标尺寸解码：先 CreateImageAtIndex 再缩会把 8000² 全解出来
    // （实测峰值 535MB），而 thumbnail 能在解码阶段就降采样。
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
        fail("图片读不出来（支持 png/jpeg/heic/tiff/webp）: \(opts.path)")
    }
    let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
    let pixelW = (props?[kCGImagePropertyPixelWidth] as? Double) ?? 0
    let pixelH = (props?[kCGImagePropertyPixelHeight] as? Double) ?? 0

    // 目标长边：既不超过 MAX_SIDE，也不超过面积上限
    var target = max(pixelW, pixelH)
    if target <= 0 { target = MAX_SIDE_PIXELS }
    target = min(target, MAX_SIDE_PIXELS)
    if pixelW * pixelH > MAX_IMAGE_PIXELS, pixelW > 0, pixelH > 0 {
        let ratio = pixelW / pixelH
        let maxLongest = (MAX_IMAGE_PIXELS * ratio).squareRoot()
        target = min(target, maxLongest)
    }

    // transform: true 顺带把 EXIF 方向烘进像素，后面统一按 .up 处理
    let thumbOptions: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: max(3, Int(target.rounded())),
    ]
    guard let upright = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbOptions as CFDictionary) else {
        fail("图片读不出来（支持 png/jpeg/heic/tiff/webp）: \(opts.path)")
    }
    let orientation: CGImagePropertyOrientation = .up
    let bitmap = normalizeSize(upright)
    let (lines, turns) = recognizeAdaptive(bitmap, orientation: orientation, opts: opts)
    pages.append(Page(page: 1, width: bitmap.width, height: bitmap.height,
                      rotation: turns, source: "ocr", lines: lines))
}

let fullText = pages.map { $0.lines.map(\.text).joined(separator: "\n") }.joined(separator: "\n\n")
let result = Result(
    engine: "Apple Vision VNRecognizeTextRequest rev\(VNRecognizeTextRequestRevision3)",
    file: opts.path, kind: kind, pageCount: pages.count,
    languages: opts.langs, pages: pages, text: fullText
)

if opts.json {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    guard let data = try? encoder.encode(result) else { fail("JSON 编码失败") }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
} else {
    print(fullText)
}
