import AppKit
import AVFoundation

/// Exportiert Video + Marker als Final-Cut-Pro-XML (xmeml) und die
/// Transkription als SRT-Untertiteldatei. Premiere Pro importiert xmeml
/// nativ über „Datei > Importieren" als Sequence mit dem Videoclip und
/// Markern; die SRT lässt sich separat als Untertitel-/Transkriptspur
/// dazuladen. Bewusst kein natives .prproj — dessen Binärformat ist
/// unveröffentlicht und ändert sich mit jeder Premiere-Version.
enum PremiereExportService {

    static func export(to xmlURL: URL, project: ProjectStore, player: PlayerController) throws {
        guard let videoURL = player.videoURL else {
            throw NSError(domain: "Sighting", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Kein Video geladen.",
            ])
        }

        let asset = AVURLAsset(url: videoURL)
        let videoTrack = asset.tracks(withMediaType: .video).first
        let rawFps = videoTrack.map { Double($0.nominalFrameRate) } ?? 25.0
        let fps = Int(rawFps.rounded()) > 0 ? Int(rawFps.rounded()) : 25
        let size = videoTrack?.naturalSize ?? CGSize(width: 1920, height: 1080)
        let durationSeconds = player.duration > 0 ? player.duration : asset.duration.seconds
        let totalFrames = max(1, Int((durationSeconds * Double(fps)).rounded()))

        let xml = buildXML(videoURL: videoURL, width: abs(Int(size.width)), height: abs(Int(size.height)),
                           fps: fps, totalFrames: totalFrames, markers: project.markers)
        try xml.data(using: .utf8)!.write(to: xmlURL)

        let srtURL = xmlURL.deletingPathExtension().appendingPathExtension("srt")
        let transcriptBlocks = ExportService.noteBlocks(from: project.textStorage)
            .filter { $0.isTranscript }
        try buildSRT(blocks: transcriptBlocks, maxEnd: durationSeconds).data(using: .utf8)!.write(to: srtURL)
    }

    // MARK: FCP XML (xmeml v5)

    private static func xmlEscape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }

    private static func buildXML(videoURL: URL, width: Int, height: Int, fps: Int,
                                 totalFrames: Int, markers: [Marker]) -> String {
        let name = xmlEscape(videoURL.deletingPathExtension().lastPathComponent)
        let fileName = xmlEscape(videoURL.lastPathComponent)
        let pathURL = xmlEscape(videoURL.absoluteString)

        var markersXML = ""
        for marker in markers.sorted(by: { $0.time < $1.time }) {
            let title = Marker.palette.first(where: { $0.name == marker.colorName })?.title ?? "Marker"
            let frame = Int((marker.time * Double(fps)).rounded())
            markersXML += """

      <marker>
        <name>\(xmlEscape(title))</name>
        <comment>\(xmlEscape(marker.label))</comment>
        <in>\(frame)</in>
        <out>-1</out>
      </marker>
"""
        }

        return """
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
  <sequence>
    <name>\(name)</name>
    <duration>\(totalFrames)</duration>
    <rate>
      <timebase>\(fps)</timebase>
      <ntsc>FALSE</ntsc>
    </rate>
    <media>
      <video>
        <track>
          <clipitem id="clipitem-1">
            <name>\(fileName)</name>
            <duration>\(totalFrames)</duration>
            <rate>
              <timebase>\(fps)</timebase>
              <ntsc>FALSE</ntsc>
            </rate>
            <start>0</start>
            <end>\(totalFrames)</end>
            <in>0</in>
            <out>\(totalFrames)</out>
            <file id="file-1">
              <name>\(fileName)</name>
              <pathurl>\(pathURL)</pathurl>
              <rate>
                <timebase>\(fps)</timebase>
                <ntsc>FALSE</ntsc>
              </rate>
              <duration>\(totalFrames)</duration>
              <media>
                <video>
                  <samplecharacteristics>
                    <width>\(width)</width>
                    <height>\(height)</height>
                  </samplecharacteristics>
                </video>
                <audio>
                  <channelcount>2</channelcount>
                </audio>
              </media>
            </file>
          </clipitem>
        </track>
      </video>
      <audio>
        <track>
          <clipitem id="clipitem-2">
            <name>\(fileName)</name>
            <duration>\(totalFrames)</duration>
            <rate>
              <timebase>\(fps)</timebase>
              <ntsc>FALSE</ntsc>
            </rate>
            <start>0</start>
            <end>\(totalFrames)</end>
            <in>0</in>
            <out>\(totalFrames)</out>
            <file id="file-1"/>
          </clipitem>
        </track>
      </audio>
    </media>\(markersXML)
  </sequence>
</xmeml>
"""
    }

    // MARK: SRT

    private static func buildSRT(blocks: [ExportService.NoteBlock], maxEnd: Double) -> String {
        guard !blocks.isEmpty else { return "" }
        let sorted = blocks.sorted { $0.time < $1.time }
        var out = ""
        for (index, block) in sorted.enumerated() {
            let minEnd = block.time + 0.5
            let end = index + 1 < sorted.count
                ? max(minEnd, min(sorted[index + 1].time, block.time + 8))
                : max(minEnd, min(block.time + 4, maxEnd))
            out += "\(index + 1)\n"
            out += "\(srtTimestamp(block.time)) --> \(srtTimestamp(end))\n"
            out += "\(block.text)\n\n"
        }
        return out
    }

    private static func srtTimestamp(_ seconds: Double) -> String {
        let totalMS = Int((seconds * 1000).rounded())
        let ms = totalMS % 1000
        let totalSeconds = totalMS / 1000
        let s = totalSeconds % 60
        let m = (totalSeconds / 60) % 60
        let h = totalSeconds / 3600
        return String(format: "%02d:%02d:%02d,%03d", h, m, s, ms)
    }
}
