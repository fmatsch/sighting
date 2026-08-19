import AppKit

/// Erzeugt Bildbeschreibungen von Video-Standbildern lokal über Ollama
/// (Vision-Language-Modell `moondream`) und übersetzt sie anschließend mit
/// einem zweiten, kleinen Textmodell (`qwen2.5:1.5b`) ins Deutsche — das
/// englisch-zentrierte Vision-Modell selbst kann kein zuverlässiges Deutsch.
/// Reines Add-on: ohne installiertes/laufendes Ollama bleibt die Funktion
/// inert und zeigt nur einen Einrichtungshinweis — der Rest der App bleibt
/// unberührt.
final class VisionDescriptionService: ObservableObject {
    @Published var isDescribing = false
    @Published var isPullingModel = false
    @Published var lastError: String?

    static let visionModel = "moondream"
    static let translationModel = "qwen2.5:1.5b"
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

    /// Welche der beiden benötigten Modelle fehlen noch?
    struct ModelStatus {
        var serverRunning = false
        var visionReady = false
        var translationReady = false
        var allReady: Bool { serverRunning && visionReady && translationReady }
    }

    /// Prüft asynchron, ob der Ollama-Server läuft und beide Modelle
    /// (Bildbeschreibung + Übersetzung) vorhanden sind. Ollama antwortet auf
    /// diesen Endpunkt gelegentlich mit spürbarer Verzögerung (z. B. während
    /// es intern ein Modell lädt/entlädt) — ein einzelner stiller Retry
    /// vermeidet dadurch verursachte falsche "läuft nicht"-Meldungen.
    func checkStatus(completion: @escaping (ModelStatus) -> Void) {
        checkStatusOnce { [weak self] status in
            if status.serverRunning {
                completion(status)
            } else {
                self?.checkStatusOnce(completion: completion)
            }
        }
    }

    private func checkStatusOnce(completion: @escaping (ModelStatus) -> Void) {
        var request = URLRequest(url: Self.baseURL.appendingPathComponent("api/tags"))
        request.timeoutInterval = 10
        URLSession.shared.dataTask(with: request) { data, _, error in
            guard let data, error == nil,
                  let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let models = root["models"] as? [[String: Any]] else {
                DispatchQueue.main.async { completion(ModelStatus()) }
                return
            }
            let names = Set(models.compactMap { ($0["name"] as? String) })
            var status = ModelStatus()
            status.serverRunning = true
            status.visionReady = names.contains { $0.hasPrefix(Self.visionModel) }
            status.translationReady = names.contains { $0.hasPrefix(Self.translationModel) }
            DispatchQueue.main.async { completion(status) }
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

    func pullModel(_ name: String, completion: @escaping (Bool) -> Void) {
        guard !isPullingModel else { return }
        isPullingModel = true
        lastError = nil

        var request = URLRequest(url: Self.baseURL.appendingPathComponent("api/pull"))
        request.httpMethod = "POST"
        request.timeoutInterval = 1800
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["name": name, "stream": false])

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
        // Wenn Ollama das Modell gerade erst (neu) laden muss, kann allein das
        // je nach Arbeitsspeicherauslastung ~15-20s dauern, bevor überhaupt
        // mit der eigentlichen Inferenz begonnen wird — großzügig bemessen.
        request.timeoutInterval = 120
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // moondream ist ein kleines, englisch-zentriertes 1B-Modell: es reagiert
        // empfindlich auf Prompt-Formulierung (deutsche oder längere/komplexere
        // Prompts liefern zuverlässig leere oder kaputte Antworten) — nur der
        // schlichte, kurze englische Prompt funktioniert stabil. Die englische
        // Ausgabe wird anschließend separat über translate(_:) eingedeutscht.
        let body: [String: Any] = [
            "model": Self.visionModel,
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

    // MARK: Übersetzen

    /// Übersetzt einen englischen Text mit einem kleinen Textmodell ins
    /// Deutsche. Schlägt die Übersetzung fehl, liefert der Aufrufer im
    /// Fehlerfall einfach den englischen Originaltext weiter.
    func translateToGerman(_ text: String, completion: @escaping (Result<String, ServiceError>) -> Void) {
        var request = URLRequest(url: Self.baseURL.appendingPathComponent("api/generate"))
        request.httpMethod = "POST"
        // Ollama muss ggf. vom Vision- aufs Übersetzungsmodell umschalten
        // (Modell aus dem Speicher laden) — ebenso großzügig bemessen.
        request.timeoutInterval = 120
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "model": Self.translationModel,
            "prompt": "You are a professional English-to-German translator. Translate the following " +
                "sentence into natural, grammatically correct German. Output ONLY the translation, " +
                "no explanations, no quotes.\n\nSentence: \(text)",
            "stream": false,
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        // Denselben Indikator wie describe() weiterlaufen lassen, damit die
        // Werkzeugleiste während der gesamten Kette (Beschreiben + Übersetzen)
        // durchgehend einen Ladehinweis zeigt statt zwischendurch "fertig".
        isDescribing = true
        URLSession.shared.dataTask(with: request) { data, _, error in
            DispatchQueue.main.async {
                self.isDescribing = false
                if let error {
                    completion(.failure(ServiceError(message: "Übersetzung fehlgeschlagen: \(error.localizedDescription)")))
                    return
                }
                guard let data,
                      let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let translated = root["response"] as? String,
                      !translated.isEmpty else {
                    completion(.failure(ServiceError(message: "Übersetzung konnte nicht gelesen werden.")))
                    return
                }
                completion(.success(translated.trimmingCharacters(in: .whitespacesAndNewlines)
                    .trimmingCharacters(in: CharacterSet(charactersIn: "\""))))
            }
        }.resume()
    }
}
