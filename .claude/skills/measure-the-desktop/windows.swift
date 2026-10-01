import CoreGraphics
import Foundation
// Every on-screen window front to back with its position in that order, layer
// included. No titles: those need Screen Recording; owner, layer, bounds do not.
let want = CommandLine.arguments.dropFirst().first
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
var n = 0
var z = -1
for w in list {
  z += 1
  let layer = w[kCGWindowLayer as String] as? Int ?? -1
  let owner = w[kCGWindowOwnerName as String] as? String ?? "?"
  let pid = w[kCGWindowOwnerPID as String] as? Int ?? 0
  let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
  if layer == 0 {
    if want == nil || owner == want! || n < 3 { print("z\(z)\t\(owner)\tpid=\(pid)\tlayer=\(layer)\t\(b["Width"] ?? 0)x\(b["Height"] ?? 0)@\(b["X"] ?? 0),\(b["Y"] ?? 0)") }
    n += 1
  } else if let o = want, owner == o {
    print("z\(z)\t\(owner)\tpid=\(pid)\tlayer=\(layer)\t\(b["Width"] ?? 0)x\(b["Height"] ?? 0)@\(b["X"] ?? 0),\(b["Y"] ?? 0)")
  }
}
