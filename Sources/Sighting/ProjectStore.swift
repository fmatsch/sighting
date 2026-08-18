import AppKit
import Combine
import UniformTypeIdentifiers

struct Marker: Identifiable, Codable, Equatable {
    var id = UUID()
    var time: Double
    var colorName: String   // Schlüssel in Marker.palette
    var label: String

    static let palette: [(name: String, color: NSColor, title: String)] = [
        ("yellow", .systemYellow, "Zitat"),
        ("green", .systemGreen, "Gut"),
        ("red", .systemRed, "Problem"),
        ("blue", .systemBlue, "B-Roll"),
    ]

    var color: NSColor {
        Marker.palette.first(where: { $0.name == colorName })?.color ?? .systemYellow
    }
}

/// Hält den Projektzustand: Notizen (NSTextStorage), Marker, Videopfad.
/// Speichert als Paketordner "Name.sighting" mit notes.rtfd + project.json.
final class ProjectStore: ObservableObject {
    let textStorage = NSTextStorage()

    @Published var markers: [Marker] = []
    @Published var projectURL: URL?
    @Published var isDirty = false

    private var autosaveTimer: Timer?
    private var storageObserver: NSObjectProtocol?
    private var markersCancellable: AnyCancellable?

    struct ProjectMeta: Codable {
        var videoPath: String?
        var markers: [Marker]
        var inPoint: Double?
        var outPoint: Double?
    }

    init() {
        storageObserver = NotificationCenter.default.addObserver(
            forName: NSTextStorage.didProcessEditingNotification,
            object: textStorage, queue: .main
        ) { [weak self] _ in
            self?.isDirty = true
        }
        markersCancellable = $markers.dropFirst().sink { [weak self] _ in
            self?.isDirty = true
        }
        autosaveTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
            guard let self, self.isDirty, self.projectURL != nil else { return }
            try? self.save()
        }
    }

    var displayName: String {
        projectURL?.deletingPathExtension().lastPathComponent ?? "Unbenannt"
    }

    // MARK: Speichern / Laden

    func save(to url: URL? = nil, player: PlayerController? = nil) throws {
        guard let target = url ?? projectURL else { return }
        let fm = FileManager.default
        try fm.createDirectory(at: target, withIntermediateDirectories: true)

        let fullRange = NSRange(location: 0, length: textStorage.length)
        let wrapper = try textStorage.fileWrapper(
            from: fullRange,
            documentAttributes: [.documentType: NSAttributedString.DocumentType.rtfd]
        )
        try wrapper.write(
            to: target.appendingPathComponent("notes.rtfd"),
            options: .atomic, originalContentsURL: nil
        )

        let meta = ProjectMeta(
            videoPath: player?.videoURL?.path,
            markers: markers,
            inPoint: player?.inPoint,
            outPoint: player?.outPoint
        )
        let data = try JSONEncoder().encode(meta)
        try data.write(to: target.appendingPathComponent("project.json"))

        projectURL = target
        isDirty = false
    }

    func load(from url: URL, player: PlayerController) throws {
        let notesURL = url.appendingPathComponent("notes.rtfd")
        if FileManager.default.fileExists(atPath: notesURL.path) {
            let attributed = try NSAttributedString(
                url: notesURL,
                options: [.documentType: NSAttributedString.DocumentType.rtfd],
                documentAttributes: nil
            )
            textStorage.setAttributedString(attributed)
        } else {
            textStorage.setAttributedString(NSAttributedString())
        }

        let metaURL = url.appendingPathComponent("project.json")
        if let data = try? Data(contentsOf: metaURL),
           let meta = try? JSONDecoder().decode(ProjectMeta.self, from: data) {
            markers = meta.markers
            if let path = meta.videoPath {
                let videoURL = URL(fileURLWithPath: path)
                if FileManager.default.fileExists(atPath: videoURL.path) {
                    player.open(url: videoURL)
                    player.inPoint = meta.inPoint
                    player.outPoint = meta.outPoint
                }
            }
        } else {
            markers = []
        }

        projectURL = url
        isDirty = false
    }

    func newProject(player: PlayerController) {
        textStorage.setAttributedString(NSAttributedString())
        markers = []
        projectURL = nil
        player.player.replaceCurrentItem(with: nil)
        player.videoURL = nil
        player.duration = 0
        player.currentTime = 0
        player.clearInOut()
        isDirty = false
    }

    // MARK: Marker

    func addMarker(at time: Double, colorName: String, label: String = "") {
        markers.append(Marker(time: time, colorName: colorName, label: label))
        markers.sort { $0.time < $1.time }
        isDirty = true
    }

    func removeMarker(_ marker: Marker) {
        markers.removeAll { $0.id == marker.id }
        isDirty = true
    }
}

extension UTType {
    static let sightingProject = UTType(exportedAs: "com.fmatsch.sighting.project",
                                        conformingTo: .package)
}
