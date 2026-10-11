import SwiftUI

/// Einstellungen (⌘,) für die Whisper-Transkription: Sprache und Modellgröße.
struct TranscriptionSettingsView: View {
    @EnvironmentObject var transcription: WhisperService

    var body: some View {
        Form {
            Section {
                Picker("Sprache", selection: $transcription.language) {
                    ForEach(WhisperLanguage.all) { language in
                        Text(language.title).tag(language.code)
                    }
                }
                Text("„Automatisch“ erkennt die Sprache pro Transkription selbst. Ist die Sprache " +
                     "bekannt, ist die feste Auswahl zuverlässiger — besonders bei kurzen Segmenten.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section {
                Picker("Modell", selection: $transcription.selectedModelID) {
                    ForEach(WhisperModel.all) { model in
                        Text("\(model.title) (\(model.sizeText))" +
                             (model.availableURL != nil ? "  ✓" : ""))
                            .tag(model.id)
                    }
                }
                Text(transcription.selectedModel.hint)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                modelStatus
            }
        }
        .formStyle(.grouped)
        .frame(width: 480)
        .fixedSize(horizontal: false, vertical: true)
        .navigationTitle("Transkription")
    }

    @ViewBuilder
    private var modelStatus: some View {
        let model = transcription.selectedModel
        if transcription.downloadingModelID == model.id {
            HStack {
                ProgressView(value: transcription.downloadProgress) {
                    Text("Lade „\(model.title)“ … \(Int(transcription.downloadProgress * 100)) %")
                        .font(.callout)
                }
                Button("Abbrechen") { transcription.cancelDownload() }
            }
        } else if model.availableURL != nil {
            Label(model.isBundled ? "Im Programm enthalten" : "Heruntergeladen — bereit",
                  systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
        } else {
            Button("Modell laden (\(model.sizeText))") {
                transcription.downloadModel()
            }
            .disabled(transcription.isDownloadingModel)
        }
        if let error = transcription.lastError, !transcription.isRunning {
            Text(error).foregroundStyle(.red).font(.caption)
        }
    }
}
