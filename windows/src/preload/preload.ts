import { contextBridge, ipcRenderer } from 'electron';

/**
 * Sichere Brücke zwischen Renderer und Main-Prozess. Der Renderer läuft mit
 * contextIsolation und ohne nodeIntegration — jeder Zugriff auf Dateisystem,
 * Subprozesse oder Dialoge läuft über diese Whitelist.
 */
contextBridge.exposeInMainWorld('sighting', {
  // Datei-Dialoge
  openVideoDialog: () => ipcRenderer.invoke('dialog:openVideo'),
  openProjectDialog: () => ipcRenderer.invoke('dialog:openProject'),
  saveProjectDialog: (suggestedName: string) =>
    ipcRenderer.invoke('dialog:saveProject', suggestedName),
  saveExportDialog: (suggestedName: string, kind: 'pdf' | 'docx' | 'csv') =>
    ipcRenderer.invoke('dialog:saveExport', suggestedName, kind),

  // Projekt
  loadProject: (folderPath: string) => ipcRenderer.invoke('project:load', folderPath),
  saveProject: (folderPath: string, data: unknown) =>
    ipcRenderer.invoke('project:save', folderPath, data),

  // Import (MXF-Remux etc.)
  prepareVideo: (filePath: string) => ipcRenderer.invoke('import:prepareVideo', filePath),
  saveScreenshot: (folderPath: string, dataUrl: string, fileName: string) =>
    ipcRenderer.invoke('import:saveScreenshot', folderPath, dataUrl, fileName),

  // Export
  exportDocx: (targetPath: string, payload: unknown) =>
    ipcRenderer.invoke('export:docx', targetPath, payload),
  exportCsv: (targetPath: string, rows: unknown) =>
    ipcRenderer.invoke('export:csv', targetPath, rows),
  exportPdf: (targetPath: string, html: string) =>
    ipcRenderer.invoke('export:pdf', targetPath, html),
  revealInFolder: (filePath: string) => ipcRenderer.invoke('shell:reveal', filePath),

  // Whisper
  whisperStatus: () => ipcRenderer.invoke('whisper:status'),
  whisperDownloadModel: () => ipcRenderer.invoke('whisper:downloadModel'),
  onWhisperDownloadProgress: (cb: (fraction: number) => void) => {
    ipcRenderer.on('whisper:downloadProgress', (_e, fraction) => cb(fraction));
  },
  whisperTranscribe: (videoPath: string, start: number, end: number) =>
    ipcRenderer.invoke('whisper:transcribe', videoPath, start, end),
  onWhisperProgress: (cb: (text: string) => void) => {
    ipcRenderer.on('whisper:progress', (_e, text) => cb(text));
  },

  // Vision (Ollama)
  visionStatus: () => ipcRenderer.invoke('vision:status'),
  visionPullModel: (name: string) => ipcRenderer.invoke('vision:pullModel', name),
  visionDescribe: (dataUrl: string) => ipcRenderer.invoke('vision:describe', dataUrl),
  visionTranslate: (text: string) => ipcRenderer.invoke('vision:translate', text),

  // Einstellungen (persistiert)
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),

  // Menü-Events aus dem Main-Prozess (native Menüleiste löst Renderer-Aktionen aus)
  onMenuAction: (cb: (action: string) => void) => {
    ipcRenderer.on('menu:action', (_e, action) => cb(action));
  },
  setDirty: (isDirty: boolean) => ipcRenderer.invoke('app:setDirty', isDirty),
  confirmDiscardDialog: () => ipcRenderer.invoke('dialog:confirmDiscard'),
  confirmCloseResult: (canClose: boolean) => ipcRenderer.invoke('app:confirmCloseResult', canClose),
  onRequestCloseConfirmation: (cb: () => void) => {
    ipcRenderer.on('app:requestCloseConfirmation', () => cb());
  },
});
