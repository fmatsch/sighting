import { app, BrowserWindow, Menu, MenuItem, dialog, ipcMain, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

import * as whisperService from './services/whisperService';
import * as visionService from './services/visionService';
import * as importService from './services/importService';
import * as exportService from './services/exportService';
import * as projectStore from './services/projectStore';

let mainWindow: BrowserWindow | null = null;
let isDirty = false;
let allowClose = false;

// Nur eine Instanz gleichzeitig — verhindert doppelt gestartete Prozesse mit
// verwirrendem Fenster-/Fokuszustand.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
  } catch {
    return {};
  }
}

function writeSetting(key: string, value: unknown) {
  const settings = readSettings();
  settings[key] = value;
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings), 'utf-8');
}

let screenshotMenuItem: MenuItem | undefined;
let fullAutoMenuItem: MenuItem | undefined;

function send(action: string) {
  mainWindow?.webContents.send('menu:action', action);
}

function buildMenu() {
  const settings = readSettings();
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Datei',
      submenu: [
        { label: 'Neues Projekt', accelerator: 'CmdOrCtrl+N', click: () => send('newProject') },
        { label: 'Projekt öffnen …', accelerator: 'CmdOrCtrl+O', click: () => send('openProject') },
        { type: 'separator' },
        { label: 'Video öffnen …', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('openVideo') },
        { type: 'separator' },
        { label: 'Sichern', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: 'Sichern unter …', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('saveAs') },
        { type: 'separator' },
        { label: 'Als PDF exportieren …', accelerator: 'CmdOrCtrl+E', click: () => send('exportPdf') },
        {
          label: 'Als DOCX exportieren …',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => send('exportDocx'),
        },
        { label: 'Timecodes als CSV exportieren …', click: () => send('exportCsv') },
        { type: 'separator' },
        { role: 'quit', label: 'Beenden' },
      ],
    },
    {
      label: 'Bearbeiten',
      submenu: [
        { role: 'undo', label: 'Widerrufen' },
        { role: 'redo', label: 'Wiederholen' },
        { type: 'separator' },
        { role: 'cut', label: 'Ausschneiden' },
        { role: 'copy', label: 'Kopieren' },
        { role: 'paste', label: 'Einfügen' },
        { role: 'selectAll', label: 'Alles auswählen' },
      ],
    },
    {
      label: 'Sichten',
      submenu: [
        { label: 'Wiedergabe/Pause', accelerator: 'CmdOrCtrl+P', click: () => send('togglePlay') },
        { label: 'Marker setzen', accelerator: 'CmdOrCtrl+M', click: () => send('addMarker') },
        {
          label: 'In-Punkt setzen',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => send('setInPoint'),
        },
        {
          label: 'Out-Punkt setzen',
          accelerator: 'CmdOrCtrl+Alt+O',
          click: () => send('setOutPoint'),
        },
        { type: 'separator' },
        {
          label: 'Segment transkribieren',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => send('transcribe'),
        },
        { type: 'separator' },
        {
          label: 'Screenshot bei neuer Notiz einfügen',
          type: 'checkbox',
          checked: settings.includeScreenshots !== false,
          click: () => send('toggleScreenshot'),
        },
        { type: 'separator' },
        {
          label: 'Bild beschreiben (KI)',
          accelerator: 'CmdOrCtrl+Shift+B',
          click: () => send('describeFrame'),
        },
        {
          label: 'Vollautomatik (KI-Bildbeschreibung bei jedem Marker)',
          type: 'checkbox',
          checked: settings.fullAutoMode === true,
          click: () => send('toggleFullAuto'),
        },
      ],
    },
    {
      label: 'Ansicht',
      submenu: [
        { role: 'reload', label: 'Neu laden' },
        { role: 'toggleDevTools', label: 'Entwicklertools' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Originalgröße' },
        { role: 'zoomIn', label: 'Vergrößern' },
        { role: 'zoomOut', label: 'Verkleinern' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Vollbild' },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  const sichtenMenu = menu.items.find((i) => i.label === 'Sichten')?.submenu;
  screenshotMenuItem = sichtenMenu?.items.find((i) => i.label.startsWith('Screenshot'));
  fullAutoMenuItem = sichtenMenu?.items.find((i) => i.label.startsWith('Vollautomatik'));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 760,
    minWidth: 760,
    minHeight: 560,
    title: 'Sighting',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => console.error('[Sighting] did-fail-load', code, desc));
  mainWindow.webContents.on('render-process-gone', (_e, details) => console.error('[Sighting] render-process-gone', details));

  mainWindow.on('close', (e) => {
    if (allowClose || !isDirty) return;
    e.preventDefault();
    mainWindow?.webContents.send('app:requestCloseConfirmation');
  });
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((err) => {
  console.error('[Sighting] whenReady failed:', err);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC: Dialoge ----------

ipcMain.handle('dialog:openVideo', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: 'Video zum Sichten auswählen',
    properties: ['openFile'],
    filters: [
      { name: 'Videos', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'mxf', 'm4v'] },
      { name: 'Alle Dateien', extensions: ['*'] },
    ],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:openProject', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: 'Ein .sighting-Projekt auswählen',
    properties: ['openDirectory'],
  });
  if (result.canceled) return null;
  const folder = result.filePaths[0];
  if (!projectStore.isValidProject(folder)) {
    dialog.showMessageBoxSync(mainWindow!, {
      type: 'warning',
      message: `„${path.basename(folder)}“ ist kein gültiges Sighting-Projekt.`,
    });
    return null;
  }
  return folder;
});

ipcMain.handle('dialog:saveProject', async (_e, suggestedName: string) => {
  const result = await dialog.showSaveDialog(mainWindow!, {
    title: 'Projekt sichern (Ordner .sighting)',
    defaultPath: suggestedName.endsWith('.sighting') ? suggestedName : `${suggestedName}.sighting`,
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath.endsWith('.sighting') ? result.filePath : `${result.filePath}.sighting`;
});

ipcMain.handle('dialog:saveExport', async (_e, suggestedName: string, kind: string) => {
  const ext = kind;
  const result = await dialog.showSaveDialog(mainWindow!, {
    title: 'Export sichern',
    defaultPath: `${suggestedName}.${ext}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  return result.canceled || !result.filePath ? null : result.filePath;
});

ipcMain.handle('shell:reveal', (_e, filePath: string) => shell.showItemInFolder(filePath));

// ---------- IPC: Projekt ----------

ipcMain.handle('project:load', (_e, folderPath: string) => projectStore.loadProject(folderPath));
ipcMain.handle('project:save', (_e, folderPath: string, data: projectStore.ProjectData) => {
  projectStore.saveProject(folderPath, data);
});

// ---------- IPC: Import ----------

ipcMain.handle('import:prepareVideo', (_e, filePath: string) => importService.prepareVideo(filePath));

ipcMain.handle('import:saveScreenshot', (_e, folderPath: string, dataUrl: string, fileName: string) => {
  const mediaDir = path.join(folderPath, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const base64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
  fs.writeFileSync(path.join(mediaDir, fileName), Buffer.from(base64, 'base64'));
  return path.join('media', fileName);
});

// ---------- IPC: Export ----------

ipcMain.handle('export:docx', async (_e, targetPath: string, payload: { project: projectStore.ProjectData; videoName: string }) => {
  await exportService.generateDocx(payload.project, payload.videoName, targetPath);
});

ipcMain.handle('export:csv', (_e, targetPath: string, payload: { project: projectStore.ProjectData }) => {
  exportService.generateCsv(payload.project, targetPath);
});

ipcMain.handle('export:pdf', async (_e, targetPath: string, html: string) => {
  const printWin = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const pdfBuffer = await printWin.webContents.printToPDF({ printBackground: true });
  fs.writeFileSync(targetPath, pdfBuffer);
  printWin.destroy();
});

// ---------- IPC: Whisper ----------

ipcMain.handle('whisper:status', () => whisperService.getStatus());
ipcMain.handle('whisper:downloadModel', async () => {
  await whisperService.downloadModel((fraction) => {
    mainWindow?.webContents.send('whisper:downloadProgress', fraction);
  });
});
ipcMain.handle('whisper:transcribe', async (_e, videoPath: string, start: number, end: number) => {
  return whisperService.transcribe(videoPath, start, end, (text) => {
    mainWindow?.webContents.send('whisper:progress', text);
  });
});

// ---------- IPC: Vision (Ollama) ----------

ipcMain.handle('vision:status', () => visionService.getStatus());
ipcMain.handle('vision:pullModel', (_e, name: string) => visionService.pullModel(name));
ipcMain.handle('vision:describe', (_e, dataUrl: string) => {
  const base64 = dataUrl.substring(dataUrl.indexOf(',') + 1);
  return visionService.describe(base64);
});
ipcMain.handle('vision:translate', (_e, text: string) => visionService.translateToGerman(text));

// ---------- IPC: Einstellungen ----------

ipcMain.handle('settings:get', () => readSettings());
ipcMain.handle('settings:set', (_e, key: string, value: unknown) => {
  writeSetting(key, value);
  if (key === 'includeScreenshots' && screenshotMenuItem) screenshotMenuItem.checked = value as boolean;
  if (key === 'fullAutoMode' && fullAutoMenuItem) fullAutoMenuItem.checked = value as boolean;
});

// ---------- IPC: Schließen mit ungesicherten Änderungen ----------

ipcMain.handle('app:setDirty', (_e, dirty: boolean) => {
  isDirty = dirty;
});
ipcMain.handle('app:confirmCloseResult', (_e, canClose: boolean) => {
  if (canClose) {
    allowClose = true;
    mainWindow?.close();
  }
});
ipcMain.handle('dialog:confirmDiscard', async () => {
  const result = await dialog.showMessageBox(mainWindow!, {
    type: 'warning',
    message: 'Änderungen sichern?',
    detail: 'Das aktuelle Projekt enthält ungesicherte Änderungen.',
    buttons: ['Sichern', 'Verwerfen', 'Abbrechen'],
    defaultId: 0,
    cancelId: 2,
  });
  return (['save', 'discard', 'cancel'] as const)[result.response];
});
