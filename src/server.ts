import express, { Request, Response } from 'express';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { TeamsGuestBot } from './bot';
import { applyUiWindowLayout } from './uiWindow';

/** Opens the Web UI in a dedicated app window (not a browser tab). Set OPEN_WEB_UI=0 to skip. */
function openWebUiWindow(port: number): void {
  if (process.env.OPEN_WEB_UI === '0' || process.env.OPEN_WEB_UI === 'false') return;

  const url = `http://localhost:${port}/`;

  // Prefer Edge/Chrome app mode (dedicated window, no tab strip). `start` resolves App Paths on Windows.
  const attempts: Array<{ label: string; command: string; args: string[] }> = [
    { label: 'msedge', command: 'cmd', args: ['/c', 'start', '', 'msedge', `--app=${url}`] },
    { label: 'chrome', command: 'cmd', args: ['/c', 'start', '', 'chrome', `--app=${url}`] },
    { label: 'default', command: 'cmd', args: ['/c', 'start', '', url] },
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

const PORT = Number(process.env.PORT || 3000);
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || path.join(process.cwd(), 'Recordings');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

const bot = new TeamsGuestBot();

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.get('/status', (_req: Request, res: Response) => {
  res.json(bot.getStatus());
});

/**
 * Tells the bot to join a Teams meeting as a guest. Body: { "meetingUrl": "...", "displayName": "..." }
 * Recording starts automatically once it's actually let into the meeting.
 */
app.post('/join', async (req: Request, res: Response) => {
  const { meetingUrl, displayName } = req.body ?? {};
  if (!meetingUrl || typeof meetingUrl !== 'string') {
    return res.status(400).json({ error: 'Request body must include "meetingUrl".' });
  }

  try {
    const status = await bot.join({ meetingUrl, displayName });
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
 * Positions the Meeting Assistant Edge/Chrome window (bottom-left + optional always-on-top).
 * Body: { width, height, left?, bottom?, topmost? }
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
    bottom: req.body?.bottom != null ? Number(req.body.bottom) : undefined,
    topmost: req.body?.topmost !== false,
  });
  res.json({ ok: true });
});

/** Lists recordings currently on disk, newest first. */
app.get('/recordings', (_req: Request, res: Response) => {
  if (!fs.existsSync(RECORDINGS_DIR)) {
    return res.json([]);
  }

  const files = fs
    .readdirSync(RECORDINGS_DIR)
    .filter((f) => f.endsWith('.wav'))
    .map((f) => {
      const stat = fs.statSync(path.join(RECORDINGS_DIR, f));
      return { fileName: f, sizeBytes: stat.size, lastModified: stat.mtime };
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

app.get('/debug/roster-html', async (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/plain');
  res.send(await bot.debugRosterHtml());
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

app.listen(PORT, () => {
  console.log(`teams-guest-bot listening on :${PORT}`);
  console.log(`Web UI: http://localhost:${PORT}`);
  console.log(`Recordings directory: ${RECORDINGS_DIR}`);
  // Slight delay so the server is accepting connections before the window loads.
  setTimeout(() => openWebUiWindow(PORT), 600);
});