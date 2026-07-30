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
  /** Countdown seconds until auto-leave when the bot is alone in the meeting. */
  aloneLeaveInSeconds?: number;
}

export interface RecordingItem {
  fileName: string;
  sizeBytes: number;
  /** Rounded whole seconds from WAV header; null if unknown. */
  durationSeconds?: number | null;
  lastModified: string;
}

export interface TranscriptItem {
  fileName: string;
  title: string;
  type: string;
  lastModified: string;
}

export interface SummaryItem {
  id: string;
  title: string;
  text: string;
  lastModified: string;
  /** Source transcript file — used to decide Summarize vs View Summary. */
  transcriptFileName: string;
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

export interface LlmConfigStatus {
  configured: boolean;
  gatewayUrl: string;
  model: string;
  apiKeySet: boolean;
  apiKeyPreview: string | null;
  fromEnv: {
    apiKey: boolean;
    gatewayUrl: boolean;
    model: boolean;
  };
  /** Settings override .env when LLM_ALLOW_UI_OVERRIDE is enabled. */
  uiOverride: boolean;
}

export interface BotConfig {
  localParticipantName: string;
  botDisplayName: string;
  llm: LlmConfigStatus;
}

export interface SaveBotConfigInput {
  localParticipantName?: string;
  llmGatewayUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
}

export function getBotConfig(): Promise<BotConfig> {
  return api<BotConfig>("/config");
}

export function saveBotConfig(input: SaveBotConfigInput): Promise<BotConfig> {
  return api<BotConfig>("/config", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function testLlmConnection(model?: string): Promise<{
  ok: boolean;
  gatewayUrl: string;
  model: string;
  error?: string;
}> {
  const res = await fetch("/config/llm/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(model ? { model } : {}),
  });
  const text = await res.text();
  let data: { ok: boolean; gatewayUrl: string; model: string; error?: string };
  try {
    data = text ? JSON.parse(text) : { ok: false, gatewayUrl: "", model: "", error: res.statusText };
  } catch {
    throw new Error(text || res.statusText);
  }
  if (!res.ok && !data.error) {
    data.error = res.statusText;
  }
  return data;
}

export function joinMeeting(
  meetingUrl: string,
  displayName = "e& Assistant",
  opts?: { announceRecordingInChat?: boolean },
): Promise<BotStatus> {
  return api<BotStatus>("/join", {
    method: "POST",
    body: JSON.stringify({
      meetingUrl,
      displayName,
      announceRecordingInChat: opts?.announceRecordingInChat !== false,
    }),
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
  /** Absolute Y from top of screen (prefer this when restoring the full window). */
  top?: number;
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

/** Upload a local .txt file as a transcript (saved as *.transcript.txt on the server). */
export async function uploadTranscript(file: File): Promise<TranscriptItem> {
  if (!file.name.toLowerCase().endsWith(".txt")) {
    throw new Error("Only .txt files are accepted");
  }
  const content = await file.text();
  return api<TranscriptItem>("/transcripts", {
    method: "POST",
    body: JSON.stringify({
      content,
      originalFileName: file.name,
    }),
  });
}

export function listSummaries(): Promise<SummaryItem[]> {
  return api<SummaryItem[]>("/summaries");
}

export function listAvailableModels(): Promise<string[]> {
  return api<{ models: string[] }>("/api/models").then((r) => r.models);
}

/** Manually generate a summary for a transcript (no auto-trigger). */
export function generateSummary(transcriptFileName: string, model?: string): Promise<SummaryItem> {
  return api<SummaryItem>("/summaries", {
    method: "POST",
    body: JSON.stringify({ transcriptFileName, ...(model ? { model } : {}) }),
  });
}

export function recordingPlayUrl(fileName: string): string {
  return `/recordings/${encodeURIComponent(fileName)}`;
}

export function recordingDownloadUrl(fileName: string): string {
  return `/recordings/${encodeURIComponent(fileName)}?download=1`;
}
