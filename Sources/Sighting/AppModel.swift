import AppKit
import SwiftUI
import UniformTypeIdentifiers

extension NSAttributedString.Key {
    /// Markiert transkribierte Absätze (für den CSV-Export).
    static let sightingTranscript = NSAttributedString.Key("SightingTranscript")
    /// Markiert KI-generierte Bildbeschreibungen (für den CSV-Export).
    static let sightingVisionDescription = NSAttributedString.Key("SightingVisionDescription")
}

/// Verbindet Player, Projekt, Whisper und die optionale Bildbeschreibung;
/// enthält Menü-Aktionen und Dialoge.
final class AppModel: ObservableObject {
    static var shared: AppModel!

    let project: ProjectStore
    let player: PlayerController
    let transcription: WhisperService
    let vision: VisionDescriptionService

    @Published var showMarkerList = true
    @Published var showWhisperSetup = false
    @Published var showVisionSetup = false
    @Published var alertMessage: String?

    /// Ob beim Beginn einer neuen Notiz zusätzlich zum Timecode auch ein
    /// Video-Standbild eingefügt wird. Persistiert über Neustarts hinweg.
    @Published var includeScreenshots: Bool {
        didSet { UserDefaults.standard.set(includeScreenshots, forKey: "includeScreenshots") }
    }

    /// Full-Auto-Modus: jeder gesetzte Marker bekommt zusätzlich automatisch
    /// eine KI-Bildbeschreibung. Persistiert über Neustarts hinweg.
    @Published var fullAutoMode: Bool {
        didSet { UserDefaults.standard.set(fullAutoMode, forKey: "fullAutoMode") }
    }

    private var keyMonitor: Any?

    init(project: ProjectStore, player: PlayerController,
         transcription: WhisperService, vision: VisionDescriptionService) {
        self.project = project
        self.player = player
        self.transcription = transcription
        self.vision = vision
        self.includeScreenshots = UserDefaults.standard.object(forKey: "includeScreenshots") == nil
            ? true
            : UserDefaults.standard.bool(forKey: "includeScreenshots")
        self.fullAutoMode = UserDefaults.standard.bool(forKey: "fullAutoMode")
        AppModel.shared = self
    }

    // MARK: Datei-Aktionen

    func openVideoPanel() {
        let panel = NSOpenPanel()
        // .mxf ist auf manchen Macs nicht als audiovisueller Inhalt registriert
        // (hängt von installierter Software ab) — explizit ergänzen, damit
        // XDCAM-MXF-Dateien immer auswählbar sind.
        var types: [UTType] = [.audiovisualContent]
        if let mxf = UTType(filenameExtension: "mxf") { types.append(mxf) }
        panel.allowedContentTypes = types
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
        if fullAutoMode {
            describeCurrentFrame()
        }
    }

    // MARK: Bildbeschreibung (Add-on über Ollama)

    /// Beschreibt das aktuelle Video-Standbild per lokalem Vision-Modell,
    /// übersetzt die (englische) Beschreibung ins Deutsche und fügt einen
    /// Notiz-Block mit Screenshot, Timecode und KI-Text an. Ohne
    /// installiertes/laufendes Ollama erscheint nur ein Einrichtungshinweis —
    /// der Rest der App funktioniert unverändert.
    func describeCurrentFrame() {
        guard player.videoURL != nil else { return }
        guard vision.setupProblem == nil else {
            showVisionSetup = true
            return
        }
        guard let image = player.thumbnail(at: player.currentTime) else { return }
        let time = player.currentTime

        vision.checkStatus { [weak self] status in
            guard let self else { return }
            guard status.serverRunning else {
                self.alertMessage = "Ollama läuft nicht. Im Terminal starten: ollama serve\n" +
                    "(oder dauerhaft: brew services start ollama)"
                return
            }
            guard status.allReady else {
                self.showVisionSetup = true
                return
            }
            self.vision.describe(image: image) { result in
                guard case .success(let englishText) = result else {
                    return  // .failure: vision.lastError ist gesetzt und wird als Alert gezeigt
                }
                self.vision.translateToGerman(englishText) { translationResult in
                    let finalText = (try? translationResult.get()) ?? englishText
                    self.insertDescription(finalText, time: time, image: image)
                }
            }
        }
    }

    private func insertDescription(_ text: String, time: Double, image: NSImage) {
        let block = NSMutableAttributedString()
        let bodyAttributes: [NSAttributedString.Key: Any] = [
            .font: NSFontManager.shared.convert(NSFont.systemFont(ofSize: 13), toHaveTrait: .italicFontMask),
            .foregroundColor: NSColor.secondaryLabelColor,
            .sightingVisionDescription: true,
        ]

        let targetWidth: CGFloat = 160
        let scale = targetWidth / max(image.size.width, 1)
        let targetSize = NSSize(width: targetWidth, height: (image.size.height * scale).rounded())
        let small = NSImage(size: targetSize)
        small.lockFocus()
        image.draw(in: NSRect(origin: .zero, size: targetSize))
        small.unlockFocus()
        if let smallTiff = small.tiffRepresentation, let smallBitmap = NSBitmapImageRep(data: smallTiff),
           let smallPNG = smallBitmap.representation(using: .png, properties: [:]) {
            let wrapper = FileWrapper(regularFileWithContents: smallPNG)
            wrapper.preferredFilename = "frame-\(Int(time * 1000)).png"
            let attachment = NSTextAttachment(fileWrapper: wrapper)
            attachment.bounds = NSRect(origin: .zero, size: targetSize)
            block.append(NSAttributedString(string: "\n"))
            block.append(NSAttributedString(attachment: attachment))
            block.append(NSAttributedString(string: "  "))
        }
        block.append(timecodeLinkString(time: time, visionDescription: true))
        block.append(NSAttributedString(string: "  🖼 " + text + "\n", attributes: bodyAttributes))
        NotesEditorBridge.shared.coordinator?.appendTranscript(block)
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

/// Klickbarer Timecode als Attributed String (auch für Transkripte und
/// KI-Bildbeschreibungen — für den CSV-Export entsprechend markiert).
func timecodeLinkString(time: Double, transcript: Bool = false,
                        visionDescription: Bool = false) -> NSAttributedString {
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
    if visionDescription { attributes[.sightingVisionDescription] = true }
    return NSAttributedString(string: formatTimecode(time), attributes: attributes)
}
