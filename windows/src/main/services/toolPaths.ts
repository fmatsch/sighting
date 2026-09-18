import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Sucht ein externes Kommandozeilen-Werkzeug (whisper-cli, ffmpeg, ollama).
 * Prüft zunächst den PATH (via `where`/`which`), dann ein paar übliche
 * Installationsorte je Plattform. Gibt den vollen Pfad zurück oder null.
 */
export function findExecutable(name: string): string | null {
  const isWin = process.platform === 'win32';
  const exeName = isWin ? `${name}.exe` : name;

  try {
    const finder = isWin ? 'where' : 'which';
    const result = execFileSync(finder, [exeName], { encoding: 'utf-8' }).trim();
    const first = result.split(/\r?\n/)[0];
    if (first && fs.existsSync(first)) return first;
  } catch {
    // nicht im PATH — weiter mit bekannten Installationsorten
  }

  const candidates = isWin
    ? [
        path.join(process.env['ProgramFiles'] || 'C:\\Program Files', name, `${name}.exe`),
        path.join(
          process.env['LOCALAPPDATA'] || '',
          'Programs',
          name,
          `${name}.exe`
        ),
        path.join(process.env['LOCALAPPDATA'] || '', name, `${name}.exe`),
      ]
    : [
        `/opt/homebrew/bin/${name}`,
        `/usr/local/bin/${name}`,
        `/usr/bin/${name}`,
      ];

  return candidates.find((p) => p && fs.existsSync(p)) || null;
}
