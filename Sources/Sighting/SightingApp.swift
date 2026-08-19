import SwiftUI
import AppKit

@main
struct SightingApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    @StateObject private var project: ProjectStore
    @StateObject private var player: PlayerController
    @StateObject private var transcription: WhisperService
    @StateObject private var vision: VisionDescriptionService
    @StateObject private var appModel: AppModel

    init() {
        let project = ProjectStore()
        let player = PlayerController()
        let transcription = WhisperService()
        let vision = VisionDescriptionService()
        _project = StateObject(wrappedValue: project)
        _player = StateObject(wrappedValue: player)
        _transcription = StateObject(wrappedValue: transcription)
        _vision = StateObject(wrappedValue: vision)
        _appModel = StateObject(wrappedValue: AppModel(
            project: project, player: player, transcription: transcription, vision: vision))
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(project)
                .environmentObject(player)
                .environmentObject(transcription)
                .environmentObject(vision)
                .environmentObject(appModel)
                .onAppear {
                    appModel.installKeyMonitor()
                    NSApp.activate(ignoringOtherApps: true)
                }
        }
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Neues Projekt") { appModel.newProject() }
                    .keyboardShortcut("n")
                Button("Projekt öffnen …") { appModel.openProjectPanel() }
                    .keyboardShortcut("o")
                Divider()
                Button("Video öffnen …") { appModel.openVideoPanel() }
                    .keyboardShortcut("o", modifiers: [.command, .shift])
            }
            CommandGroup(replacing: .saveItem) {
                Button("Sichern") { appModel.saveProject() }
                    .keyboardShortcut("s")
                Button("Sichern unter …") { appModel.saveProject(forcePanel: true) }
                    .keyboardShortcut("s", modifiers: [.command, .shift])
                Divider()
                Button("Als PDF exportieren …") { appModel.export(kind: .pdf) }
                    .keyboardShortcut("e")
                Button("Als DOCX exportieren …") { appModel.export(kind: .docx) }
                    .keyboardShortcut("e", modifiers: [.command, .shift])
                Button("Timecodes als CSV exportieren …") { appModel.export(kind: .csv) }
            }
            CommandMenu("Sichten") {
                Button("Wiedergabe/Pause") { player.togglePlay() }
                    .keyboardShortcut("p")
                Button("Marker setzen") { appModel.addMarker(colorName: "yellow") }
                    .keyboardShortcut("m", modifiers: [.command])
                Button("In-Punkt setzen") { player.setInPoint() }
                    .keyboardShortcut("i", modifiers: [.command, .shift])
                Button("Out-Punkt setzen") { player.setOutPoint() }
                    .keyboardShortcut("o", modifiers: [.command, .option])
                Divider()
                Button("Segment transkribieren") { appModel.startTranscription() }
                    .keyboardShortcut("t", modifiers: [.command, .shift])
                Divider()
                Toggle("Screenshot bei neuer Notiz einfügen", isOn: $appModel.includeScreenshots)
                    .keyboardShortcut("t", modifiers: [.command, .option])
                Divider()
                Button("Bild beschreiben (KI)") { appModel.describeCurrentFrame() }
                    .keyboardShortcut("b", modifiers: [.command, .shift])
                Toggle("Vollautomatik (KI-Bildbeschreibung bei jedem Marker)",
                      isOn: $appModel.fullAutoMode)
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let model = AppModel.shared else { return .terminateNow }
        return model.confirmDiscardIfNeeded() ? .terminateNow : .terminateCancel
    }
}

struct ContentView: View {
    @EnvironmentObject var project: ProjectStore
    @EnvironmentObject var player: PlayerController
    @EnvironmentObject var transcription: WhisperService
    @EnvironmentObject var vision: VisionDescriptionService
    @EnvironmentObject var app: AppModel

