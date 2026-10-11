import { app } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { findExecutable } from './toolPaths';

/**
 * Lokale Transkription über whisper.cpp (whisper-cli), analog zur
 * macOS-Version: ffmpeg extrahiert das In/Out-Segment als 16-kHz-WAV,
 * whisper-cli transkribiert nach JSON. Optionales Add-on — ohne
 * installiertes whisper-cli/ffmpeg bleibt die App ansonsten unverändert.
 */

export interface WhisperModelInfo {
  id: string;
  title: string;
  sizeText: string;
  hint: string;
}

/** Nur mehrsprachige Modelle — die „.en"-Varianten verstehen kein Deutsch. */
export const MODELS: WhisperModelInfo[] = [
  { id: 'tiny', title: 'Tiny', sizeText: '78 MB', hint: 'Sehr schnell, aber für Deutsch meist zu ungenau.' },
  { id: 'base', title: 'Base', sizeText: '148 MB', hint: 'Schnell, einfache Genauigkeit — nur für sehr klare Sprache.' },
  { id: 'small', title: 'Small', sizeText: '488 MB', hint: 'Brauchbarer Kompromiss für klare Aufnahmen.' },
  { id: 'medium', title: 'Medium', sizeText: '1,5 GB', hint: 'Gute Genauigkeit, deutlich langsamer als Turbo.' },
  { id: 'large-v3-turbo', title: 'Large v3 Turbo', sizeText: '1,6 GB', hint: 'Empfohlen: nahezu Large-Qualität, aber deutlich schneller.' },
  { id: 'large-v3', title: 'Large v3', sizeText: '3,1 GB', hint: 'Höchste Genauigkeit, am langsamsten und speicherhungrig.' },
];

export const DEFAULT_MODEL_ID = 'large-v3-turbo';

export const LANGUAGES: { code: string; title: string }[] = [
  ['auto', 'Automatisch erkennen'], ['de', 'Deutsch'], ['en', 'Englisch'],
  ['fr', 'Französisch'], ['es', 'Spanisch'], ['it', 'Italienisch'],
  ['pt', 'Portugiesisch'], ['nl', 'Niederländisch'], ['pl', 'Polnisch'],
  ['cs', 'Tschechisch'], ['sk', 'Slowakisch'], ['hu', 'Ungarisch'],
  ['sl', 'Slowenisch'], ['hr', 'Kroatisch'], ['sr', 'Serbisch'],
  ['ro', 'Rumänisch'], ['tr', 'Türkisch'], ['ru', 'Russisch'],
  ['uk', 'Ukrainisch'], ['ar', 'Arabisch'], ['he', 'Hebräisch'],
  ['hi', 'Hindi'], ['zh', 'Chinesisch'], ['ja', 'Japanisch'],
  ['ko', 'Koreanisch'], ['sv', 'Schwedisch'], ['da', 'Dänisch'],
  ['no', 'Norwegisch'], ['fi', 'Finnisch'], ['el', 'Griechisch'],
].map(([code, title]) => ({ code, title }));

export function resolveModelId(id: unknown): string {
  return MODELS.some((m) => m.id === id) ? (id as string) : DEFAULT_MODEL_ID;
}

export function resolveLanguage(code: unknown): string {
  return LANGUAGES.some((l) => l.code === code) ? (code as string) : 'auto';
}

function modelFile(modelId: string): string {
  return `ggml-${modelId}.bin`;
}

function modelPath(modelId: string): string {
  return path.join(app.getPath('userData'), 'models', modelFile(modelId));
}

