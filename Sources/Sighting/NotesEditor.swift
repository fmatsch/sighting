import SwiftUI
import AppKit

/// Notizfeld auf NSTextView-Basis. Beginnt man auf einer leeren Zeile
/// (am Dokumentanfang oder nach einer Leerzeile) zu tippen, werden
/// automatisch ein kleines Standbild und der klickbare Timecode eingefügt.
struct NotesEditor: NSViewRepresentable {
    @EnvironmentObject var player: PlayerController
    @EnvironmentObject var project: ProjectStore

    static let baseFont = NSFont.systemFont(ofSize: 13)

    func makeCoordinator() -> Coordinator {
        Coordinator(player: player)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSTextView.scrollableTextView()
        let textView = scrollView.documentView as! NSTextView

        textView.layoutManager?.replaceTextStorage(project.textStorage)
        textView.delegate = context.coordinator
        textView.font = NotesEditor.baseFont
        textView.typingAttributes = [.font: NotesEditor.baseFont,
                                     .foregroundColor: NSColor.textColor]
        textView.isRichText = true
        textView.allowsUndo = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.textContainerInset = NSSize(width: 12, height: 12)
        textView.linkTextAttributes = [
            .foregroundColor: NSColor.controlAccentColor,
            .underlineStyle: 0,
            .cursor: NSCursor.pointingHand,
        ]

        context.coordinator.textView = textView
        NotesEditorBridge.shared.coordinator = context.coordinator
        return scrollView
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) {
        context.coordinator.player = player
    }

    // MARK: Coordinator

    final class Coordinator: NSObject, NSTextViewDelegate {
        var player: PlayerController
        weak var textView: NSTextView?
        private var isInsertingHeader = false

        init(player: PlayerController) {
            self.player = player
        }

        func textView(_ textView: NSTextView,
                      shouldChangeTextIn affectedCharRange: NSRange,
                      replacementString: String?) -> Bool {
            guard !isInsertingHeader,
                  let replacement = replacementString,
                  !replacement.isEmpty,
                  replacement != "\n",
                  player.videoURL != nil,
                  needsHeader(textView, at: affectedCharRange) else {
                return true
            }

            // Automatisch pausieren, sobald eine neue Notiz beginnt.
            player.pause()

            let header = makeHeader(time: player.currentTime)
            let typed = NSAttributedString(string: replacement,
                                           attributes: noteTextAttributes())
            let combined = NSMutableAttributedString(attributedString: header)
            combined.append(typed)

            isInsertingHeader = true
            textView.insertText(combined, replacementRange: affectedCharRange)
            textView.typingAttributes = noteTextAttributes()
            isInsertingHeader = false
            return false
        }

        /// Header nur, wenn der aktuelle Absatz leer ist und davor ebenfalls
        /// eine Leerzeile (oder der Dokumentanfang) liegt.
        private func needsHeader(_ textView: NSTextView, at range: NSRange) -> Bool {
            let text = textView.string as NSString
            let location = min(range.location, text.length)
            let paragraph = text.paragraphRange(for: NSRange(location: location, length: 0))
            let paragraphText = text.substring(with: paragraph)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard paragraphText.isEmpty else { return false }

            if paragraph.location == 0 { return true }
            let previous = text.paragraphRange(
                for: NSRange(location: paragraph.location - 1, length: 0))
            let previousText = text.substring(with: previous)
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: "\u{FFFC}", with: "")
            return previousText.isEmpty
        }

        private func noteTextAttributes() -> [NSAttributedString.Key: Any] {
            [.font: NotesEditor.baseFont, .foregroundColor: NSColor.textColor]
        }

        /// Baut "Thumbnail + Timecode-Link + Zeilenumbruch".
        private func makeHeader(time: Double) -> NSAttributedString {
            let result = NSMutableAttributedString()

            let screenshotsWanted = AppModel.shared?.includeScreenshots ?? true
            if screenshotsWanted, let attachment = thumbnailAttachment(time: time) {
                result.append(NSAttributedString(attachment: attachment))
                result.append(NSAttributedString(string: "  "))
            }
            result.append(timecodeLinkString(time: time))
            result.append(NSAttributedString(string: "\n", attributes: noteTextAttributes()))
            return result
        }

        private func thumbnailAttachment(time: Double) -> NSTextAttachment? {
            guard let image = player.thumbnail(at: time) else { return nil }

            // Auf 160 pt Breite verkleinern und als PNG einbetten,
            // damit RTFD-Speicherung und DOCX-Export das Bild mitnehmen.
            let targetWidth: CGFloat = 160
            let scale = targetWidth / max(image.size.width, 1)
            let targetSize = NSSize(width: targetWidth,
                                    height: (image.size.height * scale).rounded())
            let small = NSImage(size: targetSize)
            small.lockFocus()
            image.draw(in: NSRect(origin: .zero, size: targetSize))
            small.unlockFocus()

            guard let tiff = small.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else { return nil }

            let wrapper = FileWrapper(regularFileWithContents: png)
            wrapper.preferredFilename = "frame-\(Int(time * 1000)).png"
            let attachment = NSTextAttachment(fileWrapper: wrapper)
            attachment.bounds = NSRect(origin: .zero, size: targetSize)
            return attachment
        }

        // Klick auf Timecode → im Video dorthin springen.
        func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
            guard let url = linkURL(from: link), url.scheme == "sighting" else { return false }
            if let t = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "t" })?.value,
               let seconds = Double(t) {
                player.seek(to: seconds)
                return true
            }
            return false
        }

        private func linkURL(from link: Any) -> URL? {
            if let url = link as? URL { return url }
            if let string = link as? String { return URL(string: string) }
            return nil
        }

        /// Fügt einen fertigen Transkript-Block ans Ende der Notizen an.
        func appendTranscript(_ block: NSAttributedString) {
            guard let textView else { return }
            let end = NSRange(location: (textView.string as NSString).length, length: 0)
            isInsertingHeader = true
            textView.insertText(block, replacementRange: end)
            isInsertingHeader = false
            textView.scrollRangeToVisible(
                NSRange(location: (textView.string as NSString).length, length: 0))
        }
    }
}

/// Kleine Brücke, damit App-Logik (Whisper) an den aktiven Editor herankommt.
final class NotesEditorBridge {
    static let shared = NotesEditorBridge()
    weak var coordinator: NotesEditor.Coordinator?
}
