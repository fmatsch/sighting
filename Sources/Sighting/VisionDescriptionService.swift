import AppKit

/// Erzeugt Bildbeschreibungen von Video-Standbildern lokal über Ollama
/// (Vision-Language-Modell, Standard: `moondream`). Reines Add-on: ohne
/// installiertes/laufendes Ollama bleibt die Funktion inert und zeigt nur
/// einen Einrichtungshinweis — der Rest der App bleibt unberührt.
final class VisionDescriptionService: ObservableObject {
    @Published var isDescribing = false
    @Published var isPullingModel = false
    @Published var lastError: String?

    static let model = "moondream"
    private static let baseURL = URL(string: "http://127.0.0.1:11434")!

    static func findExecutable(_ name: String) -> String? {
        let candidates = ["/opt/homebrew/bin/\(name)", "/usr/local/bin/\(name)", "/usr/bin/\(name)"]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    var ollamaInstalled: Bool { Self.findExecutable("ollama") != nil }

    struct ServiceError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    // MARK: Status

    /// Prüft asynchron, ob der Ollama-Server läuft und das Vision-Modell
    /// vorhanden ist. `running` unterscheidet "Server nicht erreichbar" von
    /// "Server läuft, Modell fehlt noch" für eine präzisere Fehlermeldung.
    func checkStatus(completion: @escaping (_ modelReady: Bool, _ serverRunning: Bool) -> Void) {
        var request = URLRequest(url: Self.baseURL.appendingPathComponent("api/tags"))
        // Ein nicht laufender Server verweigert die Verbindung praktisch
        // sofort — ein großzügiges Timeout kostet in dem Fall also nichts,
        // vermeidet aber falsche Fehlalarme beim ersten Request nach
        // App-Start (kurze Verzögerung durch Netzwerk-Stack-Warmup).
        request.timeoutInterval = 6
        URLSession.shared.dataTask(with: request) { data, _, error in
            guard let data, error == nil,
                  let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let models = root["models"] as? [[String: Any]] else {
                DispatchQueue.main.async { completion(false, false) }
                return
            }
            let names = models.compactMap { ($0["name"] as? String)?.split(separator: ":").first.map(String.init) }
            DispatchQueue.main.async { completion(names.contains(Self.model), true) }
        }.resume()
    }

    /// Was fehlt noch, bevor Bildbeschreibungen möglich sind? (Nur der
    /// Installations-Check — Server-/Modell-Status kommt aus checkStatus.)
    var setupProblem: String? {
        guard !ollamaInstalled else { return nil }
        return "Ollama ist nicht installiert. Installation im Terminal:\n" +
            "brew install ollama\n" +
            "Danach einmalig starten: brew services start ollama"
    }

    // MARK: Modell laden

    func pullModel(completion: @escaping (Bool) -> Void) {
        guard !isPullingModel else { return }
        isPullingModel = true
        lastError = nil

        var request = URLRequest(url: Self.baseURL.appendingPathComponent("api/pull"))
        request.httpMethod = "POST"
        request.timeoutInterval = 1800
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["name": Self.model, "stream": false])

        URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            DispatchQueue.main.async {
                self?.isPullingModel = false
                if let error {
                    self?.lastError = "Modell-Download fehlgeschlagen: \(error.localizedDescription)"
                    completion(false)
                    return
                }
                guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                    self?.lastError = "Modell-Download fehlgeschlagen — läuft „ollama serve“ / " +
                        "„brew services start ollama“?"
                    completion(false)
                    return
                }
                completion(true)
            }
        }.resume()
    }

    // MARK: Beschreiben

    func describe(image: NSImage, completion: @escaping (Result<String, ServiceError>) -> Void) {
        guard let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85]) else {
            completion(.failure(ServiceError(message: "Bild konnte nicht kodiert werden.")))
            return
        }

        var request = URLRequest(url: Self.baseURL.appendingPathComponent("api/generate"))
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // moondream ist ein kleines, englisch-zentriertes 1B-Modell: es reagiert
        // empfindlich auf Prompt-Formulierung (deutsche oder längere/komplexere
        // Prompts liefern zuverlässig leere oder kaputte Antworten) — nur der
        // schlichte, kurze englische Prompt funktioniert stabil. Die
        // Beschreibung erscheint dadurch auf Englisch statt auf Deutsch.
        let body: [String: Any] = [
            "model": Self.model,
            "prompt": "Describe this image briefly.",
            "images": [jpeg.base64EncodedString()],
            "stream": false,
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        isDescribing = true
        lastError = nil
        URLSession.shared.dataTask(with: request) { [weak self] data, _, error in
            DispatchQueue.main.async {
                self?.isDescribing = false
                if let error {
                    let message = "Ollama nicht erreichbar: \(error.localizedDescription)"
                    self?.lastError = message
                    completion(.failure(ServiceError(message: message)))
                    return
                }
                guard let data,
                      let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    let message = "Antwort von Ollama konnte nicht gelesen werden."
                    self?.lastError = message
                    completion(.failure(ServiceError(message: message)))
                    return
                }
                guard let text = root["response"] as? String, !text.isEmpty else {
                    let message = "Das Modell hat für dieses Bild keine Beschreibung geliefert " +
                        "(kommt bei ungewöhnlichem Bildinhalt gelegentlich vor) — einfach erneut versuchen."
                    self?.lastError = message
                    completion(.failure(ServiceError(message: message)))
                    return
                }
                completion(.success(text.trimmingCharacters(in: .whitespacesAndNewlines)))
            }
        }.resume()
    }
}