function modelUrl(modelId: string): string {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${modelFile(modelId)}`;
}

export function listModels(): (WhisperModelInfo & { available: boolean })[] {
  return MODELS.map((m) => ({ ...m, available: fs.existsSync(modelPath(m.id)) }));
}

export interface WhisperStatus {
  whisperInstalled: boolean;
  ffmpegInstalled: boolean;
  modelExists: boolean;
  modelTitle: string;
  modelSize: string;
  setupProblem: string | null;
}

export function getStatus(modelId: string): WhisperStatus {
  const model = MODELS.find((m) => m.id === resolveModelId(modelId))!;
  const whisperInstalled = findExecutable('whisper-cli') !== null;
  const ffmpegInstalled = findExecutable('ffmpeg') !== null;
  const modelExists = fs.existsSync(modelPath(model.id));

  let setupProblem: string | null = null;
  if (!whisperInstalled) {
    setupProblem =
      'whisper-cli wurde nicht gefunden. Download der Windows-Release: ' +
      'https://github.com/ggml-org/whisper.cpp/releases (whisper-cli.exe in den PATH legen).';
  } else if (!ffmpegInstalled) {
    setupProblem = 'ffmpeg wurde nicht gefunden. Installation: winget install Gyan.FFmpeg';
  } else if (!modelExists) {
    setupProblem = `Das Whisper-Modell „${model.title}“ (${model.sizeText}) muss einmalig geladen werden.`;
  }
  return {
    whisperInstalled,
    ffmpegInstalled,
    modelExists,
    modelTitle: model.title,
    modelSize: model.sizeText,
    setupProblem,
  };
}

export function downloadModel(modelId: string, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = resolveModelId(modelId);
    const dest = modelPath(id);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmpDest = dest + '.download';
    const file = fs.createWriteStream(tmpDest);
    const fail = (err: Error) => {
      file.destroy();
      fs.unlink(tmpDest, () => {});
      reject(err);
    };

    const request = (url: string) => {
      https
        .get(url, (response) => {
          if (
            response.statusCode &&
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {
            response.resume();
            request(response.headers.location);
            return;
          }
          if (response.statusCode !== 200) {
            response.resume();
            fail(new Error(`Download fehlgeschlagen (HTTP ${response.statusCode}).`));
            return;
          }
          const total = parseInt(response.headers['content-length'] || '0', 10);
          let received = 0;
          response.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (total > 0) onProgress(received / total);
          });
          response.pipe(file);
          file.on('finish', () => {
            file.close(() => {
              fs.renameSync(tmpDest, dest);
              resolve();
            });
          });
        })
        .on('error', fail);
    };
    request(modelUrl(id));
  });
}

export interface WhisperSegment {
  start: number; // Sekunden, relativ zum Video
  text: string;
}

export function transcribe(
  videoPath: string,
  start: number,
  end: number,
  modelId: string,
  language: string,
  onProgress: (text: string) => void
): Promise<WhisperSegment[]> {
  return new Promise((resolve, reject) => {
    const ffmpeg = findExecutable('ffmpeg');
    const whisper = findExecutable('whisper-cli');
    if (!ffmpeg || !whisper) {
      reject(new Error('whisper-cli oder ffmpeg nicht gefunden.'));
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'sighting-whisper-'));
    const wavPath = path.join(tmpDir, 'segment.wav');
    const outBase = path.join(tmpDir, 'transcript');

    const cleanup = () => {
      fs.rm(tmpDir, { recursive: true, force: true }, () => {});
    };

    onProgress('Extrahiere Audio …');
    const ff = spawn(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-ss',
      String(start),
      '-to',
      String(end),
      '-i',
      videoPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      wavPath,
    ]);
    let ffError = '';
    ff.stderr.on('data', (d) => (ffError += d.toString()));
    ff.on('close', (code) => {
      if (code !== 0) {
        cleanup();
        reject(new Error(`ffmpeg-Fehler: ${ffError.slice(-400)}`));
        return;
      }

      onProgress('Transkribiere … 0 %');
      const wp = spawn(whisper, [
        '-m',
        modelPath(resolveModelId(modelId)),
        '-f',
        wavPath,
        '-l',
        resolveLanguage(language),
        '-oj',
        '-of',
        outBase,
        '--print-progress',
      ]);
      let wpError = '';
      wp.stderr.on('data', (d) => {
        const text = d.toString();
        wpError += text;
        const match = text.match(/progress\s*=\s*(\d+)%/);
        if (match) onProgress(`Transkribiere … ${match[1]} %`);
      });
      wp.on('close', (wcode) => {
        if (wcode !== 0) {
          cleanup();
          reject(new Error(`Whisper-Fehler: ${wpError.slice(-400)}`));
          return;
        }
        try {
          const json = JSON.parse(fs.readFileSync(outBase + '.json', 'utf-8'));
          const entries: any[] = json.transcription || [];
          const segments: WhisperSegment[] = entries
            .map((entry) => {
              const text = (entry.text || '').trim();
              const fromMs = entry.offsets?.from;
              if (!text || typeof fromMs !== 'number') return null;
              return { start: start + fromMs / 1000, text };
            })
            .filter((s): s is WhisperSegment => s !== null);
          cleanup();
          resolve(segments);
        } catch (e) {
          cleanup();
          reject(new Error('Whisper-Ausgabe konnte nicht gelesen werden.'));
        }
      });
    });
  });
}
