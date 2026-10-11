import AppKit
import Combine

/// Ein auswählbares whisper.cpp-Modell (ggml-Format). Nur mehrsprachige
/// Varianten — die „.en"-Modelle verstehen kein Deutsch.
struct WhisperModel: Identifiable, Hashable {
    let id: String
    let title: String
    let sizeText: String
    let hint: String

    var filename: String { "ggml-\(id).bin" }
    var remoteURL: URL {
        URL(string: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/\(filename)")!
    }
    var localURL: URL {
        URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Application Support/Sighting/models/\(filename)")
    }
    /// Release-Builds können ein Modell direkt im App-Bundle mitliefern
    /// (siehe build-app.sh), dann ist kein Download nötig.
    var bundledURL: URL? {
        Bundle.main.resourceURL?.appendingPathComponent("models/\(filename)")
    }
    var isBundled: Bool {
        guard let url = bundledURL else { return false }
        return FileManager.default.fileExists(atPath: url.path)
    }
    /// Bevorzugt das mitgelieferte Modell, sonst das heruntergeladene.
    var availableURL: URL? {
        if isBundled { return bundledURL }
        return FileManager.default.fileExists(atPath: localURL.path) ? localURL : nil
    }

    static let all: [WhisperModel] = [
        WhisperModel(id: "tiny", title: "Tiny", sizeText: "78 MB",
                     hint: "Sehr schnell, aber für Deutsch meist zu ungenau."),
        WhisperModel(id: "base", title: "Base", sizeText: "148 MB",
                     hint: "Schnell, einfache Genauigkeit — nur für sehr klare Sprache."),
        WhisperModel(id: "small", title: "Small", sizeText: "488 MB",
                     hint: "Brauchbarer Kompromiss für klare Aufnahmen."),
        WhisperModel(id: "medium", title: "Medium", sizeText: "1,5 GB",
                     hint: "Gute Genauigkeit, deutlich langsamer als Turbo."),
        WhisperModel(id: "large-v3-turbo", title: "Large v3 Turbo", sizeText: "1,6 GB",
                     hint: "Empfohlen: nahezu Large-Qualität, aber deutlich schneller."),
        WhisperModel(id: "large-v3", title: "Large v3", sizeText: "3,1 GB",
                     hint: "Höchste Genauigkeit, am langsamsten und speicherhungrig."),
    ]
    static let `default` = all.first { $0.id == "large-v3-turbo" }!
}

/// Sprache für die Erkennung; „auto" lässt Whisper pro Aufnahme entscheiden.
struct WhisperLanguage: Identifiable, Hashable {
    let code: String
    let title: String
    var id: String { code }

    static let all: [WhisperLanguage] = [
        ("auto", "Automatisch erkennen"), ("de", "Deutsch"), ("en", "Englisch"),
        ("fr", "Französisch"), ("es", "Spanisch"), ("it", "Italienisch"),
        ("pt", "Portugiesisch"), ("nl", "Niederländisch"), ("pl", "Polnisch"),
        ("cs", "Tschechisch"), ("sk", "Slowakisch"), ("hu", "Ungarisch"),
        ("sl", "Slowenisch"), ("hr", "Kroatisch"), ("sr", "Serbisch"),
        ("ro", "Rumänisch"), ("tr", "Türkisch"), ("ru", "Russisch"),
        ("uk", "Ukrainisch"), ("ar", "Arabisch"), ("he", "Hebräisch"),
        ("hi", "Hindi"), ("zh", "Chinesisch"), ("ja", "Japanisch"),
        ("ko", "Koreanisch"), ("sv", "Schwedisch"), ("da", "Dänisch"),
        ("no", "Norwegisch"), ("fi", "Finnisch"), ("el", "Griechisch"),
    ].map { WhisperLanguage(code: $0.0, title: $0.1) }
}

/// Transkribiert Videosegmente lokal mit whisper.cpp (whisper-cli aus Homebrew).
/// Ablauf: ffmpeg extrahiert den In/Out-Bereich als 16-kHz-WAV,
/// whisper-cli transkribiert nach JSON, die Segmente landen mit
/// klickbaren Timecodes im Notizfeld.
final class WhisperService: ObservableObject {
    @Published var isRunning = false
    @Published var progressText = "Transkribiere …"
    @Published var lastError: String?
    @Published var downloadingModelID: String?
    @Published var downloadProgress: Double = 0

