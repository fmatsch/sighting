import * as fs from 'fs';
import * as path from 'path';

/**
 * Projektformat: ein Ordner `Name.sighting/` mit einer einzigen
 * `project.json` (Notizen als TipTap-Dokument inkl. eingebetteter
 * Screenshots als data-URIs, Marker, In/Out, Videopfad). Bewusst einfacher
 * als das Mac-Format (RTFD + separate Bilddateien) — vermeidet
 * Datei-Sync-Fehlerquellen, auf Kosten einer etwas größeren project.json.
 * Nicht kompatibel mit dem `.sighting`-Format der macOS-Version.
 */

export interface ProjectData {
  videoPath: string | null;
  markers: { id: string; time: number; colorName: string; label: string }[];
  inPoint: number | null;
  outPoint: number | null;
  notes: unknown; // TipTap/ProseMirror JSON-Dokument
}

export function loadProject(folderPath: string): ProjectData {
  const raw = fs.readFileSync(path.join(folderPath, 'project.json'), 'utf-8');
  return JSON.parse(raw);
}

export function isValidProject(folderPath: string): boolean {
  return (
    folderPath.toLowerCase().endsWith('.sighting') &&
    fs.existsSync(path.join(folderPath, 'project.json'))
  );
}

export function saveProject(folderPath: string, data: ProjectData): void {
  fs.mkdirSync(folderPath, { recursive: true });
  fs.writeFileSync(path.join(folderPath, 'project.json'), JSON.stringify(data), 'utf-8');
}
