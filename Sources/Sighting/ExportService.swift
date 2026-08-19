import AppKit

/// Exportiert die Notizen als PDF, DOCX oder CSV.
enum ExportService {

    /// Notizen + Titelkopf als eine Attributed String fürs Rendern.
    private static func exportContent(project: ProjectStore, player: PlayerController) -> NSAttributedString {
        let result = NSMutableAttributedString()

        let title = "Sichtungsnotizen – \(player.videoURL?.lastPathComponent ?? project.displayName)"
        result.append(NSAttributedString(string: title + "\n", attributes: [
            .font: NSFont.boldSystemFont(ofSize: 17),
            .foregroundColor: NSColor.black,
        ]))
        let df = DateFormatter()
        df.dateStyle = .long
        df.timeStyle = .short
        df.locale = Locale(identifier: "de_AT")
        result.append(NSAttributedString(string: df.string(from: Date()) + "\n\n", attributes: [
            .font: NSFont.systemFont(ofSize: 10),
            .foregroundColor: NSColor.darkGray,
        ]))

        if !project.markers.isEmpty {
            result.append(NSAttributedString(string: "Marker\n", attributes: [
                .font: NSFont.boldSystemFont(ofSize: 13), .foregroundColor: NSColor.black,
            ]))
            for marker in project.markers {
                let name = Marker.palette.first(where: { $0.name == marker.colorName })?.title ?? ""
                let line = "\(formatTimecode(marker.time))  [\(name)] \(marker.label)\n"
                result.append(NSAttributedString(string: line, attributes: [
                    .font: NSFont.monospacedSystemFont(ofSize: 10, weight: .regular),
                    .foregroundColor: NSColor.black,
                ]))
            }
            result.append(NSAttributedString(string: "\n"))
        }

        result.append(project.textStorage.attributedSubstring(
            from: NSRange(location: 0, length: project.textStorage.length)))
        return result
    }

    // MARK: PDF

