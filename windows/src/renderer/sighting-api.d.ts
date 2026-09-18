import type { ProjectData } from '../main/services/projectStore';

export interface WhisperStatus {
  whisperInstalled: boolean;
  ffmpegInstalled: boolean;
  modelExists: boolean;
  setupProblem: string | null;
}

export interface WhisperSegment {
  start: number;
  text: string;
}

export interface VisionModelStatus {
  serverRunning: boolean;
  visionReady: boolean;
  translationReady: boolean;
  ollamaInstalled: boolean;
}

export interface PrepareVideoResult {
  playablePath: string;
  sourcePath: string;
  wasRemuxed: boolean;
}

export interface SightingApi {
  openVideoDialog(): Promise<string | null>;
  openProjectDialog(): Promise<string | null>;
  saveProjectDialog(suggestedName: string): Promise<string | null>;
  saveExportDialog(suggestedName: string, kind: 'pdf' | 'docx' | 'csv'): Promise<string | null>;

  loadProject(folderPath: string): Promise<ProjectData>;
  saveProject(folderPath: string, data: ProjectData): Promise<void>;

  prepareVideo(filePath: string): Promise<PrepareVideoResult>;
  saveScreenshot(folderPath: string, dataUrl: string, fileName: string): Promise<string>;

  exportDocx(targetPath: string, payload: { project: ProjectData; videoName: string }): Promise<void>;
  exportCsv(targetPath: string, payload: { project: ProjectData }): Promise<void>;
  exportPdf(targetPath: string, html: string): Promise<void>;
  revealInFolder(filePath: string): Promise<void>;

  whisperStatus(): Promise<WhisperStatus>;
  whisperDownloadModel(): Promise<void>;
  onWhisperDownloadProgress(cb: (fraction: number) => void): void;
  whisperTranscribe(videoPath: string, start: number, end: number): Promise<WhisperSegment[]>;
  onWhisperProgress(cb: (text: string) => void): void;

  visionStatus(): Promise<VisionModelStatus>;
  visionPullModel(name: string): Promise<void>;
  visionDescribe(dataUrl: string): Promise<string>;
  visionTranslate(text: string): Promise<string>;

  getSettings(): Promise<Record<string, unknown>>;
  setSetting(key: string, value: unknown): Promise<void>;

  onMenuAction(cb: (action: string) => void): void;
  setDirty(isDirty: boolean): Promise<void>;
  confirmDiscardDialog(): Promise<'save' | 'discard' | 'cancel'>;
  confirmCloseResult(canClose: boolean): Promise<void>;
  onRequestCloseConfirmation(cb: () => void): void;
}

declare global {
  interface Window {
    sighting: SightingApi;
  }
}
