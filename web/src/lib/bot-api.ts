export type BotState = "idle" | "joining" | "in_meeting" | "leaving" | "error";

export interface BotStatus {
  state: BotState;
  meetingUrl?: string;
  displayName?: string;
  recordingFile?: string;
  joinedAt?: string;
  lastError?: string;
  paused?: boolean;
  audioLevel?: number;
  localMicOpen?: boolean;
}

export interface RecordingItem {
  fileName: string;
  sizeBytes: number;
  lastModified: string;
}

export interface TranscriptItem {
  fileName: string;
  title: string;
  type: string;
  lastModified: string;
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) },
    ...options,
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(text || res.statusText);
  }
  if (!res.ok) {
    const err = data as { error?: string };
    throw new Error(err?.error || res.statusText);
  }
  return data as T;
}

export function getBotStatus(): Promise<BotStatus> {
  return api<BotStatus>("/status");
}

export function joinMeeting(meetingUrl: string, displayName: string): Promise<BotStatus> {
  return api<BotStatus>("/join", {
    method: "POST",
    body: JSON.stringify({ meetingUrl, displayName }),
  });
}

export function leaveMeeting(): Promise<BotStatus> {
  return api<BotStatus>("/leave", { method: "POST", body: "{}" });
}

export function pauseRecording(): Promise<BotStatus> {
  return api<BotStatus>("/pause", { method: "POST", body: "{}" });
}

export function resumeRecording(): Promise<BotStatus> {
  return api<BotStatus>("/resume", { method: "POST", body: "{}" });
}

export function positionUiWindow(opts: {
  width: number;
  height: number;
  left?: number;
  bottom?: number;
  topmost?: boolean;
}): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>("/ui/window", {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

export function listRecordings(): Promise<RecordingItem[]> {
  return api<RecordingItem[]>("/recordings");
}

export function listTranscripts(): Promise<TranscriptItem[]> {
  return api<TranscriptItem[]>("/transcripts");
}

export function fetchTranscript(fileName: string): Promise<string> {
  return fetch(`/transcripts/${encodeURIComponent(fileName)}`).then(async (res) => {
    if (!res.ok) throw new Error("Could not load transcript");
    return res.text();
  });
}

export function recordingPlayUrl(fileName: string): string {
  return `/recordings/${encodeURIComponent(fileName)}`;
}

export function recordingDownloadUrl(fileName: string): string {
  return `/recordings/${encodeURIComponent(fileName)}?download=1`;
}
