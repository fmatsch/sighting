import Foundation

/// Schnitterkennung über den Szenen-Score von ffmpeg (`select='gt(scene,x)'`).
/// Liefert Zeitpunkte, an denen ein neuer Shot beginnt.
enum SceneDetection {
    struct Shot {
        let start: Double
        let end: Double
    }

    struct DetectionError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    /// Kürzer als das darf ein Shot nicht sein — verhindert Mehrfach-Treffer
    /// bei Blitzen, Überblendungen oder Kompressionsartefakten.
    static let minShotLength = 1.0

    /// Blockierend — auf einem Hintergrund-Thread aufrufen. `progress` liefert
    /// 0…1, `isCancelled` wird regelmäßig abgefragt.
    static func detectShots(ffmpeg: String, videoURL: URL, start: Double, end: Double,
                            threshold: Double,
                            progress: @escaping (Double) -> Void,
                            isCancelled: @escaping () -> Bool) -> Result<[Shot], DetectionError> {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: ffmpeg)
        process.arguments = [
            "-hide_banner", "-nostdin", "-stats", "-an", "-sn",
            "-ss", String(start), "-to", String(end),
            "-i", videoURL.path,
            // Verkleinern macht die Analyse bei HD/UHD-Material deutlich schneller.
            "-vf", "scale=320:-2,select='gt(scene,\(threshold))',showinfo",
            "-f", "null", "-",
        ]
        let errPipe = Pipe()
        process.standardError = errPipe
        process.standardOutput = FileHandle.nullDevice

        let lock = NSLock()
        var buffer = ""
        var cuts: [Double] = []
        var tail = ""   // letzte Zeilen für Fehlermeldungen
        let span = max(end - start, 0.001)

        func handle(line: String) {
            if let r = line.range(of: #"pts_time:([0-9.]+)"#, options: .regularExpression) {
                let value = line[r].dropFirst("pts_time:".count)
                if let t = Double(value) { cuts.append(start + t) }
            } else if let r = line.range(of: #"time=(\d+):(\d+):(\d+(\.\d+)?)"#, options: .regularExpression) {
                let parts = line[r].dropFirst("time=".count).split(separator: ":")
                if parts.count == 3, let h = Double(parts[0]), let m = Double(parts[1]),
                   let s = Double(parts[2]) {
                    progress(min(1, (h * 3600 + m * 60 + s) / span))
                }
            }
            tail = String((tail + "\n" + line).suffix(400))
        }

        errPipe.fileHandleForReading.readabilityHandler = { handle_ in
            let chunk = handle_.availableData
            guard !chunk.isEmpty, let text = String(data: chunk, encoding: .utf8) else { return }
            lock.lock()
            buffer += text
            // ffmpeg trennt Statuszeilen mit \r, Filterausgaben mit \n.
            var pieces = buffer.components(separatedBy: CharacterSet(charactersIn: "\r\n"))
            buffer = pieces.removeLast()
            pieces.filter { !$0.isEmpty }.forEach(handle(line:))
            lock.unlock()
        }

        do {
            try process.run()
        } catch {
            errPipe.fileHandleForReading.readabilityHandler = nil
            return .failure(DetectionError(message: "ffmpeg konnte nicht gestartet werden: \(error.localizedDescription)"))
        }
        while process.isRunning {
            if isCancelled() { process.terminate() }
            Thread.sleep(forTimeInterval: 0.2)
        }
        process.waitUntilExit()
        errPipe.fileHandleForReading.readabilityHandler = nil

        if isCancelled() { return .success([]) }
        lock.lock()
        let finalTail = tail
        let found = cuts
        lock.unlock()
        guard process.terminationStatus == 0 else {
            return .failure(DetectionError(message: "Schnitterkennung fehlgeschlagen: \(finalTail.suffix(300))"))
        }
        return .success(shots(from: found, start: start, end: end))
    }

    /// Wandelt Schnittzeitpunkte in Shots um; zu kurze Shots werden verschluckt.
    static func shots(from cuts: [Double], start: Double, end: Double) -> [Shot] {
        var starts: [Double] = [start]
        for cut in cuts.sorted() {
            guard cut - (starts.last ?? start) >= minShotLength, end - cut >= minShotLength else { continue }
            starts.append(cut)
        }
        return starts.enumerated().map { index, s in
            Shot(start: s, end: index + 1 < starts.count ? starts[index + 1] : end)
        }
    }
}
