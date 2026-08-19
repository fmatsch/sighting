import SwiftUI
import AppKit

@main
struct SightingApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    @StateObject private var project: ProjectStore
    @StateObject private var player: PlayerController
    @StateObject private var transcription: WhisperService
    @StateObject private var appModel: AppModel

    init() {
        let project = ProjectStore()
        let player = PlayerController()
        let transcription = WhisperService()
        _project = StateObject(wrappedValue: project)
        _player = StateObject(wrappedValue: player)
        _transcription = StateObject(wrappedValue: transcription)
        _appModel = StateObject(wrappedValue: AppModel(
            project: project, player: player, transcription: transcription))
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(project)
                .environmentObject(player)
                .environmentObject(transcription)
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
