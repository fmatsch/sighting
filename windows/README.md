# Sighting für Windows

Electron-Port der [macOS-App](../README.md) mit vollem Funktionsumfang: Video sichten,
automatischer Timecode + Screenshot bei neuen Notizen, klickbare Timecodes, Marker,
Profi-Steuerung, lokale Whisper-Transkription, KI-Bildbeschreibung mit deutscher
Übersetzung (Ollama), Export als PDF/DOCX/CSV.

## Aus dem Quellcode bauen

```bash
cd windows
npm install
npm run dev        # Entwicklungsmodus (öffnet das Fenster direkt)
npm run build:win  # erzeugt release/Sighting-1.0.0-win.zip
```

`build:win` funktioniert auch **von macOS aus** (Cross-Packaging via electron-builder).
Auf Apple-Silicon-Macs wird dafür einmalig Rosetta 2 benötigt (für das mitgelieferte
`rcedit`-Werkzeug, das Icon/Metadaten in die `.exe` schreibt):

```bash
softwareupdate --install-rosetta --agree-to-license
```

## Externe Werkzeuge (optional, wie unter macOS)

- **whisper.cpp** für Transkription: [Windows-Release](https://github.com/ggml-org/whisper.cpp/releases)
  herunterladen, `whisper-cli.exe` in den PATH legen.
- **ffmpeg** für Transkription & MXF-Import: `winget install Gyan.FFmpeg`
- **Ollama** für KI-Bildbeschreibung: [ollama.com](https://ollama.com) (Windows-Installer),
  danach `ollama pull moondream` und `ollama pull qwen2.5:1.5b`

Alle drei bleiben optionale Add-ons — ohne sie funktioniert die App unverändert, nur die
jeweilige Zusatzfunktion zeigt einen Einrichtungshinweis.

## Unterschiede zur Mac-Version

- Bild-für-Bild-Navigation ist eine Zeit-basierte Näherung (angenommene 25fps), da
  HTML5-Video keine echte Frame-Zählung wie AVFoundation kennt.
- Chromiums Video-Decoder unterstützt weniger Profi-Codecs (z. B. kein natives
  ProRes/DNxHD) als AVFoundation.
- `.sighting`-Projekte sind zwischen Mac- und Windows-Version **nicht** austauschbar
  (unterschiedliches internes Format).
- Die `.exe` ist nicht codesigniert — Windows SmartScreen zeigt beim ersten Start eine
  Warnung (analog zur Gatekeeper-Warnung unter macOS).
