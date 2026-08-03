import './bootstrapWinEnv';
import express, { Request, Response } from 'express';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { TeamsGuestBot } from './bot';
import { applyUiWindowLayout } from './uiWindow';
import { bootstrapUserConfig, getLocalParticipantName, getEffectiveLlmConfig, getEffectiveTranscriptionConfig, isLlmConfigured, loadUserConfig, maskApiKey, saveUserConfig } from './userConfig';
import {
  findSummaryByTranscript,
  generateSummaryForTranscript,
  getSummaryById,
  listSummaries,
} from './summaries';
import { checkLLMConnection, listAvailableModels, resetLlmClient } from './llmClient';
import { getWavDurationMs } from './wavTrim';
import { isRosterAutomationEnabled } from './teamsJoin';
import {
  discoverTranscriptionEngines,
  invalidateTranscriptionEnginesCache,
  isValidTranscriptionEngineId,
} from './transcriptionEngines';

bootstrapUserConfig();
{
  const name = getLocalParticipantName();
  if (name) {
    console.log(`Local participant [mute-gated mic]: ${name}`);
  } else {
    console.log('Local participant name: not set — Web UI will ask on first open');
  }
}

/** Opens the Web UI in a dedicated app window (not a browser tab). Set OPEN_WEB_UI=0 to skip. */
function openWebUiWindow(port: number): void {
  if (process.env.OPEN_WEB_UI === '0' || process.env.OPEN_WEB_UI === 'false') return;

  const url = `http://localhost:${port}/`;

  // Prefer launching the browser binary directly — `cmd /c start` can flash a console window.
  const attempts: Array<{ label: string; command: string; args: string[] }> = [
    { label: 'msedge', command: 'msedge', args: [`--app=${url}`] },
    { label: 'chrome', command: 'chrome', args: [`--app=${url}`] },
    // Fallbacks when Edge/Chrome aren't on PATH (App Paths via start).
    { label: 'msedge-start', command: 'cmd', args: ['/c', 'start', '', '/b', 'msedge', `--app=${url}`] },
    { label: 'chrome-start', command: 'cmd', args: ['/c', 'start', '', '/b', 'chrome', `--app=${url}`] },
    // Corporate policy sometimes blocks --app= launches from Node; plain URL often still works.
    { label: 'default-browser', command: 'cmd', args: ['/c', 'start', '', '', url] },
  ];

  const tryNext = (i: number) => {
    if (i >= attempts.length) {
      console.warn('Could not auto-open Web UI — open it manually:', url);
      return;
    }
    const attempt = attempts[i];
    try {
      const child = spawn(attempt.command, attempt.args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
      });
      child.unref();
      child.on('error', () => tryNext(i + 1));
      console.log(`Opening Web UI in a new window (${attempt.label})`);
    } catch {
      tryNext(i + 1);
    }
  };

  tryNext(0);
}

/** Preferred port first, then 3001, then a less common fallback. */
function getPortCandidates(): number[] {
  const preferred = Number(process.env.PORT || 3000);
  const fallbacks = [3001, 3847];
  const seen = new Set<number>();
  const candidates: number[] = [];
  for (const port of [preferred, ...fallbacks]) {
    if (!Number.isFinite(port) || port < 1 || port > 65535 || seen.has(port)) continue;
    seen.add(port);
    candidates.push(port);
  }
  return candidates;
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, '127.0.0.1');
  });
}

async function resolveListenPort(candidates: number[]): Promise<number> {
  for (let i = 0; i < candidates.length; i++) {
    const port = candidates[i];
    if (await isPortAvailable(port)) {
      if (i > 0) {
        console.warn(
          `[server] Port ${candidates[0]} is in use — using ${port} instead.`,
        );
      }
      return port;
    }
    if (i < candidates.length - 1) {
      console.warn(`[server] Port ${port} is in use, trying next...`);
    }
  }
  throw new Error(`All candidate ports are in use: ${candidates.join(', ')}`);
}

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(process.cwd(), 'Recordings');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(PUBLIC_DIR));

