import { Player, formatTimecode } from './player';
import { NotesEditor } from './notesEditor';
import { Timeline } from './timeline';
import { MarkerPanel, Marker } from './markerPanel';

// ---------- Zustand ----------

let currentProjectPath: string | null = null;
let videoSourcePath: string | null = null; // Original-Pfad (wird gespeichert)
let markers: Marker[] = [];
let isDirty = false;
let settings: Record<string, unknown> = { includeScreenshots: true, fullAutoMode: false };

const videoEl = document.getElementById('video') as HTMLVideoElement;
const videoWrap = document.getElementById('video-wrap')!;
const importOverlay = document.getElementById('import-overlay')!;
const player = new Player(videoEl);

const notesEditor = new NotesEditor({
  element: document.getElementById('notes-editor')!,
  onSeek: (t) => player.seek(t),
  onDirty: () => setDirty(true),
  getCurrentTime: () => player.currentTime,
  getScreenshotEnabled: () => settings.includeScreenshots !== false,
  captureFrame: () => (player.hasVideo ? player.captureFrame(480) : null),
});

const markerPanel = new MarkerPanel(
  document.getElementById('marker-list')!,
  document.getElementById('marker-empty')!,
  (t) => player.seek(t),
  () => setDirty(true)
);

const timeline = new Timeline(
  document.getElementById('timeline')!,
  player,
  () => markers,
  (m) => player.seek(m.time)
);

// ---------- Hilfsfunktionen ----------

function setDirty(value: boolean) {
  isDirty = value;
  window.sighting.setDirty(value);
  updateTitle();
}

function updateTitle() {
  const name = currentProjectPath
    ? currentProjectPath.split(/[\\/]/).pop()!.replace(/\.sighting$/i, '')
    : 'Unbenannt';
  document.title = name + (isDirty ? ' — bearbeitet' : '');
}

function renderMarkers() {
  markerPanel.render(
    markers,
    (id) => {
      markers = markers.filter((m) => m.id !== id);
      setDirty(true);
      renderMarkers();
    },
    (id, label) => {
      const m = markers.find((mm) => mm.id === id);
      if (m) m.label = label;
    },
    (id, colorName) => {
      const m = markers.find((mm) => mm.id === id);
      if (m) m.colorName = colorName;
      setDirty(true);
      renderMarkers();
    }
  );
  timeline.render();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- Modale Dialoge ----------

const overlay = document.getElementById('modal-overlay')!;
const modalBox = document.getElementById('modal-box')!;

function closeModal() {
  overlay.classList.add('hidden');
  modalBox.innerHTML = '';
}

function showAlert(title: string, message: string): Promise<void> {
  return new Promise((resolve) => {
    modalBox.innerHTML = `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p><div class="row"><button class="primary" id="m-ok">OK</button></div>`;
    overlay.classList.remove('hidden');
    modalBox.querySelector('#m-ok')!.addEventListener('click', () => {
      closeModal();
      resolve();
    });
  });
}

function showConfirm(title: string, message: string, okLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    modalBox.innerHTML = `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p><div class="row"><button id="m-cancel">Abbrechen</button><button class="primary" id="m-ok">${escapeHtml(okLabel)}</button></div>`;
    overlay.classList.remove('hidden');
    modalBox.querySelector('#m-ok')!.addEventListener('click', () => {
      closeModal();
      resolve(true);
    });
    modalBox.querySelector('#m-cancel')!.addEventListener('click', () => {
      closeModal();
      resolve(false);
    });
  });
}

function showConfirmDiscard(): Promise<'save' | 'discard' | 'cancel'> {
  return window.sighting.confirmDiscardDialog();
}

// ---------- Video laden ----------

async function openVideoFile(filePath: string) {
  importOverlay.classList.remove('hidden');
  try {
    const result = await window.sighting.prepareVideo(filePath);
    videoSourcePath = result.sourcePath;
    player.load('file://' + result.playablePath.replace(/\\/g, '/'));
    videoWrap.classList.add('has-video');
    setDirty(true);
  } catch (err: any) {
    await showAlert('Video konnte nicht geöffnet werden', err.message || String(err));
  } finally {
    importOverlay.classList.add('hidden');
  }
}

