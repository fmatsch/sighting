import AVFoundation
import AppKit
import Combine

/// Kapselt den AVPlayer: Öffnen, Seek, Geschwindigkeit, Frame-Stepping,
/// In/Out-Punkte und Thumbnail-Erzeugung für die Notizen.
final class PlayerController: ObservableObject {
    let player = AVPlayer()

    @Published var videoURL: URL?
    @Published var duration: Double = 0
    @Published var currentTime: Double = 0
    @Published var isPlaying = false
    @Published var playbackRate: Float = 1.0
    @Published var inPoint: Double?
    @Published var outPoint: Double?
    @Published var isImporting = false
    @Published var importError: String?

    private var timeObserver: Any?
    private var statusCancellable: AnyCancellable?
    private var imageGenerator: AVAssetImageGenerator?
    private var importTempDir: URL?

    /// Containerformate, die AVFoundation nicht selbst demuxen kann und die
    /// erst verlustfrei nach .mov umgepackt werden müssen (z. B. XDCAM-MXF).
    private static let needsRemux: Set<String> = ["mxf"]

    static let availableRates: [Float] = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]

    init() {
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(value: 1, timescale: 10),
            queue: .main
        ) { [weak self] time in
            self?.currentTime = time.seconds.isFinite ? time.seconds : 0
        }
        statusCancellable = player.publisher(for: \.timeControlStatus)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                self?.isPlaying = (status != .paused)
            }
    }

    deinit {
        if let timeObserver { player.removeTimeObserver(timeObserver) }
        if let importTempDir { try? FileManager.default.removeItem(at: importTempDir) }
    }

    func open(url: URL) {
        importError = nil
        if Self.needsRemux.contains(url.pathExtension.lowercased()) {
            importAndOpen(sourceURL: url)
        } else {
            loadAsset(playableURL: url, sourceURL: url)
        }
    }

    /// Verpackt Container wie MXF verlustfrei (kein Re-Encode) in .mov um,
    /// da AVFoundation solche Container nicht selbst öffnen kann — den
    /// enthaltenen Codec (z. B. XDCAM-MPEG-2) beherrscht es hingegen.
    private func importAndOpen(sourceURL: URL) {
        guard let ffmpeg = WhisperService.findExecutable("ffmpeg") else {
            importError = "Für \(sourceURL.pathExtension.uppercased())-Dateien wird ffmpeg benötigt. " +
                "Installation im Terminal: brew install ffmpeg"
            return
        }

        if let previous = importTempDir {
            try? FileManager.default.removeItem(at: previous)
        }
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("sighting-import-\(UUID().uuidString)")
        importTempDir = tmpDir
        let outputURL = tmpDir.appendingPathComponent(
            sourceURL.deletingPathExtension().lastPathComponent + ".mov")

        isImporting = true

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)

            let process = Process()
            process.executableURL = URL(fileURLWithPath: ffmpeg)
            process.arguments = [
                "-hide_banner", "-loglevel", "error", "-y",
                "-i", sourceURL.path, "-c", "copy", outputURL.path,
            ]
            let errPipe = Pipe()
            process.standardError = errPipe

            do {
                try process.run()
            } catch {
                DispatchQueue.main.async {
                    self?.isImporting = false
                    self?.importError = "Import fehlgeschlagen: \(error.localizedDescription)"
                }
                return
            }
            process.waitUntilExit()
            let errText = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

            DispatchQueue.main.async {
                self?.isImporting = false
                guard process.terminationStatus == 0,
                      FileManager.default.fileExists(atPath: outputURL.path) else {
                    self?.importError = "Die Datei „\(sourceURL.lastPathComponent)“ konnte nicht gelesen werden." +
                        (errText.isEmpty ? "" : "\n\(errText.suffix(300))")
                    return
                }
                self?.loadAsset(playableURL: outputURL, sourceURL: sourceURL)
            }
        }
    }

    private func loadAsset(playableURL: URL, sourceURL: URL) {
        let asset = AVURLAsset(url: playableURL)
        videoURL = sourceURL
        inPoint = nil
        outPoint = nil
        duration = 0
        currentTime = 0
        player.replaceCurrentItem(with: AVPlayerItem(asset: asset))

        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 480, height: 480)
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        imageGenerator = generator

        Task { @MainActor in
            do {
                let d = try await asset.load(.duration)
                if d.seconds.isFinite { self.duration = d.seconds }
            } catch {
                self.importError = "Video konnte nicht geöffnet werden: \(error.localizedDescription)"
            }
        }
    }

    // MARK: Wiedergabe

    func togglePlay() {
        if isPlaying { pause() } else { play() }
    }

    func play() {
        guard player.currentItem != nil else { return }
        player.rate = playbackRate
    }

    func pause() {
        player.pause()
    }

    /// L-Taste: abspielen bzw. Geschwindigkeit erhöhen (1 → 1,25 → 1,5 → 2 → 1 …)
    func playFasterCycle() {
        guard player.currentItem != nil else { return }
        if !isPlaying {
            playbackRate = 1.0
            play()
            return
        }
        let cycle: [Float] = [1.0, 1.25, 1.5, 2.0]
        let idx = cycle.firstIndex(where: { abs($0 - playbackRate) < 0.01 }) ?? 0
        playbackRate = cycle[(idx + 1) % cycle.count]
        player.rate = playbackRate
    }

    func setRate(_ rate: Float) {
        playbackRate = rate
        if isPlaying { player.rate = rate }
    }

    // MARK: Navigation

    func seek(to seconds: Double, exact: Bool = true) {
        guard player.currentItem != nil else { return }
        let clamped = max(0, min(seconds, duration > 0 ? duration : seconds))
        let time = CMTime(seconds: clamped, preferredTimescale: 600)
        if exact {
            player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero)
        } else {
            player.seek(to: time)
        }
        currentTime = clamped
    }

    func skip(by seconds: Double) {
        seek(to: currentTime + seconds)
    }

    func stepFrames(_ count: Int) {
        pause()
        player.currentItem?.step(byCount: count)
    }

    // MARK: In/Out

    func setInPoint() { inPoint = currentTime; normalizeRange() }
    func setOutPoint() { outPoint = currentTime; normalizeRange() }
    func clearInOut() { inPoint = nil; outPoint = nil }

    private func normalizeRange() {
        if let i = inPoint, let o = outPoint, i > o {
            swap(&inPoint, &outPoint)
        }
    }

    var selectedRange: (start: Double, end: Double)? {
        guard let i = inPoint, let o = outPoint, o > i else { return nil }
        return (i, o)
    }

    // MARK: Thumbnails

    /// Erzeugt synchron ein kleines Standbild an der angegebenen Position.
    func thumbnail(at seconds: Double) -> NSImage? {
        guard let generator = imageGenerator else { return nil }
        let time = CMTime(seconds: seconds, preferredTimescale: 600)
        guard let cg = try? generator.copyCGImage(at: time, actualTime: nil) else { return nil }
        return NSImage(cgImage: cg, size: .zero)
    }
}

/// Formatiert Sekunden als HH:MM:SS.
func formatTimecode(_ seconds: Double) -> String {
    let total = Int(seconds.rounded(.down))
    return String(format: "%02d:%02d:%02d", total / 3600, (total % 3600) / 60, total % 60)
}

/// Parst "HH:MM:SS" zurück in Sekunden.
func parseTimecode(_ string: String) -> Double? {
    let parts = string.split(separator: ":").compactMap { Double($0) }
    guard parts.count == 3 else { return nil }
    return parts[0] * 3600 + parts[1] * 60 + parts[2]
}