const bot = new TeamsGuestBot();

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.get('/status', (_req: Request, res: Response) => {
  res.json(bot.getStatus());
});

/** Local user settings (Teams display name, LLM for summarization). */
function buildConfigResponse() {
  const llm = getEffectiveLlmConfig();
  const file = loadUserConfig();
  const transcription = getEffectiveTranscriptionConfig();
  return {
    localParticipantName: getLocalParticipantName(),
    botDisplayName: process.env.DEFAULT_DISPLAY_NAME || 'e& Assistant',
    llm: {
      configured: isLlmConfigured(),
      gatewayUrl: llm.gatewayUrl,
      model: llm.model,
      apiKeySet: Boolean(llm.apiKey),
      apiKeyPreview: maskApiKey(llm.apiKey),
      fromEnv: llm.fromEnv,
      uiOverride: llm.uiOverride,
    },
    transcription: {
      enabled: transcription.enabled,
      engine: transcription.engine,
      model: transcription.model,
      pythonPath: transcription.pythonPath,
      device: transcription.device,
      saved: {
        enabled: file.transcriptionEnabled,
        engine: file.transcriptionEngine,
        model: file.transcriptionModel,
        pythonPath: file.transcriptionPythonPath,
        device: file.transcriptionDevice,
      },
    },
  };
}

app.get('/config', (_req: Request, res: Response) => {
  res.json(buildConfigResponse());
});

