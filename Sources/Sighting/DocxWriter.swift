import AppKit

/// Minimaler OOXML-Writer: erzeugt aus einer NSAttributedString ein .docx
/// mit Text (fett/farbig) und eingebetteten PNG-Bildern.
enum DocxWriter {

    static func write(_ content: NSAttributedString, to url: URL) throws {
        let fm = FileManager.default
        let tmp = fm.temporaryDirectory.appendingPathComponent("docx-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: tmp) }

        try fm.createDirectory(at: tmp.appendingPathComponent("_rels"), withIntermediateDirectories: true)
        try fm.createDirectory(at: tmp.appendingPathComponent("word/_rels"), withIntermediateDirectories: true)
        try fm.createDirectory(at: tmp.appendingPathComponent("word/media"), withIntermediateDirectories: true)

        var imageCount = 0
        var relationships = ""
        var body = ""

        let text = content.string as NSString
        var location = 0
        while location < text.length {
            let paragraph = text.paragraphRange(for: NSRange(location: location, length: 0))
            body += "<w:p>"
            content.enumerateAttributes(in: paragraph) { attributes, range, _ in
                let runText = text.substring(with: range)

                if let attachment = attributes[.attachment] as? NSTextAttachment,
                   let png = attachmentPNG(attachment) {
                    imageCount += 1
                    let name = "image\(imageCount).png"
                    let rId = "rIdImg\(imageCount)"
                    try? png.data.write(to: tmp.appendingPathComponent("word/media/\(name)"))
                    relationships += """
                        <Relationship Id="\(rId)" \
                        Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" \
                        Target="media/\(name)"/>
                        """
                    let cx = Int(png.size.width * 9525)
                    let cy = Int(png.size.height * 9525)
                    body += inlineImageXML(rId: rId, id: imageCount, cx: cx, cy: cy)
                    return
                }

                let cleaned = runText
                    .replacingOccurrences(of: "\u{FFFC}", with: "")
                    .replacingOccurrences(of: "\n", with: "")
                guard !cleaned.isEmpty else { return }

                var props = ""
                if let font = attributes[.font] as? NSFont {
                    if font.fontDescriptor.symbolicTraits.contains(.bold) { props += "<w:b/>" }
                    props += "<w:sz w:val=\"\(Int(font.pointSize * 2))\"/>"
                }
                if attributes[.link] != nil {
                    props += "<w:color w:val=\"1F6FEB\"/><w:b/>"
                }
                body += "<w:r><w:rPr>\(props)</w:rPr><w:t xml:space=\"preserve\">\(xmlEscape(cleaned))</w:t></w:r>"
            }
            body += "</w:p>"
            location = NSMaxRange(paragraph)
            if paragraph.length == 0 { break }
        }

        // word/document.xml
        let documentXML = """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" \
        xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" \
        xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" \
        xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" \
        xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <w:body>\(body)<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>\
        <w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body>
        </w:document>
        """
        try documentXML.write(to: tmp.appendingPathComponent("word/document.xml"),
                              atomically: true, encoding: .utf8)

        let contentTypes = """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Default Extension="png" ContentType="image/png"/>
        <Override PartName="/word/document.xml" \
        ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
        </Types>
        """
        try contentTypes.write(to: tmp.appendingPathComponent("[Content_Types].xml"),
                               atomically: true, encoding: .utf8)

        let rootRels = """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" \
        Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" \
        Target="word/document.xml"/>
        </Relationships>
        """
        try rootRels.write(to: tmp.appendingPathComponent("_rels/.rels"),
                           atomically: true, encoding: .utf8)

        let docRels = """
        <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        \(relationships)
        </Relationships>
        """
        try docRels.write(to: tmp.appendingPathComponent("word/_rels/document.xml.rels"),
                          atomically: true, encoding: .utf8)

        // Zippen
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
        let zip = Process()
        zip.executableURL = URL(fileURLWithPath: "/usr/bin/zip")
        zip.currentDirectoryURL = tmp
        zip.arguments = ["-r", "-X", "-q", url.path, "[Content_Types].xml", "_rels", "word"]
        try zip.run()
        zip.waitUntilExit()
        guard zip.terminationStatus == 0 else {
            throw NSError(domain: "Sighting", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "DOCX-Archiv konnte nicht erstellt werden."])
        }
    }

    /// PNG-Daten + Punktgröße eines Text-Attachments.
    private static func attachmentPNG(_ attachment: NSTextAttachment)
        -> (data: Data, size: NSSize)? {
        var data: Data?
        if let wrapper = attachment.fileWrapper, wrapper.isRegularFile {
            data = wrapper.regularFileContents
        } else if let image = attachment.image,
                  let tiff = image.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff) {
            data = rep.representation(using: .png, properties: [:])
        }
        guard let data, let image = NSImage(data: data) else { return nil }
        var size = attachment.bounds.size
        if size.width < 1 { size = image.size }
        return (data, size)
    }

    private static func inlineImageXML(rId: String, id: Int, cx: Int, cy: Int) -> String {
        """
        <w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">\
        <wp:extent cx="\(cx)" cy="\(cy)"/>\
        <wp:docPr id="\(id)" name="Bild \(id)"/>\
        <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">\
        <pic:pic>\
        <pic:nvPicPr><pic:cNvPr id="\(id)" name="Bild \(id)"/><pic:cNvPicPr/></pic:nvPicPr>\
        <pic:blipFill><a:blip r:embed="\(rId)"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>\
        <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="\(cx)" cy="\(cy)"/></a:xfrm>\
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>\
        </pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>
        """
    }

    private static func xmlEscape(_ string: String) -> String {
        string
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }
}
