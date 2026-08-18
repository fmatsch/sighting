import AppKit
import SwiftUI
import UniformTypeIdentifiers

extension NSAttributedString.Key {
    /// Markiert transkribierte Absätze (für den CSV-Export).
    static let sightingTranscript = NSAttributedString.Key("SightingTranscript")
}

/// Verbindet Player, Projekt und Whisper; enthält Menü-Aktionen und Dialoge.
final class AppModel: ObservableObject {
    static var shared: AppModel!

    let project: ProjectStore
    let player: PlayerController
    let transcription: WhisperService

    @Published var showMarkerList = true
    @Published var showWhisperSetup = false
    @Published var alertMessage: String?

    private var keyMonitor: Any?

    init(project: ProjectStore, player: PlayerController, transcription: WhisperService) {
        self.project = project
        self.player = player
        self.transcription = transcription
        AppModel.shared = self
    }

    // MARK: Datei-Aktionen

    func openVideoPanel() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.audiovisualContent]
        panel.message = "Video zum Sichten auswählen"
        if panel.runModal() == .OK, let url = panel.url {
            openVideo(url: url)
        }
    }

    func openVideo(url: URL) {
        player.open(url: url)
        project.isDirty = true
    }

    func newProject() {
        guard confirmDiscardIfNeeded() else { return }
        project.newProject(player: player)
    }

    func openProjectPanel() {
        guard confirmDiscardIfNeeded() else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowedContentTypes = [.sightingProject]
        panel.message = "Ein .sighting-Projekt auswählen"
        if panel.runModal() == .OK, let url = panel.url {
            guard url.pathExtension == "sighting",
                  FileManager.default.fileExists(
                      atPath: url.appendingPathComponent("project.json").path) else {
                alertMessage = "„\(url.lastPathComponent)“ ist kein gültiges Sighting-Projekt."
                return
            }
            do {
                try project.load(from: url, player: player)
            } catch {
                alertMessage = "Projekt konnte nicht geladen werden: \(error.localizedDescription)"
            }
        }
    }

    @discardableResult
    func saveProject(forcePanel: Bool = false) -> Bool {
        var target = project.projectURL
        if target == nil || forcePanel {
            let panel = NSSavePanel()
            panel.nameFieldStringValue = (player.videoURL?
                .deletingPathExtension().lastPathComponent ?? "Sichtung") + ".sighting"
            panel.message = "Projekt sichern (Ordnerpaket .sighting)"
            guard panel.runModal() == .OK, var url = panel.url else { return false }
            if url.pathExtension != "sighting" {
                url.appendPathExtension("sighting")
            }
            target = url
        }
        do {
            try project.save(to: target, player: player)
            return true
        } catch {
            alertMessage = "Sichern fehlgeschlagen: \(error.localizedDescription)"
            return false
        }
    }

    /// true = weitermachen erlaubt (gesichert oder bewusst verworfen).
    func confirmDiscardIfNeeded() -> Bool {
        guard project.isDirty, project.textStorage.length > 0 || !project.markers.isEmpty else {
            return true
        }
        let alert = NSAlert()
        alert.messageText = "Änderungen sichern?"
        alert.informativeText = "Das aktuelle Projekt enthält ungesicherte Änderungen."
        alert.addButton(withTitle: "Sichern")
        alert.addButton(withTitle: "Verwerfen")
        alert.addButton(withTitle: "Abbrechen")
        switch alert.runModal() {
        case .alertFirstButtonReturn: return saveProject()
        case .alertSecondButtonReturn: return true
        default: return false
        }
    }

    // MARK: Marker

    func addMarker(colorName: String) {
        guard player.videoURL != nil else { return }
        project.addMarker(at: player.currentTime, colorName: colorName)
        showMarkerList = true
    }

    // MARK: Transkription

    func startTranscription() {
        guard let videoURL = player.videoURL else { return }
        if transcription.setupProblem != nil {
            showWhisperSetup = true
            return
        }
        let range = player.selectedRange ?? (0, player.duration)
        guard range.end - range.start > 0.2 else {
            alertMessage = "Bitte zuerst mit „In“ und „Out“ einen Bereich wählen."
            return
        }
        transcription.transcribe(videoURL: videoURL,
                                 start: range.start, end: range.end) { [weak self] result in
            switch result {
            case .success(let segments):
                self?.insertTranscript(segments, range: range)
            case .failure:
                break  // lastError wird im Service gesetzt und per Alert gezeigt
            }
        }
    }

    private func insertTranscript(_ segments: [WhisperService.Segment],
                                  range: (start: Double, end: Double)) {
        let block = NSMutableAttributedString()
        let bodyAttributes: [NSAttributedString.Key: Any] = [
            .font: NotesEditor.baseFont,
            .foregroundColor: NSColor.textColor,
            .sightingTranscript: true,
        ]
        block.append(NSAttributedString(
            string: "\nTranskript \(formatTimecode(range.start))–\(formatTimecode(range.end))\n",
            attributes: [
                .font: NSFont.boldSystemFont(ofSize: 13),
                .foregroundColor: NSColor.textColor,
                .sightingTranscript: true,
            ]))
        if segments.isEmpty {
            block.append(NSAttributedString(string: "(keine Sprache erkannt)\n",
                                            attributes: bodyAttributes))
        }
        for segment in segments {
            block.append(timecodeLinkString(time: segment.start, transcript: true))
            block.append(NSAttributedString(string: "  " + segment.text + "\n",
                                            attributes: bodyAttributes))
        }
        block.append(NSAttributedString(string: "\n", attributes: [
            .font: NotesEditor.baseFont, .foregroundColor: NSColor.textColor,
        ]))
        NotesEditorBridge.shared.coordinator?.appendTranscript(block)
    }

    // MARK: Export

    func export(kind: ExportKind) {
        guard project.textStorage.length > 0 || !project.markers.isEmpty else {
            alertMessage = "Es gibt noch nichts zu exportieren."
            return
        }
        let panel = NSSavePanel()
        let base = player.videoURL?.deletingPathExtension().lastPathComponent
            ?? project.displayName
        panel.nameFieldStringValue = "\(base)-Sichtung.\(kind.fileExtension)"
        if panel.runModal() == .OK, let url = panel.url {
            do {
                switch kind {
                case .pdf: try ExportService.exportPDF(to: url, project: project, player: player)
                case .docx: try ExportService.exportDOCX(to: url, project: project, player: player)
                case .csv: try ExportService.exportCSV(to: url, project: project, player: player)
                }
                NSWorkspace.shared.activateFileViewerSelecting([url])
            } catch {
                alertMessage = "Export fehlgeschlagen: \(error.localizedDescription)"
            }
        }
    }

    enum ExportKind {
        case pdf, docx, csv
        var fileExtension: String {
            switch self {
            case .pdf: "pdf"
            case .docx: "docx"
            case .csv: "csv"
            }
        }
    }

    // MARK: Tastatur-Shortcuts

    func installKeyMonitor() {
        guard keyMonitor == nil else { return }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self else { return event }
            return self.handleKey(event) ? nil : event
        }
    }

    private func handleKey(_ event: NSEvent) -> Bool {
        // Während man in einem Textfeld tippt, greifen nur Esc (Fokus abgeben).
        if let responder = NSApp.keyWindow?.firstResponder, responder is NSTextView {
            if event.keyCode == 53 {  // Esc
                NSApp.keyWindow?.makeFirstResponder(nil)
                return true
            }
            return false
        }
        guard event.modifierFlags.intersection([.command, .option, .control]).isEmpty else {
            return false
        }
        guard player.videoURL != nil else { return false }

        switch event.keyCode {
        case 49:  // Leertaste
            player.togglePlay()
            return true
        case 123: // ←
            if event.modifierFlags.contains(.shift) { player.skip(by: -5) }
            else { player.stepFrames(-1) }
            return true
        case 124: // →
            if event.modifierFlags.contains(.shift) { player.skip(by: 5) }
            else { player.stepFrames(1) }
            return true
        case 53:  // Esc
            return false
        default:
            break
        }

        switch event.charactersIgnoringModifiers?.lowercased() {
        case "j": player.skip(by: -10)
        case "k": player.togglePlay()
        case "l": player.playFasterCycle()
        case "i": player.setInPoint()
        case "o": player.setOutPoint()
        case "m": addMarker(colorName: "yellow")
        default: return false
        }
        return true
    }
}

/// Klickbarer Timecode als Attributed String (auch für Transkripte).
func timecodeLinkString(time: Double, transcript: Bool = false) -> NSAttributedString {
    var components = URLComponents()
    components.scheme = "sighting"
    components.host = "seek"
    components.queryItems = [URLQueryItem(name: "t", value: String(time))]
    var attributes: [NSAttributedString.Key: Any] = [
        .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .bold),
        .foregroundColor: NSColor.controlAccentColor,
    ]
    if let url = components.url { attributes[.link] = url }
    if transcript { attributes[.sightingTranscript] = true }
    return NSAttributedString(string: formatTimecode(time), attributes: attributes)
}
