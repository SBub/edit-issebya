// vseg: the person mask of one span of a footage file, for the cut-out step.
//
//   vseg --input <mp4> --start <s> --end <s> --output <mp4>
//
// Reads the footage's frames over [start, end) at their own sample times, runs
// Apple Vision person segmentation at accurate quality on each, scales the mask
// to the footage's natural size and writes it as a grayscale H.264 file
// (white = person, the chroma planes neutral) through VideoToolbox. Each mask
// frame sits at its source frame's time minus start, so frame i of the mask
// lines up with the footage frame at start + i / fps. Written to
// <output>.part, renamed to <output> once finished.
//
// Progress goes to stderr as `vseg: frame <i>/<n>`; any failure exits non-zero
// with one line. macOS only (Vision); built by scripts/build-vseg.sh.

import AVFoundation
import CoreImage
import CoreVideo
import Foundation
import Vision

func fail(_ reason: String) -> Never {
  FileHandle.standardError.write("vseg: \(reason)\n".data(using: .utf8)!)
  exit(1)
}

struct Options {
  var input = ""
  var start = 0.0
  var end = 0.0
  var output = ""
}

func parseOptions(_ args: [String]) -> Options {
  var options = Options()
  var seen = Set<String>()
  var index = 0
  while index < args.count {
    let name = args[index]
    guard index + 1 < args.count else { fail("missing value for \(name)") }
    let value = args[index + 1]
    switch name {
    case "--input": options.input = value
    case "--output": options.output = value
    case "--start":
      guard let number = Double(value), number >= 0 else { fail("bad --start \(value)") }
      options.start = number
    case "--end":
      guard let number = Double(value), number > 0 else { fail("bad --end \(value)") }
      options.end = number
    default: fail("unknown argument \(name)")
    }
    seen.insert(name)
    index += 2
  }
  for name in ["--input", "--start", "--end", "--output"] where !seen.contains(name) {
    fail("missing \(name)")
  }
  if options.end <= options.start { fail("--end must be after --start") }
  return options
}

// Mask value 0...255 to video-range luma 16...235, so a player decodes the
// mask back to its full 0...255 range.
let lumaOf: [UInt8] = (0...255).map { (value: Int) -> UInt8 in
  let scaled: Int = (value * 219 + 127) / 255
  return UInt8(16 + scaled)
}

