import * as http from 'http';
import { findExecutable } from './toolPaths';

/**
 * KI-Bildbeschreibung über einen lokalen Ollama-Server: `moondream`
 * beschreibt das Bild (Englisch — reagiert empfindlich auf andere Sprachen/
 * komplexere Prompts und liefert sonst leere/kaputte Antworten), ein
 * zweites kleines Modell (`qwen2.5:1.5b`) übersetzt die Beschreibung ins
 * Deutsche. Reines Add-on: ohne installiertes/laufendes Ollama bleibt der
 * Rest der App unverändert nutzbar.
 */

export const VISION_MODEL = 'moondream';
export const TRANSLATION_MODEL = 'qwen2.5:1.5b';
const BASE_URL = 'http://127.0.0.1:11434';

function postJson(urlPath: string, body: unknown, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      BASE_URL + urlPath,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: timeoutMs,
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(chunks));
          } catch {
            reject(new Error('Antwort von Ollama konnte nicht gelesen werden.'));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung bei der Anforderung.')));
    req.on('error', (err) => reject(err));
    req.write(data);
    req.end();
  });
}

function getJson(urlPath: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get(BASE_URL + urlPath, { timeout: timeoutMs }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(chunks));
        } catch {
          reject(new Error('Antwort von Ollama konnte nicht gelesen werden.'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung bei der Anforderung.')));
    req.on('error', (err) => reject(err));
  });
}

export interface ModelStatus {
  serverRunning: boolean;
  visionReady: boolean;
  translationReady: boolean;
  ollamaInstalled: boolean;
}

async function checkStatusOnce(): Promise<Omit<ModelStatus, 'ollamaInstalled'>> {
  try {
    const root = await getJson('/api/tags', 10000);
    const names: string[] = (root.models || []).map((m: any) => m.name as string);
    return {
      serverRunning: true,
      visionReady: names.some((n) => n.startsWith(VISION_MODEL)),
      translationReady: names.some((n) => n.startsWith(TRANSLATION_MODEL)),
    };
  } catch {
    return { serverRunning: false, visionReady: false, translationReady: false };
  }
}

/** Ein stiller Retry vermeidet falsche "läuft nicht"-Meldungen bei kurzen
 * Verzögerungen (z. B. während Ollama intern ein Modell lädt/entlädt). */
export async function getStatus(): Promise<ModelStatus> {
  const ollamaInstalled = findExecutable('ollama') !== null;
  let status = await checkStatusOnce();
  if (!status.serverRunning) status = await checkStatusOnce();
  return { ...status, ollamaInstalled };
}

export function pullModel(name: string): Promise<void> {
  return postJson('/api/pull', { name, stream: false }, 1800000).then(() => undefined);
}

export async function describe(imageBase64Jpeg: string): Promise<string> {
  const root = await postJson(
    '/api/generate',
    {
      model: VISION_MODEL,
      prompt: 'Describe this image briefly.',
      images: [imageBase64Jpeg],
      stream: false,
    },
    120000
  );
  const text = (root.response || '').trim();
  if (!text) {
    throw new Error(
      'Das Modell hat für dieses Bild keine Beschreibung geliefert (kommt bei ' +
        'ungewöhnlichem Bildinhalt gelegentlich vor) — einfach erneut versuchen.'
    );
  }
  return text;
}

export async function translateToGerman(text: string): Promise<string> {
  const root = await postJson(
    '/api/generate',
    {
      model: TRANSLATION_MODEL,
      prompt:
        'You are a professional English-to-German translator. Translate the following ' +
        'sentence into natural, grammatically correct German. Output ONLY the translation, ' +
        `no explanations, no quotes.\n\nSentence: ${text}`,
      stream: false,
    },
    120000
  );
  const translated = (root.response || '').trim().replace(/^"|"$/g, '');
  if (!translated) throw new Error('Übersetzung konnte nicht gelesen werden.');
  return translated;
}
