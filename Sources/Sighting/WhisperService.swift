import AppKit
import Combine

/// Transkribiert Videosegmente lokal mit whisper.cpp (whisper-cli aus Homebrew).
/// Ablauf: ffmpeg extrahiert den In/Out-Bereich als 16-kHz-WAV,
/// whisper-cli transkribiert nach JSON, die Segmente landen mit
/// klickbaren Timecodes im Notizfeld.
final class WhisperService: ObservableObject {
    @Published var isRunning = false
    @Published var progressText = "Transkribiere …"
    @Published var lastError: String?
    @Published var isDownloadingModel = false
    @Published var downloadProgress: Double = 0

    static let modelURL = URL(fileURLWithPath: NSHomeDirectory())
        .appendingPathComponent("Library/Application Support/Sighting/models/ggml-large-v3-turbo.bin")
    static let remoteModelURL = URL(string:
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin")!

    private var downloadObservation: NSKeyValueObservation?

    static func findExecutable(_ name: String) -> String? {
        let candidates = [
            "/opt/homebrew/bin/\(name)",
            "/usr/local/bin/\(name)",
            "/usr/bin/\(name)",
        ]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    var whisperPath: String? { Self.findExecutable("whisper-cli") }
    var ffmpegPath: String? { Self.findExecutable("ffmpeg") }
    var modelExists: Bool { FileManager.default.fileExists(atPath: Self.modelURL.path) }

    /// Was fehlt noch, bevor transkribiert werden kann?
    var setupProblem: String? {
        if whisperPath == nil {
            return "whisper-cli fehlt. Installation im Terminal: brew install whisper-cpp"
        }
        if ffmpegPath == nil {
            return "ffmpeg fehlt. Installation im Terminal: brew install ffmpeg"
        }
        if !modelExists {
            return "Das Whisper-Modell (~1,6 GB) muss einmalig geladen werden."
        }
        return nil
    }

    // MARK: Modell-Download

    func downloadModel() {
        guard !isDownloadingModel else { return }
        isDownloadingModel = true
        downloadProgress = 0
        lastError = nil

        let task = URLSession.shared.downloadTask(with: Self.remoteModelURL) { [weak self] tmp, _, error in
            DispatchQueue.main.async {
                guard let self else { return }
                self.isDownloadingModel = false
                self.downloadObservation = nil
                if let error {
                    self.lastError = "Modell-Download fehlgeschlagen: \(error.localizedDescription)"
                    return
                }
                guard let tmp else { return }
                do {
                    try FileManager.default.createDirectory(
                        at: Self.modelURL.deletingLastPathComponent(),
                        withIntermediateDirectories: true)
                    if FileManager.default.fileExists(atPath: Self.modelURL.path) {
                        try FileManager.default.removeItem(at: Self.modelURL)
                    }
                    try FileManager.default.moveItem(at: tmp, to: Self.modelURL)
                    self.objectWillChange.send()
                } catch {
                    self.lastError = "Modell konnte nicht gespeichert werden: \(error.localizedDescription)"
                }
            }
        }
        downloadObservation = task.progress.observe(\.fractionCompleted) { [weak self] progress, _ in
            DispatchQueue.main.async { self?.downloadProgress = progress.fractionCompleted }
        }
        task.resume()
    }

    // MARK: Transkription

    struct Segment {
        let start: Double   // Sekunden, relativ zum Video
        let text: String
    }

    struct TranscribeError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    /// Transkribiert [start, end] des Videos und liefert Segmente mit
    /// Video-absoluten Timecodes.
    func transcribe(videoURL: URL, start: Double, end: Double,
                    completion: @escaping (Result<[Segment], TranscribeError>) -> Void) {
        guard let whisper = whisperPath, let ffmpeg = ffmpegPath, modelExists else {
            completion(.failure(TranscribeError(message: setupProblem ?? "Setup unvollständig")))
            return
        }
        isRunning = true
        progressText = "Extrahiere Audio …"
        lastError = nil

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let finish: (Result<[Segment], TranscribeError>) -> Void = { result in
                DispatchQueue.main.async {
                    self?.isRunning = false
                    if case .failure(let error) = result { self?.lastError = error.message }
                    completion(result)
                }
            }

            let tmpDir = FileManager.default.temporaryDirectory
                .appendingPathComponent("sighting-\(UUID().uuidString)")
            try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: tmpDir) }
            let wav = tmpDir.appendingPathComponent("segment.wav")

            // 1. Audio-Segment extrahieren
            let ffmpegResult = Self.run(ffmpeg, [
                "-hide_banner", "-loglevel", "error", "-nostdin",
                "-ss", String(start), "-to", String(end),
                "-i", videoURL.path,
                "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
                wav.path,
            ])
            guard ffmpegResult.status == 0 else {
                finish(.failure(TranscribeError(message: "ffmpeg-Fehler: \(ffmpegResult.stderr.suffix(400))")))
                return
            }

            // 2. Whisper laufen lassen
            DispatchQueue.main.async { self?.progressText = "Transkribiere … 0 %" }
            let outBase = tmpDir.appendingPathComponent("transcript").path
            let whisperResult = Self.run(whisper, [
                "-m", Self.modelURL.path,
                "-f", wav.path,
                "-l", "auto",
                "-oj", "-of", outBase,
                "--print-progress",
            ]) { line in
                if let range = line.range(of: "progress ="),
                   let percent = line[range.upperBound...]
                       .split(separator: "%").first
                       .flatMap({ Int($0.trimmingCharacters(in: .whitespaces)) }) {
                    DispatchQueue.main.async {
                        self?.progressText = "Transkribiere … \(percent) %"
                    }
                }
            }
            guard whisperResult.status == 0 else {
                finish(.failure(TranscribeError(message: "Whisper-Fehler: \(whisperResult.stderr.suffix(400))")))
                return
            }

            // 3. JSON parsen
            let jsonURL = URL(fileURLWithPath: outBase + ".json")
            guard let data = try? Data(contentsOf: jsonURL),
                  let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let entries = root["transcription"] as? [[String: Any]] else {
                finish(.failure(TranscribeError(message: "Whisper-Ausgabe konnte nicht gelesen werden.")))
                return
            }
            let segments: [Segment] = entries.compactMap { entry in
                guard let text = (entry["text"] as? String)?
                        .trimmingCharacters(in: .whitespaces),
                      !text.isEmpty,
                      let offsets = entry["offsets"] as? [String: Any],
                      let fromMS = (offsets["from"] as? NSNumber)?.doubleValue
                else { return nil }
                return Segment(start: start + fromMS / 1000.0, text: text)
            }
            finish(.success(segments))
        }
    }

    // MARK: Prozess-Helfer

    private struct RunResult {
        let status: Int32
        let stdout: String
        let stderr: String
    }

    private static func run(_ launchPath: String, _ arguments: [String],
                            onStderrLine: ((String) -> Void)? = nil) -> RunResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: launchPath)
        process.arguments = arguments

        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe

        var stderrData = Data()
        let stderrLock = NSLock()
        errPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { return }
            stderrLock.lock()
            stderrData.append(chunk)
            stderrLock.unlock()
            if let onStderrLine, let text = String(data: chunk, encoding: .utf8) {
                text.split(separator: "\n").forEach { onStderrLine(String($0)) }
            }
        }

        do {
            try process.run()
        } catch {
            return RunResult(status: -1, stdout: "", stderr: error.localizedDescription)
        }
        let stdoutData = outPipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        errPipe.fileHandleForReading.readabilityHandler = nil

        stderrLock.lock()
        let stderr = String(data: stderrData, encoding: .utf8) ?? ""
        stderrLock.unlock()
        return RunResult(
            status: process.terminationStatus,
            stdout: String(data: stdoutData, encoding: .utf8) ?? "",
            stderr: stderr
        )
    }
}
