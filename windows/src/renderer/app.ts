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

async function exportProject(kind: 'pdf' | 'docx' | 'csv') {
  const target = await window.sighting.saveExportDialog(`${videoBaseName()}-Sichtung`, kind);
  if (!target) return;
  const project = {
    videoPath: videoSourcePath,
    markers,
    inPoint: player.inPoint,
    outPoint: player.outPoint,
    notes: notesEditor.getJSON(),
  };
  try {
    if (kind === 'docx') {
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
            ? '<div id="w-progress"></div><button class="primary" id="w-download">Modell jetzt laden (~1,6 GB)</button>'
            : ''
        }
        <div class="row"><button id="w-close">Schließen</button></div>`;
      modalBox.querySelector('#w-close')!.addEventListener('click', () => {
        closeModal();
        resolve();
      });
      const dlBtn = modalBox.querySelector('#w-download');
      if (dlBtn) {
        dlBtn.addEventListener('click', async () => {
          (dlBtn as HTMLButtonElement).disabled = true;
          dlBtn.textContent = 'Lädt …';
          window.sighting.onWhisperDownloadProgress((fraction) => {
            const p = modalBox.querySelector('#w-progress');
            if (p) p.textContent = `Lade Modell … ${Math.round(fraction * 100)} %`;
          });
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
  window.sighting.onWhisperProgress((text) => (btn.textContent = text));
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

// ---------- Bildbeschreibung (Ollama) ----------

async function describeCurrentFrame() {
  if (!player.hasVideo) return;
  let status = await window.sighting.visionStatus();
  if (!status.ollamaInstalled) {
    await showVisionSetupModal();
    return;
  }
  if (!status.serverRunning || !status.visionReady || !status.translationReady) {
    await showVisionSetupModal();
    status = await window.sighting.visionStatus();
    if (!status.serverRunning || !status.visionReady || !status.translationReady) return;
  }

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
  settings = await window.sighting.getSettings();
  if (settings.includeScreenshots === undefined) settings.includeScreenshots = true;
  wireControlBar();
  renderMarkers();
  updateControlBar();
  updateTitle();
}

init();
