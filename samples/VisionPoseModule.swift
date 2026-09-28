// Excerpt from Aswell (private repo), shown for portfolio review.
// (c) 2026 Alperen Sirli. All rights reserved.

import ExpoModulesCore
import ImageIO
import Vision

// Apple Vision body pose, on device. JS passes a photo's file uri, we return
// each joint we found as normalized coordinates (0-1, origin top-left, same as
// the app uses) plus a confidence. Nothing leaves the phone.

final class ImageLoadException: Exception, @unchecked Sendable {
  override var reason: String { "Could not read the photo for pose detection" }
}

public class VisionPoseModule: Module {
  public func definition() -> ModuleDefinition {
    Name("VisionPose")

    // Can body pose actually run here? The iOS Simulator has Vision but not
    // its body-pose model, so the only honest answer is to try it once.
    AsyncFunction("isAvailable") { () async -> Bool in
      return bodyPoseWorks()
    }

    AsyncFunction("detectPose") { (uri: String) async throws -> [String: Any] in
      return try detectPose(uri: uri)
    }
  }
}

// Vision's joint names → the app's JointName strings.
private let jointNames: [VNHumanBodyPoseObservation.JointName: String] = [
  .nose: "nose", .neck: "neck", .root: "root",
  .leftEye: "leftEye", .rightEye: "rightEye",
  .leftEar: "leftEar", .rightEar: "rightEar",
  .leftShoulder: "leftShoulder", .rightShoulder: "rightShoulder",
  .leftElbow: "leftElbow", .rightElbow: "rightElbow",
  .leftWrist: "leftWrist", .rightWrist: "rightWrist",
  .leftHip: "leftHip", .rightHip: "rightHip",
  .leftKnee: "leftKnee", .rightKnee: "rightKnee",
  .leftAnkle: "leftAnkle", .rightAnkle: "rightAnkle",
]

// Runs the request on a tiny blank image. There's no body in it, so a working
// setup just finds nothing. A missing model throws instead.
private func bodyPoseWorks() -> Bool {
  let size = 64
  guard let ctx = CGContext(
    data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue),
    let image = ctx.makeImage() else { return false }

  do {
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([VNDetectHumanBodyPoseRequest()])
    return true
  } catch {
    return false
  }
}

private func detectPose(uri: String) throws -> [String: Any] {
  let url = URL(string: uri).flatMap { $0.scheme == nil ? nil : $0 } ?? URL(fileURLWithPath: uri)
  guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    throw ImageLoadException()
  }

  // JS already bakes orientation into the JPEG, so this is normally "up".
  // Reading it anyway keeps the coordinates right if an unbaked photo slips in.
  let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
  let rawOrientation = props?[kCGImagePropertyOrientation] as? UInt32 ?? 1
  let orientation = CGImagePropertyOrientation(rawValue: rawOrientation) ?? .up
  // Orientations 5-8 are rotated 90°, so width and height swap.
  let rotated = (5...8).contains(rawOrientation)
  let width = rotated ? image.height : image.width
  let height = rotated ? image.width : image.height

  let request = VNDetectHumanBodyPoseRequest()
  let handler = VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:])
  try handler.perform([request])

  var joints: [String: [String: Double]] = [:]
  if let body = request.results?.first,
     let points = try? body.recognizedPoints(.all) {
    for (joint, point) in points where point.confidence > 0 {
      guard let name = jointNames[joint] else { continue }
      joints[name] = [
        "x": Double(point.location.x),
        // Vision's origin is bottom-left; the app's is top-left.
        "y": Double(1 - point.location.y),
        "confidence": Double(point.confidence),
      ]
    }
  }

  return ["width": width, "height": height, "joints": joints]
}