func run() {
  let options = parseOptions(Array(CommandLine.arguments.dropFirst()))
  let inputURL = URL(fileURLWithPath: options.input)
  let outputURL = URL(fileURLWithPath: options.output)
  let partURL = URL(fileURLWithPath: options.output + ".part")
  try? FileManager.default.removeItem(at: partURL)

  let asset = AVURLAsset(url: inputURL)
  guard let track = asset.tracks(withMediaType: .video).first else {
    fail("no video track in \(options.input)")
  }
  let size = track.naturalSize
  let width = Int(size.width.rounded())
  let height = Int(size.height.rounded())
  if width <= 0 || height <= 0 { fail("bad video size \(width)x\(height)") }
  let fps = track.nominalFrameRate > 0 ? Double(track.nominalFrameRate) : 30
  let total = max(1, Int(((options.end - options.start) * fps).rounded()))

  // A span edge given to the millisecond lands on the frame it names: within a
  // quarter frame of a frame time, it is that frame time exactly (600000 is a
  // multiple of every common frame rate), so the first mask frame is the
  // footage frame at start and none is doubled.
  let timescale: CMTimeScale = 600_000
  func onGrid(_ seconds: Double) -> CMTime {
    let frames = seconds * fps
    let nearest = frames.rounded()
    let snapped = abs(frames - nearest) < 0.25 ? nearest / fps : seconds
    return CMTime(value: CMTimeValue((snapped * Double(timescale)).rounded()), timescale: timescale)
  }
  let start = onGrid(options.start)
  let end = onGrid(options.end)

  let reader: AVAssetReader
  do { reader = try AVAssetReader(asset: asset) } catch { fail("cannot read \(options.input): \(error)") }
  reader.timeRange = CMTimeRange(start: start, end: end)
  let readerOutput = AVAssetReaderTrackOutput(
    track: track,
    outputSettings: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    ])
  readerOutput.alwaysCopiesSampleData = false
  guard reader.canAdd(readerOutput) else { fail("cannot decode the video track") }
  reader.add(readerOutput)

  let writer: AVAssetWriter
  do { writer = try AVAssetWriter(outputURL: partURL, fileType: .mp4) } catch {
    fail("cannot write \(partURL.path): \(error)")
  }
  let writerInput = AVAssetWriterInput(
    mediaType: .video,
    outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: width,
      AVVideoHeightKey: height,
      AVVideoColorPropertiesKey: [
        AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
        AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
        AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
      ],
      AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: 6_000_000,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        AVVideoMaxKeyFrameIntervalKey: Int(fps.rounded()),
      ],
    ])
  writerInput.expectsMediaDataInRealTime = false
  let adaptor = AVAssetWriterInputPixelBufferAdaptor(
    assetWriterInput: writerInput,
    sourcePixelBufferAttributes: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      kCVPixelBufferWidthKey as String: width,
      kCVPixelBufferHeightKey as String: height,
    ])
  guard writer.canAdd(writerInput) else { fail("cannot add the H.264 track") }
  writer.add(writerInput)

  guard reader.startReading() else {
    fail("cannot start reading: \(reader.error.map { "\($0)" } ?? "unknown")")
  }
  guard writer.startWriting() else {
    fail("cannot start writing: \(writer.error.map { "\($0)" } ?? "unknown")")
  }
  writer.startSession(atSourceTime: .zero)

  // No colour management: the mask's values pass through untouched.
  let context = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull()])
  var scaled: CVPixelBuffer?
  CVPixelBufferCreate(
    kCFAllocatorDefault, width, height, kCVPixelFormatType_OneComponent8,
    [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary, &scaled)
  guard let scaledBuffer = scaled else { fail("cannot allocate the scaled mask") }

  let request = VNGeneratePersonSegmentationRequest()
  request.qualityLevel = .accurate
  request.outputPixelFormat = kCVPixelFormatType_OneComponent8

  var written = 0
  var last = CMTime.zero
  while let sample = readerOutput.copyNextSampleBuffer() {
    let time = CMSampleBufferGetPresentationTimeStamp(sample)
    // The reader gives the frame showing at start the time start; anything
    // not after the last written frame or at the end is not part of the span.
    let at = CMTimeMaximum(.zero, CMTimeSubtract(time, start))
    if written > 0 && CMTimeCompare(at, last) <= 0 { continue }
    if CMTimeCompare(time, end) >= 0 { break }
    guard let frame = CMSampleBufferGetImageBuffer(sample) else { fail("a frame without an image") }

    let handler = VNImageRequestHandler(cvPixelBuffer: frame, options: [:])
    do { try handler.perform([request]) } catch { fail("segmentation failed: \(error)") }
    guard let mask = request.results?.first?.pixelBuffer else { fail("segmentation gave no mask") }

    let maskWidth = CGFloat(CVPixelBufferGetWidth(mask))
    let maskHeight = CGFloat(CVPixelBufferGetHeight(mask))
    let image = CIImage(cvPixelBuffer: mask, options: [.colorSpace: NSNull()])
      .transformed(
        by: CGAffineTransform(
          scaleX: CGFloat(width) / maskWidth, y: CGFloat(height) / maskHeight))
    context.render(
      image, to: scaledBuffer, bounds: CGRect(x: 0, y: 0, width: width, height: height),
      colorSpace: nil)

    guard let pool = adaptor.pixelBufferPool else {
      fail("no writer buffer pool: \(writer.error.map { "\($0)" } ?? "unknown")")
    }
    var out: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &out)
    guard let outBuffer = out else { fail("cannot allocate an output frame") }

    CVPixelBufferLockBaseAddress(scaledBuffer, .readOnly)
    CVPixelBufferLockBaseAddress(outBuffer, [])
    let source = CVPixelBufferGetBaseAddress(scaledBuffer)!.assumingMemoryBound(to: UInt8.self)
    let sourceStride = CVPixelBufferGetBytesPerRow(scaledBuffer)
    let luma = CVPixelBufferGetBaseAddressOfPlane(outBuffer, 0)!.assumingMemoryBound(to: UInt8.self)
    let lumaStride = CVPixelBufferGetBytesPerRowOfPlane(outBuffer, 0)
    for y in 0..<height {
      let from = source + y * sourceStride
      let to = luma + y * lumaStride
      for x in 0..<width { to[x] = lumaOf[Int(from[x])] }
    }
    let chroma = CVPixelBufferGetBaseAddressOfPlane(outBuffer, 1)!
    let chromaStride = CVPixelBufferGetBytesPerRowOfPlane(outBuffer, 1)
    memset(chroma, 128, chromaStride * CVPixelBufferGetHeightOfPlane(outBuffer, 1))
    CVPixelBufferUnlockBaseAddress(outBuffer, [])
    CVPixelBufferUnlockBaseAddress(scaledBuffer, .readOnly)

    while !writerInput.isReadyForMoreMediaData { usleep(2_000) }
    guard adaptor.append(outBuffer, withPresentationTime: at) else {
      fail("cannot write frame \(written + 1): \(writer.error.map { "\($0)" } ?? "unknown")")
    }
    written += 1
    last = at
    FileHandle.standardError.write("vseg: frame \(written)/\(total)\n".data(using: .utf8)!)
  }
  if reader.status == .failed {
    fail("reading failed: \(reader.error.map { "\($0)" } ?? "unknown")")
  }
  if written == 0 { fail("no frames between \(options.start) and \(options.end)") }

  writerInput.markAsFinished()
  let done = DispatchSemaphore(value: 0)
  writer.finishWriting { done.signal() }
  done.wait()
  guard writer.status == .completed else {
    fail("writing failed: \(writer.error.map { "\($0)" } ?? "unknown")")
  }
  try? FileManager.default.removeItem(at: outputURL)
  do { try FileManager.default.moveItem(at: partURL, to: outputURL) } catch {
    fail("cannot rename \(partURL.path): \(error)")
  }
}

run()