async function openVideoDialog() {
  const filePath = await window.sighting.openVideoDialog();
  if (filePath) await openVideoFile(filePath);
}

// ---------- Projekt ----------

async function confirmDiscardIfNeeded(): Promise<boolean> {
  if (!isDirty) return true;
  const choice = await showConfirmDiscard();
  if (choice === 'save') return saveProject();
  if (choice === 'discard') return true;
  return false;
}

function newProject() {
  currentProjectPath = null;
  videoSourcePath = null;
  markers = [];
  notesEditor.setJSON({ type: 'doc', content: [{ type: 'paragraph' }] });
  videoEl.removeAttribute('src');
  videoEl.load();
  videoWrap.classList.remove('has-video');
  player.clearInOut();
  renderMarkers();
  setDirty(false);
}

async function openProjectDialog() {
  if (!(await confirmDiscardIfNeeded())) return;
  const folder = await window.sighting.openProjectDialog();
  if (!folder) return;
  const data = await window.sighting.loadProject(folder);
  currentProjectPath = folder;
  markers = (data.markers as Marker[]) || [];
  notesEditor.setJSON(data.notes || { type: 'doc', content: [{ type: 'paragraph' }] });
  if (data.videoPath) {
    videoSourcePath = data.videoPath;
    try {
      const result = await window.sighting.prepareVideo(data.videoPath);
      player.load('file://' + result.playablePath.replace(/\\/g, '/'));
      videoWrap.classList.add('has-video');
      player.inPoint = data.inPoint ?? null;
      player.outPoint = data.outPoint ?? null;
    } catch {
      await showAlert('Video nicht gefunden', `„${data.videoPath}“ konnte nicht geladen werden.`);
    }
  }
  renderMarkers();
  setDirty(false);
}

async function saveProject(forcePanel = false): Promise<boolean> {
  let target = currentProjectPath;
  if (!target || forcePanel) {
    const suggested = videoSourcePath
      ? videoSourcePath.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '')
      : 'Sichtung';
    const chosen = await window.sighting.saveProjectDialog(suggested);
    if (!chosen) return false;
    target = chosen;
  }
  await window.sighting.saveProject(target, {
    videoPath: videoSourcePath,
    markers,
    inPoint: player.inPoint,
    outPoint: player.outPoint,
    notes: notesEditor.getJSON(),
  });
  currentProjectPath = target;
  setDirty(false);
  return true;
}

function videoBaseName(): string {
  if (videoSourcePath) return videoSourcePath.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '');
  if (currentProjectPath) return currentProjectPath.split(/[\\/]/).pop()!.replace(/\.sighting$/i, '');
  return 'Sichtung';
}

// ---------- Export ----------

async function exportProject(kind: 'pdf' | 'docx' | 'csv' | 'premiere') {
  if (kind === 'premiere' && (!videoSourcePath || !player.hasVideo)) {
    await showAlert('Hinweis', 'Für den Premiere-Export muss ein Video geladen sein.');
    return;
  }
  const target = await window.sighting.saveExportDialog(
    `${videoBaseName()}-Sichtung`,
    kind === 'premiere' ? 'xml' : kind
  );
  if (!target) return;
  const project = {
    videoPath: videoSourcePath,
    markers,
    inPoint: player.inPoint,
    outPoint: player.outPoint,
    notes: notesEditor.getJSON(),
  };
  try {
    if (kind === 'premiere') {
      await window.sighting.exportPremiere(target, {
        project,
        video: { duration: player.duration, width: videoEl.videoWidth, height: videoEl.videoHeight },
      });
    } else if (kind === 'docx') {
      await window.sighting.exportDocx(target, { project, videoName: videoBaseName() });
    } else if (kind === 'csv') {
      await window.sighting.exportCsv(target, { project });
    } else {
      // PDF: HTML im Renderer bauen (gleiche Logik wie exportService.renderExportHtml,
      // aber hier simpel gehalten — Hauptprozess rendert per printToPDF).
      const html = buildExportHtmlFallback(project);
      await window.sighting.exportPdf(target, html);
    }
    await window.sighting.revealInFolder(target);
  } catch (err: any) {
    await showAlert('Export fehlgeschlagen', err.message || String(err));
  }
}