    var body: some View {
        VSplitView {
            PlayerPane()
                .frame(minHeight: 240, idealHeight: 420)
            HStack(spacing: 0) {
                NotesEditor()
                    .frame(minWidth: 360)
                if app.showMarkerList {
                    Divider()
                    MarkerListPane()
                }
            }
            .frame(minHeight: 180, idealHeight: 320)
        }
        .frame(minWidth: 760, minHeight: 520)
        .navigationTitle(project.displayName + (project.isDirty ? " — bearbeitet" : ""))
        .sheet(isPresented: $app.showWhisperSetup) {
            WhisperSetupView()
                .environmentObject(transcription)
                .environmentObject(app)
        }
        .sheet(isPresented: $app.showVisionSetup) {
            VisionSetupView()
                .environmentObject(vision)
                .environmentObject(app)
        }
        .alert("Hinweis", isPresented: Binding(
            get: { app.alertMessage != nil },
            set: { if !$0 { app.alertMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(app.alertMessage ?? "")
        }
        .alert("Transkription fehlgeschlagen", isPresented: Binding(
            get: { transcription.lastError != nil && !transcription.isDownloadingModel },
            set: { if !$0 { transcription.lastError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(transcription.lastError ?? "")
        }
        .alert("Video konnte nicht geöffnet werden", isPresented: Binding(
            get: { player.importError != nil },
            set: { if !$0 { player.importError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(player.importError ?? "")
        }
        .alert("Bildbeschreibung fehlgeschlagen", isPresented: Binding(
            get: { vision.lastError != nil && !vision.isPullingModel },
            set: { if !$0 { vision.lastError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(vision.lastError ?? "")
        }
    }
}

/// Einmaliges Whisper-Setup: zeigt, was fehlt, und lädt das Modell herunter.
struct WhisperSetupView: View {
    @EnvironmentObject var transcription: WhisperService
    @EnvironmentObject var app: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Whisper einrichten", systemImage: "text.quote")
                .font(.title3.weight(.semibold))

            if let problem = transcription.setupProblem {
                Text(problem)
                    .fixedSize(horizontal: false, vertical: true)

                if transcription.whisperPath != nil,
                   transcription.ffmpegPath != nil,
                   !transcription.modelExists {
                    if transcription.isDownloadingModel {
                        ProgressView(value: transcription.downloadProgress) {
                            Text("Lade Modell … \(Int(transcription.downloadProgress * 100)) %")
                        }
                    } else {
                        Button("Modell jetzt laden (~1,6 GB)") {
                            transcription.downloadModel()
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }
                if let error = transcription.lastError {
                    Text(error).foregroundStyle(.red).font(.caption)
                }
            } else {
                Label("Alles bereit – Transkription kann starten.", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            }

            HStack {
                Spacer()
                Button("Schließen") { dismiss() }
                if transcription.setupProblem == nil {
                    Button("Transkribieren") {
                        dismiss()
                        app.startTranscription()
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
        }
        .padding(20)
        .frame(width: 420)
    }
}

/// Einmaliges Setup für die optionale Bildbeschreibung (Ollama + moondream
/// + qwen2.5 für die deutsche Übersetzung). Reines Add-on: solange Ollama
/// nicht installiert ist, bleibt alles andere in der App unverändert nutzbar.
struct VisionSetupView: View {
    @EnvironmentObject var vision: VisionDescriptionService
    @EnvironmentObject var app: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var status = VisionDescriptionService.ModelStatus()
    @State private var isChecking = true
    @State private var currentlyPulling: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Bildbeschreibung einrichten", systemImage: "text.below.photo")
                .font(.title3.weight(.semibold))

            Text("Optionales Add-on: erzeugt lokal (ohne Cloud) kurze Bildbeschreibungen über " +
                 "Ollama mit dem kompakten Vision-Modell „\(VisionDescriptionService.visionModel)“ " +
                 "und übersetzt sie mit „\(VisionDescriptionService.translationModel)“ ins Deutsche.")
                .font(.callout)
                .foregroundStyle(.secondary)

            if let problem = vision.setupProblem {
                Text(problem)
                    .fixedSize(horizontal: false, vertical: true)
            } else if isChecking {
                ProgressView("Prüfe Ollama …").controlSize(.small)
            } else if !status.serverRunning {
                Text("Ollama ist installiert, läuft aber nicht. Im Terminal starten:\n" +
                     "ollama serve\n(oder dauerhaft: brew services start ollama)")
                    .fixedSize(horizontal: false, vertical: true)
                Button("Erneut prüfen") { check() }
            } else if !status.allReady {
                VStack(alignment: .leading, spacing: 6) {
                    modelRow("Bildbeschreibung (moondream, ~1,7 GB)", ready: status.visionReady)
                    modelRow("Übersetzung (qwen2.5, ~1 GB)", ready: status.translationReady)
                }
                if let pulling = currentlyPulling {
                    ProgressView("Lädt \(pulling) … (kann einige Minuten dauern)")
                        .controlSize(.small)
                } else {
                    Button("Fehlende Modelle jetzt laden") { pullMissing() }
                        .buttonStyle(.borderedProminent)
                }
                if let error = vision.lastError {
                    Text(error).foregroundStyle(.red).font(.caption)
                }
            } else {
                Label("Alles bereit – Bildbeschreibung kann starten.", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            }

            HStack {
                Spacer()
                Button("Schließen") { dismiss() }
                if vision.setupProblem == nil, status.allReady {
                    Button("Bild beschreiben") {
                        dismiss()
                        app.describeCurrentFrame()
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
        }
        .padding(20)
        .frame(width: 460)
        .onAppear { check() }
    }

    private func modelRow(_ label: String, ready: Bool) -> some View {
        Label(label, systemImage: ready ? "checkmark.circle.fill" : "circle")
            .foregroundStyle(ready ? Color.green : Color.secondary)
            .font(.callout)
    }

    private func check(completion: (() -> Void)? = nil) {
        isChecking = true
        vision.checkStatus { newStatus in
            isChecking = false
            status = newStatus
            completion?()
        }
    }

    /// Lädt nacheinander, was noch fehlt (Vision-Modell zuerst, dann Übersetzung),
    /// und prüft den Status nach jedem Download neu, bevor es weitergeht.
    private func pullMissing() {
        if !status.visionReady {
            currentlyPulling = VisionDescriptionService.visionModel
            vision.pullModel(VisionDescriptionService.visionModel) { _ in
                currentlyPulling = nil
                check { if !status.allReady { pullMissing() } }
            }
        } else if !status.translationReady {
            currentlyPulling = VisionDescriptionService.translationModel
            vision.pullModel(VisionDescriptionService.translationModel) { _ in
                currentlyPulling = nil
                check()
            }
        }
    }
}
