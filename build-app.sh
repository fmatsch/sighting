#!/bin/zsh
# Baut Sighting.app aus dem SwiftPM-Projekt.
set -e
cd "$(dirname "$0")"

CONFIG="${1:-release}"
# Das macOS-27-SDK löst @State/@Binding/… über das externe Compiler-Plugin
# SwiftUIMacros auf, das nur mit vollem Xcode.app mitgeliefert wird (nicht mit
# den Command Line Tools) — ohne Xcode schlägt der Build sonst mit "cannot
# assign to property: 'self' is immutable" fehl. Das ältere, ebenfalls von
# den CLT installierte 26.5-SDK verwendet dafür noch das klassische, in den
# Compiler eingebaute @State (kein Makro) und baut auch ohne Xcode.app.
export SDKROOT="${SDKROOT:-$(xcrun --sdk macosx26.5 --show-sdk-path 2>/dev/null || xcrun --show-sdk-path)}"
swift build -c "$CONFIG"

BIN=".build/$CONFIG/Sighting"
APP="Sighting.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Sighting"
cp Resources/Info.plist "$APP/Contents/Info.plist"
[ -f Resources/AppIcon.icns ] && cp Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

# Optional: Whisper-Modell (~1,6 GB) ins Bundle packen, damit Release-Downloads
# ohne separaten Erstlauf-Download transkribieren können (siehe WhisperService.
# bundledModelURL). Nur mit BUNDLE_WHISPER_MODEL=1, da das jeden normalen Build
# sonst unnötig um ~1,6 GB aufblasen würde.
if [ "$BUNDLE_WHISPER_MODEL" = "1" ]; then
    MODEL_SRC="$HOME/Library/Application Support/Sighting/models/ggml-large-v3-turbo.bin"
    if [ -f "$MODEL_SRC" ]; then
        mkdir -p "$APP/Contents/Resources/models"
        cp "$MODEL_SRC" "$APP/Contents/Resources/models/ggml-large-v3-turbo.bin"
        echo "Whisper-Modell eingebettet ($(du -h "$MODEL_SRC" | cut -f1))"
    else
        echo "BUNDLE_WHISPER_MODEL=1, aber kein Modell unter $MODEL_SRC gefunden — übersprungen." >&2
    fi
fi

codesign --force -s - "$APP" >/dev/null 2>&1 || true
echo "Fertig: $APP"
