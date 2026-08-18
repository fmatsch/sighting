import SwiftUI
import AVFoundation
import UniformTypeIdentifiers

/// Reine Video-Fläche auf Basis von AVPlayerLayer.
struct VideoSurface: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> PlayerLayerView {
        let view = PlayerLayerView()
        view.playerLayer.player = player
        return view
    }

    func updateNSView(_ nsView: PlayerLayerView, context: Context) {
        nsView.playerLayer.player = player
    }

    final class PlayerLayerView: NSView {
        let playerLayer = AVPlayerLayer()

        override init(frame frameRect: NSRect) {
            super.init(frame: frameRect)
            wantsLayer = true
            playerLayer.videoGravity = .resizeAspect
            playerLayer.backgroundColor = NSColor.black.cgColor
            layer = playerLayer
        }

        required init?(coder: NSCoder) { fatalError() }
    }
}

/// Video-Bereich inkl. Steuerleiste und Timeline.
struct PlayerPane: View {
    @EnvironmentObject var player: PlayerController
    @EnvironmentObject var project: ProjectStore
    @EnvironmentObject var app: AppModel

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                Color.black
                if player.videoURL != nil {
                    VideoSurface(player: player.player)
                } else {
                    VStack(spacing: 10) {
                        Image(systemName: "film")
                            .font(.system(size: 44))
                        Text("Video hierher ziehen oder über „Ablage → Video öffnen…“ laden")
                    }
                    .foregroundStyle(Color.white.opacity(0.55))
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { player.togglePlay() }
            .onDrop(of: [.fileURL], isTargeted: nil) { providers in
                guard let provider = providers.first else { return false }
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    if let url {
                        DispatchQueue.main.async { app.openVideo(url: url) }
                    }
                }
                return true
            }

            TimelineView()
                .frame(height: 26)
                .padding(.horizontal, 10)
                .padding(.top, 6)

            ControlBar()
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

struct ControlBar: View {
    @EnvironmentObject var player: PlayerController
    @EnvironmentObject var project: ProjectStore
    @EnvironmentObject var app: AppModel

    var body: some View {
        HStack(spacing: 12) {
            // Transport
            HStack(spacing: 6) {
                Button { player.skip(by: -10) } label: {
                    Image(systemName: "gobackward.10")
                }
                .help("10 Sekunden zurück (J)")

                Button { player.togglePlay() } label: {
                    Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                        .frame(width: 18)
                }
                .help("Wiedergabe/Pause (Leertaste oder K)")

                Button { player.skip(by: 10) } label: {
                    Image(systemName: "goforward.10")
                }
                .help("10 Sekunden vor")

                Button { player.stepFrames(-1) } label: {
                    Image(systemName: "backward.frame")
                }
                .help("1 Bild zurück (←)")

                Button { player.stepFrames(1) } label: {
                    Image(systemName: "forward.frame")
                }
                .help("1 Bild vor (→)")
            }

            // Geschwindigkeit
            Picker("", selection: Binding(
                get: { player.playbackRate },
                set: { player.setRate($0) }
            )) {
                ForEach(PlayerController.availableRates, id: \.self) { rate in
                    Text(rate == 1.0 ? "1×" : String(format: "%g×", rate)).tag(rate)
                }
            }
            .frame(width: 76)
            .help("Wiedergabegeschwindigkeit (L zum Durchschalten)")

            // Timecode
            Text(formatTimecode(player.currentTime))
                .font(.system(.body, design: .monospaced).weight(.semibold))
            Text("/ " + formatTimecode(player.duration))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)

            Spacer()

            // In/Out
            HStack(spacing: 6) {
                Button("In") { player.setInPoint() }
                    .help("In-Punkt setzen (I)")
                Button("Out") { player.setOutPoint() }
                    .help("Out-Punkt setzen (O)")
                if player.inPoint != nil || player.outPoint != nil {
                    Button {
                        player.clearInOut()
                    } label: {
                        Image(systemName: "xmark.circle")
                    }
                    .help("In/Out löschen")
                }
            }

            // Transkription
            Button {
                app.startTranscription()
            } label: {
                if app.transcription.isRunning {
                    HStack(spacing: 5) {
                        ProgressView().controlSize(.small)
                        Text(app.transcription.progressText)
                    }
                } else {
                    Label("Transkribieren", systemImage: "text.quote")
                }
            }
            .disabled(player.videoURL == nil || app.transcription.isRunning)
            .help("In/Out-Bereich (oder ganzes Video) mit Whisper transkribieren")

            // Marker
            Menu {
                ForEach(Marker.palette, id: \.name) { entry in
                    Button {
                        app.addMarker(colorName: entry.name)
                    } label: {
                        Label(entry.title, systemImage: "circle.fill")
                    }
                }
            } label: {
                Label("Marker", systemImage: "bookmark.fill")
            } primaryAction: {
                app.addMarker(colorName: "yellow")
            }
            .frame(width: 100)
            .help("Marker an aktueller Position setzen (M)")

            Button {
                withAnimation { app.showMarkerList.toggle() }
            } label: {
                Image(systemName: "sidebar.trailing")
            }
            .help("Markerliste ein-/ausblenden")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
    }
}