    /// Gewähltes Modell / gewählte Sprache; bleiben über Neustarts erhalten.
    @Published var selectedModelID: String {
        didSet { UserDefaults.standard.set(selectedModelID, forKey: "whisperModelID") }
    }
    @Published var language: String {
        didSet { UserDefaults.standard.set(language, forKey: "whisperLanguage") }
    }

    init() {
        let storedModel = UserDefaults.standard.string(forKey: "whisperModelID")
        selectedModelID = WhisperModel.all.contains { $0.id == storedModel }
            ? storedModel! : WhisperModel.default.id
        let storedLanguage = UserDefaults.standard.string(forKey: "whisperLanguage")
        language = WhisperLanguage.all.contains { $0.code == storedLanguage }
            ? storedLanguage! : "auto"
    }

    var selectedModel: WhisperModel {
        WhisperModel.all.first { $0.id == selectedModelID } ?? .default
    }
    var isDownloadingModel: Bool { downloadingModelID != nil }

    private var downloadObservation: NSKeyValueObservation?
    private var downloadTask: URLSessionDownloadTask?

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
    var modelExists: Bool { selectedModel.availableURL != nil }

    /// Was fehlt noch, bevor transkribiert werden kann?
    var setupProblem: String? {
        if whisperPath == nil {
            return "whisper-cli fehlt. Installation im Terminal: brew install whisper-cpp"
        }
        if ffmpegPath == nil {
            return "ffmpeg fehlt. Installation im Terminal: brew install ffmpeg"
        }
        if !modelExists {
            return "Das Whisper-Modell „\(selectedModel.title)“ (\(selectedModel.sizeText)) " +
                "muss einmalig geladen werden."
        }
        return nil
    }

    // MARK: Modell-Download

    func downloadModel(_ model: WhisperModel? = nil) {
        let model = model ?? selectedModel
        guard downloadingModelID == nil else { return }
        downloadingModelID = model.id
        downloadProgress = 0
        lastError = nil

        let task = URLSession.shared.downloadTask(with: model.remoteURL) { [weak self] tmp, response, error in
            // Die temporäre Datei wird nach Rückkehr dieses Handlers gelöscht —
            // deshalb hier synchron verschieben, erst danach auf den Main-Thread.
            var failure: String?
            if let error {
                if (error as NSError).code != NSURLErrorCancelled {
                    failure = "Modell-Download fehlgeschlagen: \(error.localizedDescription)"
                }
            } else if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                failure = "Modell-Download fehlgeschlagen (HTTP \(http.statusCode))."
            } else if let tmp {
                do {
                    try FileManager.default.createDirectory(
                        at: model.localURL.deletingLastPathComponent(),
                        withIntermediateDirectories: true)
                    if FileManager.default.fileExists(atPath: model.localURL.path) {
                        try FileManager.default.removeItem(at: model.localURL)
                    }
                    try FileManager.default.moveItem(at: tmp, to: model.localURL)
                } catch {
                    failure = "Modell konnte nicht gespeichert werden: \(error.localizedDescription)"
                }
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.downloadingModelID = nil
                self.downloadObservation = nil
                self.downloadTask = nil
                if let failure { self.lastError = failure }
                self.objectWillChange.send()
            }
        }
        downloadTask = task
        downloadObservation = task.progress.observe(\.fractionCompleted) { [weak self] progress, _ in
            DispatchQueue.main.async { self?.downloadProgress = progress.fractionCompleted }
        }
        task.resume()
    }

    func cancelDownload() {
        downloadTask?.cancel()
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
        guard let whisper = whisperPath, let ffmpeg = ffmpegPath,
              let model = selectedModel.availableURL else {
            completion(.failure(TranscribeError(message: setupProblem ?? "Setup unvollständig")))
            return
        }
        let languageCode = language
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
                "-m", model.path,
                "-f", wav.path,
                "-l", languageCode,
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