app.put('/config', (req: Request, res: Response) => {
  const body = req.body ?? {};
  const partial: Parameters<typeof saveUserConfig>[0] = {};

  if (body.localParticipantName !== undefined) {
    if (typeof body.localParticipantName !== 'string' || !body.localParticipantName.trim()) {
      return res.status(400).json({ error: 'localParticipantName must be a non-empty string.' });
    }
    partial.localParticipantName = body.localParticipantName;
  }

  if (body.llmGatewayUrl !== undefined) {
    if (typeof body.llmGatewayUrl !== 'string') {
      return res.status(400).json({ error: 'llmGatewayUrl must be a string.' });
    }
    partial.llmGatewayUrl = body.llmGatewayUrl;
  }

  if (body.llmApiKey !== undefined) {
    if (typeof body.llmApiKey !== 'string') {
      return res.status(400).json({ error: 'llmApiKey must be a string.' });
    }
    partial.llmApiKey = body.llmApiKey;
  }

  if (body.llmModel !== undefined) {
    if (typeof body.llmModel !== 'string') {
      return res.status(400).json({ error: 'llmModel must be a string.' });
    }
    partial.llmModel = body.llmModel;
  }

  if (body.transcriptionEnabled !== undefined) {
    if (typeof body.transcriptionEnabled !== 'boolean') {
      return res.status(400).json({ error: 'transcriptionEnabled must be a boolean.' });
    }
    partial.transcriptionEnabled = body.transcriptionEnabled;
  }

  if (body.transcriptionEngine !== undefined) {
    if (typeof body.transcriptionEngine !== 'string') {
      return res.status(400).json({ error: 'transcriptionEngine must be a string.' });
    }
    const engine = body.transcriptionEngine.trim();
    if (engine && !isValidTranscriptionEngineId(engine)) {
      return res.status(400).json({ error: `Unknown transcription engine: ${engine}` });
    }
    partial.transcriptionEngine = engine;
  }

  if (body.transcriptionModel !== undefined) {
    if (typeof body.transcriptionModel !== 'string') {
      return res.status(400).json({ error: 'transcriptionModel must be a string.' });
    }
    partial.transcriptionModel = body.transcriptionModel;
  }

  if (body.transcriptionPythonPath !== undefined) {
    if (typeof body.transcriptionPythonPath !== 'string') {
      return res.status(400).json({ error: 'transcriptionPythonPath must be a string.' });
    }
    partial.transcriptionPythonPath = body.transcriptionPythonPath;
  }

  if (body.transcriptionDevice !== undefined) {
    if (typeof body.transcriptionDevice !== 'string') {
      return res.status(400).json({ error: 'transcriptionDevice must be a string.' });
    }
    const device = body.transcriptionDevice.trim();
    if (device !== 'cpu' && device !== 'cuda') {
      return res.status(400).json({ error: 'transcriptionDevice must be cpu or cuda.' });
    }
    partial.transcriptionDevice = device;
  }

  if (Object.keys(partial).length === 0) {
    return res.status(400).json({ error: 'No settings provided.' });
  }

  try {
    const cfg = saveUserConfig(partial);
    resetLlmClient();
    if (partial.localParticipantName) {
      console.log(`[config] Local participant name set to "${cfg.localParticipantName}"`);
    }
    if (
      partial.llmGatewayUrl !== undefined ||
      partial.llmApiKey !== undefined ||
      partial.llmModel !== undefined
    ) {
      console.log('[config] LLM settings updated');
    }
    if (
      partial.transcriptionEnabled !== undefined ||
      partial.transcriptionEngine !== undefined ||
      partial.transcriptionModel !== undefined
    ) {
      console.log('[config] Transcription settings updated');
    }
    res.json(buildConfigResponse());
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** Test LLM gateway connectivity with the current saved/env configuration. */
app.post('/config/llm/test', async (req: Request, res: Response) => {
  const model =
    typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : undefined;
  const result = await checkLLMConnection(model);
  res.status(result.ok ? 200 : 400).json(result);
});

/** Discover STT engines already installed on this machine (import-only probe). */
app.get('/api/transcription/engines', async (req: Request, res: Response) => {
  try {
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    if (refresh) invalidateTranscriptionEnginesCache();
    const result = await discoverTranscriptionEngines({ refresh });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * Tells the bot to join a Teams meeting as a guest.
 * Body: { "meetingUrl": "...", "displayName": "...", "announceRecordingInChat": true|false }
 * Recording starts automatically once it's actually let into the meeting.
 */
app.post('/join', async (req: Request, res: Response) => {
  const { meetingUrl, displayName, announceRecordingInChat } = req.body ?? {};
  if (!meetingUrl || typeof meetingUrl !== 'string') {
    return res.status(400).json({ error: 'Request body must include "meetingUrl".' });
  }

  try {
    const status = await bot.join({
      meetingUrl,
      displayName,
      announceRecordingInChat: announceRecordingInChat !== false,
    });
    res.status(202).json(status);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Tells the bot to leave the current meeting and finalize the recording. */
app.post('/leave', async (_req: Request, res: Response) => {
  try {
    const status = await bot.leave();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Pause recording (audio silence + skip live captions) while staying in the meeting. */
app.post('/pause', async (_req: Request, res: Response) => {
  try {
    const status = await bot.setPaused(true);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Resume recording and caption capture. */
app.post('/resume', async (_req: Request, res: Response) => {
  try {
    const status = await bot.setPaused(false);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * Positions the Meeting Assistant Edge/Chrome window.
 * Body: { width, height, left?, top?, bottom?, topmost? }
 * `topmost` defaults to false — must be explicitly true for the mini overlay.
 */
app.post('/ui/window', (req: Request, res: Response) => {
  const width = Number(req.body?.width);
  const height = Number(req.body?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 100 || height < 40) {
    return res.status(400).json({ error: 'width/height required' });
  }
  applyUiWindowLayout({
    width: Math.round(width),
    height: Math.round(height),
    left: req.body?.left != null ? Number(req.body.left) : undefined,
    top: req.body?.top != null ? Number(req.body.top) : undefined,
    bottom: req.body?.bottom != null ? Number(req.body.bottom) : undefined,
    topmost: req.body?.topmost === true || req.body?.topmost === 'true',
  });
  res.json({ ok: true });
});

/** Best-effort PCM WAV duration (parses fmt + data chunks). */
function wavDurationSeconds(filePath: string): number | null {
  try {
    const ms = getWavDurationMs(filePath);
    if (ms == null || !Number.isFinite(ms)) return null;
    return ms / 1000;
  } catch {
    return null;
  }
}

/** Lists recordings currently on disk, newest first. */
app.get('/recordings', (_req: Request, res: Response) => {
  if (!fs.existsSync(RECORDINGS_DIR)) {
    return res.json([]);
  }

  const files = fs
    .readdirSync(RECORDINGS_DIR)
    .filter((f) => f.endsWith('.wav'))
    .map((f) => {
      const filePath = path.join(RECORDINGS_DIR, f);
      const stat = fs.statSync(filePath);
      const durationSeconds = wavDurationSeconds(filePath);
      return {
        fileName: f,
        sizeBytes: stat.size,
        durationSeconds: durationSeconds != null ? Math.round(durationSeconds) : null,
        lastModified: stat.mtime,
      };
    })
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

  res.json(files);
});

/** Streams or downloads a recording by file name (as returned from /recordings). */
app.get('/recordings/:fileName', (req: Request, res: Response) => {
  const { fileName } = req.params;
  if (fileName.includes('..') || path.basename(fileName) !== fileName) {
    return res.status(400).json({ error: 'Invalid file name.' });
  }

  const filePath = path.join(RECORDINGS_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Not found.' });
  }

  const forceDownload = req.query.download === '1' || req.query.download === 'true';
  if (forceDownload) {
    return res.download(filePath);
  }

  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Accept-Ranges', 'bytes');
  res.sendFile(filePath);
});

/** Lists transcript / meeting-note files, newest first. */
app.get('/transcripts', (_req: Request, res: Response) => {
  if (!fs.existsSync(RECORDINGS_DIR)) {
    return res.json([]);
  }

  const suffixes = [
    { ext: '.named_transcript.txt', type: 'Whisper + names' },
    { ext: '.transcript.txt', type: 'Live captions' },
  ];

  const items: Array<{ fileName: string; title: string; type: string; lastModified: Date }> = [];
  for (const entry of fs.readdirSync(RECORDINGS_DIR)) {
    for (const { ext, type } of suffixes) {
      if (!entry.endsWith(ext)) continue;
      const stat = fs.statSync(path.join(RECORDINGS_DIR, entry));
      const base = entry.slice(0, -ext.length);
      items.push({
        fileName: entry,
        title: base,
        type,
        lastModified: stat.mtime,
      });
    }
  }

  items.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  res.json(items);
});

/** Returns a single transcript file as plain text. */
app.get('/transcripts/:fileName', (req: Request, res: Response) => {
  const { fileName } = req.params;
  if (
    fileName.includes('..') ||
    path.basename(fileName) !== fileName ||
    (!fileName.endsWith('.transcript.txt') && !fileName.endsWith('.named_transcript.txt'))
  ) {
    return res.status(400).json({ error: 'Invalid transcript file name.' });
  }

  const filePath = path.join(RECORDINGS_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Not found.' });
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(fs.readFileSync(filePath, 'utf8'));
});

/**
 * Upload a plain .txt transcript from the user's device.
 * Body: { "content": "...", "originalFileName": "notes.txt" }
 * Saved as `*.transcript.txt` so it appears in the Transcripts list and can be summarized.
 */
app.post('/transcripts', (req: Request, res: Response) => {
  const content = req.body?.content;
  const originalFileName =
    typeof req.body?.originalFileName === 'string' ? req.body.originalFileName.trim() : '';

  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'content is required.' });
  }
  if (!originalFileName || !originalFileName.toLowerCase().endsWith('.txt')) {
    return res.status(400).json({ error: 'Only .txt files are accepted.' });
  }

  const baseName = path.basename(originalFileName).replace(/\.txt$/i, '');
  const safe =
    baseName
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'upload';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const title = `${safe}_${stamp}`;
  const fileName = `${title}.transcript.txt`;

  if (!fs.existsSync(RECORDINGS_DIR)) {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  }
  const filePath = path.join(RECORDINGS_DIR, fileName);
  fs.writeFileSync(filePath, content, 'utf8');
  const stat = fs.statSync(filePath);

  res.status(201).json({
    fileName,
    title,
    type: 'Uploaded',
    lastModified: stat.mtime.toISOString(),
  });
});

/** Lists AI summaries, newest first. */
app.get('/summaries', (_req: Request, res: Response) => {
  res.json(listSummaries());
});

/** Lists available completion models from the configured gateway. */
app.get('/api/models', async (_req: Request, res: Response) => {
  try {
    const models = await listAvailableModels();
    res.json({ models });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Returns one summary by id (summary file name) or by source transcript file name. */
app.get('/summaries/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id || id.includes('..') || path.basename(id) !== id) {
    return res.status(400).json({ error: 'Invalid summary id.' });
  }
  const summary = getSummaryById(id) ?? (() => {
    try {
      return findSummaryByTranscript(id);
    } catch {
      return null;
    }
  })();
  if (!summary) return res.status(404).json({ error: 'Not found.' });
  res.json(summary);
});

/**
 * Manually generate a summary for a transcript.
 * Body: { "transcriptFileName": "....transcript.txt", "model"?: string, "force"?: boolean }
 * Cached by content hash: regenerates when the preprocessed transcript or model changes.
 * Pass force:true to regenerate regardless.
 */
app.post('/summaries', async (req: Request, res: Response) => {
  const transcriptFileName = req.body?.transcriptFileName;
  if (typeof transcriptFileName !== 'string' || !transcriptFileName.trim()) {
    return res.status(400).json({ error: 'transcriptFileName is required.' });
  }
  const model =
    typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : undefined;
  const force = req.body?.force === true || req.body?.force === 'true';
  try {
    const summary = await generateSummaryForTranscript(transcriptFileName.trim(), model, force);
    res.status(201).json(summary);
  } catch (err) {
    const message = (err as Error).message || 'Summary generation failed.';
    const status = /not found/i.test(message) ? 404 : /invalid/i.test(message) ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

app.get('/debug/roster-html', async (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/plain');
  res.send(await bot.debugRosterHtml());
});

/** Dump HTML from the bot's meeting page (optional ?selector= CSS selector). */
app.get('/debug/page-html', async (req: Request, res: Response) => {
  const selector = typeof req.query.selector === 'string' ? req.query.selector : undefined;
  res.setHeader('Content-Type', 'text/plain');
  res.send(await bot.debugPageHtml(selector));
});

// SPA fallback for cozy-meet-helper UI (after API routes).
app.get('*', (req: Request, res: Response, next) => {
  if (req.method !== 'GET') return next();
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  const shellPath = path.join(PUBLIC_DIR, '_shell.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  if (fs.existsSync(shellPath)) {
    return res.sendFile(shellPath);
  }
  return next();
});

void (async () => {
  let port: number;
  try {
    port = await resolveListenPort(getPortCandidates());
  } catch (err) {
    console.error('[server]', (err as Error).message);
    process.exit(1);
  }

  process.env.PORT = String(port);

  app.listen(port, () => {
    console.log(`teams-guest-bot listening on :${port}`);
    console.log(`Web UI: http://localhost:${port}`);
    console.log(`Recordings directory: ${RECORDINGS_DIR}`);
    if (!isRosterAutomationEnabled()) {
      console.log('[server] DISABLE_ROSTER_AUTOMATION=1 — bot will not auto-open People (UI debugging).');
    }
    // Slight delay so the server is accepting connections before the window loads.
    setTimeout(() => openWebUiWindow(port), 600);
  });
})();