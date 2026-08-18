import SwiftUI

/// Zeitleiste mit Scrubbing, Marker-Punkten und In/Out-Bereich.
struct TimelineView: View {
    @EnvironmentObject var player: PlayerController
    @EnvironmentObject var project: ProjectStore

    var body: some View {
        GeometryReader { geo in
            let width = geo.size.width
            let duration = max(player.duration, 0.001)

            ZStack(alignment: .leading) {
                // Grundspur
                RoundedRectangle(cornerRadius: 3)
                    .fill(Color(nsColor: .quaternaryLabelColor))
                    .frame(height: 6)

                // In/Out-Bereich
                if let i = player.inPoint {
                    let o = player.outPoint ?? duration
                    let x1 = CGFloat(min(i, o) / duration) * width
                    let x2 = CGFloat(max(i, o) / duration) * width
                    RoundedRectangle(cornerRadius: 3)
                        .fill(Color.accentColor.opacity(0.3))
                        .frame(width: max(x2 - x1, 2), height: 10)
                        .offset(x: x1)
                }

                // Fortschritt
                RoundedRectangle(cornerRadius: 3)
                    .fill(Color.accentColor)
                    .frame(width: max(CGFloat(player.currentTime / duration) * width, 0), height: 6)

                // Marker
                ForEach(project.markers) { marker in
                    Circle()
                        .fill(Color(nsColor: marker.color))
                        .frame(width: 9, height: 9)
                        .offset(x: CGFloat(marker.time / duration) * width - 4.5, y: -9)
                        .onTapGesture { player.seek(to: marker.time) }
                        .help(marker.label.isEmpty ? formatTimecode(marker.time) : marker.label)
                }

                // Abspielkopf
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(Color.primary)
                    .frame(width: 3, height: 16)
                    .offset(x: CGFloat(player.currentTime / duration) * width - 1.5)
            }
            .frame(maxHeight: .infinity, alignment: .center)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        let fraction = max(0, min(1, value.location.x / width))
                        player.seek(to: fraction * duration, exact: false)
                    }
                    .onEnded { value in
                        let fraction = max(0, min(1, value.location.x / width))
                        player.seek(to: fraction * duration, exact: true)
                    }
            )
        }
        .disabled(player.videoURL == nil)
    }
}

/// Seitliche Markerliste: klickbar, editierbar.
struct MarkerListPane: View {
    @EnvironmentObject var player: PlayerController
    @EnvironmentObject var project: ProjectStore

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Marker")
                .font(.headline)
                .padding(10)
            Divider()
            if project.markers.isEmpty {
                Text("Noch keine Marker.\nMit „M“ oder dem Marker-Knopf setzt du einen an der aktuellen Stelle.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(10)
                Spacer()
            } else {
                List {
                    ForEach($project.markers) { $marker in
                        HStack(spacing: 8) {
                            Menu {
                                ForEach(Marker.palette, id: \.name) { entry in
                                    Button(entry.title) { marker.colorName = entry.name }
                                }
                            } label: {
                                Circle()
                                    .fill(Color(nsColor: marker.color))
                                    .frame(width: 10, height: 10)
                            }
                            .menuStyle(.borderlessButton)
                            .frame(width: 16)

                            Button(formatTimecode(marker.time)) {
                                player.seek(to: marker.time)
                            }
                            .buttonStyle(.plain)
                            .font(.system(.caption, design: .monospaced).weight(.semibold))
                            .foregroundStyle(Color.accentColor)

                            TextField("Beschreibung", text: $marker.label)
                                .textFieldStyle(.plain)
                                .font(.caption)

                            Button {
                                project.removeMarker(marker)
                            } label: {
                                Image(systemName: "trash")
                                    .font(.caption2)
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(.secondary)
                        }
                    }
                }
                .listStyle(.plain)
            }
        }
        .frame(width: 240)
        .background(Color(nsColor: .controlBackgroundColor))
    }
}