function buildExportHtmlFallback(project: any): string {
  // Für PDF wird der Hauptprozess-Renderer (exportService.renderExportHtml)
  // nicht direkt aufgerufen (läuft im Main-Prozess) — daher hier eine
  // eigenständige, einfache HTML-Repräsentation der aktuellen Notizen.
  const html = document.getElementById('notes-editor')!.innerHTML;
  const markersHtml = markers
    .map((m) => `<p><b>${formatTimecode(m.time)}</b> ${escapeHtml(m.label || '')}</p>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Arial,sans-serif;padding:32px;} img{width:180px;display:block;border-radius:4px;}
    .timecode-link{font-family:monospace;font-weight:bold;color:#1F6FEB;margin-right:6px;}
    </style></head><body>
    <h1>Sichtungsnotizen – ${escapeHtml(videoBaseName())}</h1>
    <p style="color:#666">${escapeHtml(new Date().toLocaleString('de-AT'))}</p>
    ${markers.length ? '<h2>Marker</h2>' + markersHtml : ''}
    ${html}
    </body></html>`;
}

// ---------- Marker ----------

function addMarker(colorName = 'yellow') {
  if (!player.hasVideo) return;
  markers.push({ id: crypto.randomUUID(), time: player.currentTime, colorName, label: '' });
  setDirty(true);
  renderMarkers();
  if (settings.fullAutoMode === true) describeCurrentFrame();
}

// ---------- Whisper ----------

// Einmalig registriert (der Preload hängt bei jedem Aufruf einen weiteren Listener an).
let whisperProgressHandler: ((text: string) => void) | null = null;
let downloadProgressHandler: ((fraction: number) => void) | null = null;

async function ensureWhisperReady(): Promise<boolean> {
  const status = await window.sighting.whisperStatus();
  if (!status.setupProblem) return true;
  await showWhisperSetupModal();
  const recheck = await window.sighting.whisperStatus();
  return !recheck.setupProblem;
}

async function showWhisperSetupModal() {
  return new Promise<void>(async (resolve) => {
    const render = async () => {
      const status = await window.sighting.whisperStatus();
      modalBox.innerHTML = `
        <h2>Whisper einrichten</h2>
        <p>${status.setupProblem ? escapeHtml(status.setupProblem) : 'Alles bereit – Transkription kann starten.'}</p>
        ${
          status.whisperInstalled && status.ffmpegInstalled && !status.modelExists
            ? `<div id="w-progress"></div><button class="primary" id="w-download">Modell „${escapeHtml(status.modelTitle)}“ laden (${escapeHtml(status.modelSize)})</button>`
            : ''
        }
        <div class="row"><button id="w-settings">Anderes Modell oder Sprache …</button><button id="w-close">Schließen</button></div>`;
      modalBox.querySelector('#w-settings')!.addEventListener('click', () => {
        closeModal();
        resolve();
        showSettingsModal();
      });
      modalBox.querySelector('#w-close')!.addEventListener('click', () => {
        closeModal();
        resolve();
      });
      const dlBtn = modalBox.querySelector('#w-download');
      if (dlBtn) {
        dlBtn.addEventListener('click', async () => {
          (dlBtn as HTMLButtonElement).disabled = true;
          dlBtn.textContent = 'Lädt …';
          downloadProgressHandler = (fraction) => {
            const p = modalBox.querySelector('#w-progress');
            if (p) p.textContent = `Lade Modell … ${Math.round(fraction * 100)} %`;
          };
          try {
            await window.sighting.whisperDownloadModel();
          } catch (err: any) {
            await showAlert('Download fehlgeschlagen', err.message || String(err));
          }
          await render();
        });
      }
    };
    overlay.classList.remove('hidden');
    await render();
  });
}

async function transcribeSegment() {
  if (!player.hasVideo || !videoSourcePath) return;
  if (!(await ensureWhisperReady())) return;
  const range = player.selectedRange || { start: 0, end: player.duration };
  if (range.end - range.start < 0.2) {
    await showAlert('Hinweis', 'Bitte zuerst mit „In“ und „Out“ einen Bereich wählen.');
    return;
  }
  const btn = document.getElementById('btn-transcribe') as HTMLButtonElement;
  btn.disabled = true;
  const originalLabel = btn.textContent;
  whisperProgressHandler = (text) => (btn.textContent = text);
  try {
    const segments = await window.sighting.whisperTranscribe(videoSourcePath, range.start, range.end);
    notesEditor.appendTranscriptHeader(range.start, range.end);
    if (segments.length === 0) {
      notesEditor.appendBlock('transcript', range.start, '(keine Sprache erkannt)');
    }
    for (const seg of segments) {
      notesEditor.appendBlock('transcript', seg.start, seg.text);
    }
    setDirty(true);
  } catch (err: any) {
    await showAlert('Transkription fehlgeschlagen', err.message || String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

// ---------- Einstellungen (Sprache, Modell, Schnitterkennung) ----------

const SCENE_SENSITIVITIES: { value: number; label: string }[] = [
  { value: 0.2, label: 'Hoch — auch weiche Schnitte' },
  { value: 0.3, label: 'Normal' },
  { value: 0.45, label: 'Niedrig — nur harte Schnitte' },
];

function sceneThreshold(): number {
  const v = Number(settings.sceneThreshold);
  return SCENE_SENSITIVITIES.some((o) => o.value === v) ? v : 0.3;
}

async function showSettingsModal() {
  return new Promise<void>(async (resolve) => {
    let downloadingId: string | null = null;
    let lastError = '';

    const render = async () => {
      const info = await window.sighting.whisperModels();
      const selected = info.models.find((m) => m.id === info.selectedModelId)!;
      const langOptions = info.languages
        .map((l) => `<option value="${l.code}" ${l.code === info.selectedLanguage ? 'selected' : ''}>${escapeHtml(l.title)}</option>`)
        .join('');
      const modelOptions = info.models
        .map(
          (m) =>
            `<option value="${m.id}" ${m.id === selected.id ? 'selected' : ''}>${escapeHtml(m.title)} (${escapeHtml(m.sizeText)})${m.available ? '  ✓' : ''}</option>`
        )
        .join('');
      const sceneOptions = SCENE_SENSITIVITIES.map(
        (o) => `<option value="${o.value}" ${o.value === sceneThreshold() ? 'selected' : ''}>${o.label}</option>`
      ).join('');

      let status: string;
      if (downloadingId === selected.id) {
        status = '<div id="s-progress" class="hint">Lade Modell … 0 %</div>';
      } else if (selected.available) {
        status = '<div class="status-ok">✓ Heruntergeladen — bereit</div>';
      } else {
        status = `<button class="primary" id="s-download" style="margin-top:8px">Modell laden (${escapeHtml(selected.sizeText)})</button>`;
      }

      modalBox.innerHTML = `
        <h2>Einstellungen</h2>
        <div class="field">
          <label for="s-lang">Transkriptions-Sprache</label>
          <select id="s-lang">${langOptions}</select>
          <div class="hint">„Automatisch“ erkennt die Sprache pro Transkription selbst. Ist sie bekannt, ist die feste Auswahl zuverlässiger — besonders bei kurzen Segmenten.</div>
        </div>
        <div class="field">
          <label for="s-model">Whisper-Modell</label>
          <select id="s-model">${modelOptions}</select>
          <div class="hint">${escapeHtml(selected.hint)}</div>
          ${status}
          ${lastError ? `<div class="status-error">${escapeHtml(lastError)}</div>` : ''}
        </div>
        <div class="field">
          <label for="s-scene">Schnitterkennung</label>
          <select id="s-scene">${sceneOptions}</select>
          <div class="hint">Für „Szenen erkennen und beschreiben“: bei hoher Empfindlichkeit gibt es mehr (und kürzere) Szenen, bei niedriger weniger.</div>
        </div>
        <div class="row"><button class="primary" id="s-close">Fertig</button></div>`;

      modalBox.querySelector('#s-close')!.addEventListener('click', () => {
        closeModal();
        resolve();
      });
      modalBox.querySelector('#s-lang')!.addEventListener('change', async (e) => {
        await window.sighting.setSetting('whisperLanguage', (e.target as HTMLSelectElement).value);
      });
      modalBox.querySelector('#s-model')!.addEventListener('change', async (e) => {
        lastError = '';
        await window.sighting.setSetting('whisperModelId', (e.target as HTMLSelectElement).value);
        await render();
      });
      modalBox.querySelector('#s-scene')!.addEventListener('change', async (e) => {
        settings.sceneThreshold = parseFloat((e.target as HTMLSelectElement).value);
        await window.sighting.setSetting('sceneThreshold', settings.sceneThreshold);
      });
      modalBox.querySelector('#s-download')?.addEventListener('click', async () => {
        downloadingId = selected.id;
        lastError = '';
        downloadProgressHandler = (fraction) => {
          const p = modalBox.querySelector('#s-progress');
          if (p) p.textContent = `Lade Modell … ${Math.round(fraction * 100)} %`;
        };
        await render();
        try {
          await window.sighting.whisperDownloadModel(selected.id);
        } catch (err: any) {
          lastError = err.message || String(err);
        }
        downloadingId = null;
        downloadProgressHandler = null;
        if (!overlay.classList.contains('hidden') && modalBox.querySelector('#s-close')) await render();
      });
    };
    overlay.classList.remove('hidden');
    await render();
  });
}

// ---------- Szenenbeschreibung (Schnitterkennung + KI) ----------

let sceneJobRunning = false;
let sceneJobCancelled = false;

function setSceneButton(text: string | null) {
  const btn = document.getElementById('btn-scenes')!;
  btn.textContent = text ?? '🎞';
  btn.classList.toggle('busy', text !== null);
  btn.title = text
    ? 'Läuft — klicken zum Abbrechen'
    : 'Schnitte erkennen und jede Szene per KI beschreiben (In/Out-Bereich oder ganzes Video)';
}

/** Erkennt Schnitte im In/Out-Bereich (oder im ganzen Video) und beschreibt pro
 * Szene ein Standbild; die Beschreibungen landen mit dem Timecode des
 * Szenenbeginns in den Notizen. Ein erneuter Aufruf während des Laufs bricht ab. */
async function describeScenes() {
  if (sceneJobRunning) {
    sceneJobCancelled = true;
    setSceneButton('Breche ab …');
    window.sighting.sceneCancel();
    return;
  }
  if (!player.hasVideo || !videoSourcePath) return;
  const range = player.selectedRange || { start: 0, end: player.duration };
  if (range.end - range.start <= 1) {
    await showAlert('Hinweis', 'Das Video ist zu kurz für eine Szenenerkennung.');
    return;
  }

  sceneJobRunning = true;
  sceneJobCancelled = false;
  const originalTime = player.currentTime;
  try {
    setSceneButton('Prüfe Ollama …');
    if (!(await ensureVisionReady())) return;
    if (sceneJobCancelled) return;

    setSceneButton('Schnitte … 0 %');
    const shots = await window.sighting.sceneDetect(videoSourcePath, range.start, range.end, sceneThreshold());
    if (sceneJobCancelled || shots.length === 0) return;

    const minutes = Math.max(1, Math.ceil((shots.length * 15) / 60));
    const confirmed = await showConfirm(
      shots.length === 1 ? 'Keine Schnitte gefunden' : `${shots.length} Szenen gefunden`,
      (shots.length === 1
        ? 'Das Segment wird als eine Szene beschrieben. '
        : 'Pro Szene wird ein Standbild beschrieben und mit Timecode in die Notizen eingefügt. ') +
        `Das dauert grob ${minutes} Min. (ca. 15 s pro Szene) und lässt sich jederzeit abbrechen. ` +
        'Mit der Empfindlichkeit in den Einstellungen (Strg+,) ändert sich die Anzahl der Szenen.',
      'Beschreiben'
    );
    if (!confirmed) return;

    player.pause();
    let failed = 0;
    for (let i = 0; i < shots.length; i++) {
      if (sceneJobCancelled) break;
      setSceneButton(`Szene ${i + 1}/${shots.length}`);
      const shot = shots[i];
      // Etwas nach dem Schnitt, damit keine Überblendung erwischt wird.
      const frameTime = shot.start + Math.min(0.8, (shot.end - shot.start) / 2);
      const dataUrl = await player.captureFrameAt(frameTime, 480);

      let english: string | null = null;
      for (let attempt = 0; attempt < 2 && !english && !sceneJobCancelled; attempt++) {
        try {
          english = await window.sighting.visionDescribe(dataUrl); // moondream liefert gelegentlich leer
        } catch {
          english = null;
        }
      }
      if (sceneJobCancelled) break;
      if (!english) {
        failed++;
        continue;
      }
      let german = english;
      try {
        german = await window.sighting.visionTranslate(english);
      } catch {
        // Fallback: englischer Text bleibt stehen
      }
      notesEditor.appendBlock('vision', shot.start, '🖼 ' + german, dataUrl);
      setDirty(true);
    }
    if (failed > 0) {
      await showAlert('Hinweis', `${failed} von ${shots.length} Szenen konnten nicht beschrieben werden.`);
    }
  } catch (err: any) {
    await showAlert('Szenenbeschreibung fehlgeschlagen', err.message || String(err));
  } finally {
    sceneJobRunning = false;
    sceneJobCancelled = false;
    setSceneButton(null);
    if (player.hasVideo) player.seek(originalTime);
  }
}

// ---------- Bildbeschreibung (Ollama) ----------

async function ensureVisionReady(): Promise<boolean> {
  const ready = (s: { ollamaInstalled: boolean; serverRunning: boolean; visionReady: boolean; translationReady: boolean }) =>
    s.ollamaInstalled && s.serverRunning && s.visionReady && s.translationReady;
  if (ready(await window.sighting.visionStatus())) return true;
  await showVisionSetupModal();
  return ready(await window.sighting.visionStatus());
}

async function describeCurrentFrame() {
  if (!player.hasVideo) return;
  if (!(await ensureVisionReady())) return;

  const time = player.currentTime;
  const imageDataUrl = player.captureFrame(480);
  const fullAutoBtn = document.getElementById('btn-fullauto')!;
  fullAutoBtn.textContent = '⏳';
  try {
    const english = await window.sighting.visionDescribe(imageDataUrl);
    let german = english;
    try {
      german = await window.sighting.visionTranslate(english);
    } catch {
      // Fallback: englischer Text bleibt stehen
    }
    notesEditor.appendBlock('vision', time, '🖼 ' + german, imageDataUrl);
    setDirty(true);
  } catch (err: any) {
    await showAlert('Bildbeschreibung fehlgeschlagen', err.message || String(err));
  } finally {
    fullAutoBtn.textContent = '✨';
  }
}

async function showVisionSetupModal() {
  return new Promise<void>(async (resolve) => {
    const render = async () => {
      const status = await window.sighting.visionStatus();
      let body: string;
      if (!status.ollamaInstalled) {
        body = `<p>Ollama ist nicht installiert. Download: <br><a href="https://ollama.com">https://ollama.com</a> (Windows-Installer)</p>`;
      } else if (!status.serverRunning) {
        body = `<p>Ollama ist installiert, läuft aber nicht. Ollama-App starten (läuft danach im Hintergrund).</p><div class="row"><button id="v-recheck">Erneut prüfen</button></div>`;
      } else {
        body = `
          <div class="model-row"><span class="${status.visionReady ? 'ok' : 'pending'}">${status.visionReady ? '✓' : '○'}</span> Bildbeschreibung (moondream, ~1,7 GB)</div>
          <div class="model-row"><span class="${status.translationReady ? 'ok' : 'pending'}">${status.translationReady ? '✓' : '○'}</span> Übersetzung (qwen2.5, ~1 GB)</div>
          ${!status.visionReady || !status.translationReady ? '<div id="v-progress"></div><button class="primary" id="v-pull">Fehlende Modelle jetzt laden</button>' : '<p style="color:#2ea043">Alles bereit – Bildbeschreibung kann starten.</p>'}`;
      }
      modalBox.innerHTML = `<h2>Bildbeschreibung einrichten</h2>
        <p>Optionales Add-on: erzeugt lokal (ohne Cloud) kurze Bildbeschreibungen über Ollama und übersetzt sie ins Deutsche.</p>
        ${body}
        <div class="row"><button id="v-close">Schließen</button></div>`;
      modalBox.querySelector('#v-close')!.addEventListener('click', () => {
        closeModal();
        resolve();
      });
      modalBox.querySelector('#v-recheck')?.addEventListener('click', render);
      modalBox.querySelector('#v-pull')?.addEventListener('click', async () => {
        const progress = modalBox.querySelector('#v-progress')!;
        try {
          if (!status.visionReady) {
            progress.textContent = 'Lädt moondream … (kann einige Minuten dauern)';
            await window.sighting.visionPullModel('moondream');
          }
          if (!status.translationReady) {
            progress.textContent = 'Lädt qwen2.5 … (kann einige Minuten dauern)';
            await window.sighting.visionPullModel('qwen2.5:1.5b');
          }
        } catch (err: any) {
          await showAlert('Modell-Download fehlgeschlagen', err.message || String(err));
        }
        await render();
      });
    };
    overlay.classList.remove('hidden');
    await render();
  });
}

// ---------- Steuerleiste ----------

function updateControlBar() {
  (document.getElementById('btn-play') as HTMLButtonElement).textContent = player.isPlaying ? '⏸' : '▶︎';
  document.getElementById('time-current')!.textContent = formatTimecode(player.currentTime);
  document.getElementById('time-duration')!.textContent = '/ ' + formatTimecode(player.duration);
  document.getElementById('btn-clear-inout')!.classList.toggle('hidden', player.inPoint === null && player.outPoint === null);
  document.getElementById('btn-screenshot-toggle')!.classList.toggle('active', settings.includeScreenshots !== false);
  document.getElementById('btn-fullauto')!.classList.toggle('active', settings.fullAutoMode === true);
  timeline.render();
}

function wireControlBar() {
  document.getElementById('btn-back10')!.addEventListener('click', () => player.skip(-10));
  document.getElementById('btn-fwd10')!.addEventListener('click', () => player.skip(10));
  document.getElementById('btn-play')!.addEventListener('click', () => player.togglePlay());
  document.getElementById('btn-frame-back')!.addEventListener('click', () => player.stepFrames(-1));
  document.getElementById('btn-frame-fwd')!.addEventListener('click', () => player.stepFrames(1));
  document.getElementById('btn-in')!.addEventListener('click', () => { player.setInPoint(); updateControlBar(); });
  document.getElementById('btn-out')!.addEventListener('click', () => { player.setOutPoint(); updateControlBar(); });
  document.getElementById('btn-clear-inout')!.addEventListener('click', () => { player.clearInOut(); updateControlBar(); });
  document.getElementById('btn-transcribe')!.addEventListener('click', () => transcribeSegment());
  document.getElementById('btn-fullauto')!.addEventListener('click', () => {
    settings.fullAutoMode = !(settings.fullAutoMode === true);
    window.sighting.setSetting('fullAutoMode', settings.fullAutoMode);
    updateControlBar();
  });
  document.getElementById('btn-scenes')!.addEventListener('click', () => describeScenes());
  document.getElementById('btn-screenshot-toggle')!.addEventListener('click', () => {
    settings.includeScreenshots = settings.includeScreenshots === false ? true : false;
    window.sighting.setSetting('includeScreenshots', settings.includeScreenshots);
    updateControlBar();
  });
  document.getElementById('btn-marker')!.addEventListener('click', () => addMarker());
  document.getElementById('btn-toggle-sidebar')!.addEventListener('click', () => {
    document.getElementById('marker-sidebar')!.classList.toggle('hidden');
  });

  const rateSelect = document.getElementById('rate-select') as HTMLSelectElement;
  rateSelect.addEventListener('change', () => player.setRate(parseFloat(rateSelect.value)));

  videoEl.addEventListener('loadedmetadata', updateControlBar);
  videoEl.addEventListener('timeupdate', updateControlBar);
  videoEl.addEventListener('play', updateControlBar);
  videoEl.addEventListener('pause', updateControlBar);

  videoWrap.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('#import-overlay')) return;
    if (player.hasVideo) player.togglePlay();
  });
  videoWrap.addEventListener('dragover', (e) => e.preventDefault());
  videoWrap.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) openVideoFile((file as any).path);
  });
}