    static func exportPDF(to url: URL, project: ProjectStore, player: PlayerController) throws {
        let content = exportContent(project: project, player: player)

        let printInfo = NSPrintInfo()
        printInfo.paperSize = NSSize(width: 595, height: 842)  // A4
        printInfo.topMargin = 40
        printInfo.bottomMargin = 40
        printInfo.leftMargin = 40
        printInfo.rightMargin = 40
        printInfo.horizontalPagination = .fit
        printInfo.verticalPagination = .automatic
        printInfo.jobDisposition = .save
        printInfo.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = url

        let width = printInfo.paperSize.width - printInfo.leftMargin - printInfo.rightMargin
        let textView = NSTextView(frame: NSRect(x: 0, y: 0, width: width, height: 100))
        textView.textStorage?.setAttributedString(content)
        textView.textContainer?.widthTracksTextView = true
        textView.layoutManager?.ensureLayout(for: textView.textContainer!)
        textView.sizeToFit()

        let operation = NSPrintOperation(view: textView, printInfo: printInfo)
        operation.showsPrintPanel = false
        operation.showsProgressPanel = false
        guard operation.run() else {
            throw NSError(domain: "Sighting", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "PDF-Export fehlgeschlagen."])
        }
    }

    // MARK: CSV

    /// Semikolon-getrennt (deutsches Excel), UTF-8 mit BOM.
    static func exportCSV(to url: URL, project: ProjectStore, player: PlayerController) throws {
        struct Row { let time: Double; let type: String; let text: String }
        var rows: [Row] = []

        for marker in project.markers {
            let name = Marker.palette.first(where: { $0.name == marker.colorName })?.title ?? "Marker"
            rows.append(Row(time: marker.time, type: "Marker (\(name))", text: marker.label))
        }
        rows.append(contentsOf: noteBlocks(from: project.textStorage).map {
            let type = $0.isVisionDescription ? "Bildbeschreibung (KI)" : ($0.isTranscript ? "Transkript" : "Notiz")
            return Row(time: $0.time, type: type, text: $0.text)
        })
        rows.sort { $0.time < $1.time }

        var csv = "\u{FEFF}Timecode;Sekunden;Typ;Text\n"
        for row in rows {
            let escaped = row.text
                .replacingOccurrences(of: "\"", with: "\"\"")
                .replacingOccurrences(of: "\n", with: " ")
            csv += "\(formatTimecode(row.time));\(Int(row.time));\(row.type);\"\(escaped)\"\n"
        }
        try csv.data(using: .utf8)!.write(to: url)
    }

    struct NoteBlock {
        let time: Double
        let text: String
        let isTranscript: Bool
        let isVisionDescription: Bool
    }

    /// Zerlegt die Notizen in Blöcke: jeder Timecode-Link beginnt einen Block,
    /// der folgende Text (bis zum nächsten Link bzw. einer Leerzeile vor
    /// neuem Block) gehört dazu.
    static func noteBlocks(from storage: NSTextStorage) -> [NoteBlock] {
        var blocks: [NoteBlock] = []
        let text = storage.string as NSString
        var currentTime: Double?
        var currentText: [String] = []
        var currentIsTranscript = false
        var currentIsVisionDescription = false

        func flush() {
            if let time = currentTime {
                let joined = currentText.joined(separator: " ")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                blocks.append(NoteBlock(time: time, text: joined,
                                        isTranscript: currentIsTranscript,
                                        isVisionDescription: currentIsVisionDescription))
            }
            currentTime = nil
            currentText = []
            currentIsTranscript = false
            currentIsVisionDescription = false
        }

        var location = 0
        while location < text.length {
            let paragraph = text.paragraphRange(for: NSRange(location: location, length: 0))

            // Timecode-Link im Absatz?
            var linkTime: Double?
            storage.enumerateAttribute(.link, in: paragraph) { value, _, stop in
                if let url = value as? URL, url.scheme == "sighting",
                   let t = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                       .queryItems?.first(where: { $0.name == "t" })?.value,
                   let seconds = Double(t) {
                    linkTime = seconds
                    stop.pointee = true
                }
            }

            let raw = text.substring(with: paragraph)
                .replacingOccurrences(of: "\u{FFFC}", with: "")
                .trimmingCharacters(in: .whitespacesAndNewlines)

            if let linkTime {
                // Absatz mit Timecode: Rest des Absatzes (nach dem Timecode) ist Text.
                flush()
                currentTime = linkTime
                let withoutTC = raw.replacingOccurrences(
                    of: #"^\d{2}:\d{2}:\d{2}\s*[–-]?\s*(\d{2}:\d{2}:\d{2})?\s*"#,
                    with: "", options: .regularExpression)
                // Über den ganzen Absatz suchen, nicht nur an dessen Anfang —
                // bei Bildbeschreibungen sitzt vor dem markierten Timecode
                // noch das unmarkierte Screenshot-Attachment.
                var isTranscript = false
                storage.enumerateAttribute(.sightingTranscript, in: paragraph) { value, _, stop in
                    if value != nil { isTranscript = true; stop.pointee = true }
                }
                var isVisionDescription = false
                storage.enumerateAttribute(.sightingVisionDescription, in: paragraph) { value, _, stop in
                    if value != nil { isVisionDescription = true; stop.pointee = true }
                }
                currentIsTranscript = isTranscript
                currentIsVisionDescription = isVisionDescription
                let withoutEmoji = withoutTC.replacingOccurrences(of: "🖼 ", with: "")
                if !withoutEmoji.isEmpty { currentText.append(withoutEmoji) }
            } else if !raw.isEmpty, raw.range(
                of: #"^Transkript \d{2}:\d{2}:\d{2}[–-]\d{2}:\d{2}:\d{2}$"#,
                options: .regularExpression) == nil {
                currentText.append(raw)
            }

            location = NSMaxRange(paragraph)
            if paragraph.length == 0 { break }
        }
        flush()
        return blocks
    }

    // MARK: DOCX

    static func exportDOCX(to url: URL, project: ProjectStore, player: PlayerController) throws {
        let content = exportContent(project: project, player: player)
        try DocxWriter.write(content, to: url)
    }
}