// ---------- Tastatur-Shortcuts ----------

function isTypingContext(): boolean {
  return notesEditor.isFocused;
}

document.addEventListener('keydown', (e) => {
  if (isTypingContext()) {
    if (e.key === 'Escape') (document.activeElement as HTMLElement)?.blur();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!player.hasVideo) return;

  switch (e.key) {
    case ' ':
      e.preventDefault();
      player.togglePlay();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      if (e.shiftKey) player.skip(-5);
      else player.stepFrames(-1);
      break;
    case 'ArrowRight':
      e.preventDefault();
      if (e.shiftKey) player.skip(5);
      else player.stepFrames(1);
      break;
    case 'j':
      player.skip(-10);
      break;
    case 'k':
      player.togglePlay();
      break;
    case 'l': {
      const rate = player.playFasterCycle();
      rateSelectSync(rate);
      break;
    }
    case 'i':
      player.setInPoint();
      updateControlBar();
      break;
    case 'o':
      player.setOutPoint();
      updateControlBar();
      break;
    case 'm':
      addMarker();
      break;
    default:
      return;
  }
});

function rateSelectSync(rate: number) {
  (document.getElementById('rate-select') as HTMLSelectElement).value = String(rate);
}

// ---------- Menü-Aktionen aus dem Main-Prozess ----------

window.sighting.onMenuAction(async (action) => {
  switch (action) {
    case 'newProject':
      if (await confirmDiscardIfNeeded()) newProject();
      break;
    case 'openProject':
      await openProjectDialog();
      break;
    case 'openVideo':
      await openVideoDialog();
      break;
    case 'save':
      await saveProject(false);
      break;
    case 'saveAs':
      await saveProject(true);
      break;
    case 'exportPdf':
      await exportProject('pdf');
      break;
    case 'exportDocx':
      await exportProject('docx');
      break;
    case 'exportCsv':
      await exportProject('csv');
      break;
    case 'exportPremiere':
      await exportProject('premiere');
      break;
    case 'openSettings':
      await showSettingsModal();
      break;
    case 'describeScenes':
      await describeScenes();
      break;
    case 'togglePlay':
      player.togglePlay();
      break;
    case 'addMarker':
      addMarker();
      break;
    case 'setInPoint':
      player.setInPoint();
      updateControlBar();
      break;
    case 'setOutPoint':
      player.setOutPoint();
      updateControlBar();
      break;
    case 'transcribe':
      await transcribeSegment();
      break;
    case 'toggleScreenshot':
      settings.includeScreenshots = settings.includeScreenshots === false ? true : false;
      window.sighting.setSetting('includeScreenshots', settings.includeScreenshots);
      updateControlBar();
      break;
    case 'describeFrame':
      await describeCurrentFrame();
      break;
    case 'toggleFullAuto':
      settings.fullAutoMode = !(settings.fullAutoMode === true);
      window.sighting.setSetting('fullAutoMode', settings.fullAutoMode);
      updateControlBar();
      break;
  }
});

window.sighting.onRequestCloseConfirmation(async () => {
  const canClose = await confirmDiscardIfNeeded();
  window.sighting.confirmCloseResult(canClose);
});

// ---------- Start ----------

async function init() {
  window.sighting.onWhisperProgress((text) => whisperProgressHandler?.(text));
  window.sighting.onWhisperDownloadProgress((fraction) => downloadProgressHandler?.(fraction));
  window.sighting.onSceneProgress((fraction) => {
    if (sceneJobRunning && !sceneJobCancelled) setSceneButton(`Schnitte … ${Math.round(fraction * 100)} %`);
  });
  settings = await window.sighting.getSettings();
  if (settings.includeScreenshots === undefined) settings.includeScreenshots = true;
  wireControlBar();
  renderMarkers();
  updateControlBar();
  updateTitle();
}

init();
