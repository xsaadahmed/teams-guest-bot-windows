import OpenAI from 'openai';
import { getEffectiveLlmConfig } from './userConfig';

// ---------------------------------------------------------------------------
// Configuration (env + saved settings; tunables remain env-only)
// ---------------------------------------------------------------------------

/** Approximate chars-per-token heuristic used only for chunk sizing. */
const CHARS_PER_TOKEN_ESTIMATE = 4;

const TUNING = {
  /** Max transcript characters sent in one completion request. */
  maxCharsPerRequest: envInt('LLM_MAX_CHARS_PER_REQUEST', 24_000 * CHARS_PER_TOKEN_ESTIMATE),
  /** Overlap between sequential chunks so context isn't lost at boundaries. */
  chunkOverlapChars: envInt('LLM_CHUNK_OVERLAP_CHARS', 500),
  /** Completion budget for a single summary call. */
  maxTokens: envInt('LLM_MAX_TOKENS', 1024),
  temperature: envFloat('LLM_TEMPERATURE', 0.1),
  /** Total attempts including the first try. */
  maxAttempts: envInt('LLM_MAX_ATTEMPTS', 3),
  /** Base delay (ms) for exponential backoff between retries. */
  retryBaseDelayMs: envInt('LLM_RETRY_BASE_DELAY_MS', 1000),
  /** Hard timeout (ms) for a single gateway HTTP call. */
  requestTimeoutMs: envInt('LLM_REQUEST_TIMEOUT_MS', 60_000),
} as const;

const SYSTEM_PROMPT = 'Summarize what happened in the meeting and list any action items.';

const SETTINGS_HINT =
  'Add your API key and gateway URL in Settings (or set LLM_API_KEY and LLM_GATEWAY_URL).';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Missing/invalid LLM env configuration — fail fast before calling the gateway. */
export class LlmConfigError extends Error {
  readonly code = 'LLM_CONFIG' as const;

  constructor(message: string) {
    super(message);
    this.name = 'LlmConfigError';
  }
}

/** Gateway/API/runtime failure after config was valid. */
export class LlmRequestError extends Error {
  readonly code = 'LLM_REQUEST' as const;
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'LlmRequestError';
    this.cause = cause;
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function runtimeCredentials(): { gatewayUrl: string; apiKey: string; model: string } {
  const eff = getEffectiveLlmConfig();
  return {
    gatewayUrl: eff.gatewayUrl,
    apiKey: eff.apiKey,
    model: eff.model,
  };
}

function assertConfig(creds = runtimeCredentials()): void {
  const missing: string[] = [];
  if (!creds.gatewayUrl) missing.push('gateway URL');
  if (!creds.apiKey) missing.push('API key');
  if (missing.length > 0) {
    throw new LlmConfigError(`LLM is not configured (${missing.join(' and ')} missing). ${SETTINGS_HINT}`);
  }
  if (TUNING.chunkOverlapChars >= TUNING.maxCharsPerRequest) {
    throw new LlmConfigError(
      'LLM_CHUNK_OVERLAP_CHARS must be smaller than LLM_MAX_CHARS_PER_REQUEST.',
    );
  }
}

function resolveModel(model?: string): string {
  const trimmed = model?.trim();
  if (trimmed) return trimmed;
  const { model: defaultModel } = runtimeCredentials();
  if (defaultModel) return defaultModel;
  throw new LlmConfigError(
    `No default model configured. Set one in Settings (or LLM_MODEL), or pick a model from the dropdown.`,
  );
}

// ---------------------------------------------------------------------------
// Client (lazy — recreated when credentials change)
// ---------------------------------------------------------------------------

let client: OpenAI | null = null;
let clientFingerprint = '';

/** Drop the cached OpenAI client after settings change. */
export function resetLlmClient(): void {
  client = null;
  clientFingerprint = '';
}

function getClient(): OpenAI {
  const creds = runtimeCredentials();
  assertConfig(creds);
  const fingerprint = `${creds.gatewayUrl}\0${creds.apiKey}`;
  if (client && clientFingerprint === fingerprint) return client;

  client = new OpenAI({
    baseURL: creds.gatewayUrl,
    apiKey: creds.apiKey,
    timeout: TUNING.requestTimeoutMs,
    maxRetries: 0,
  });
  clientFingerprint = fingerprint;
  return client;
}

function logInfo(message: string): void {
  console.log(`[llm] ${message}`);
}

function logWarn(message: string): void {
  console.warn(`[llm] ${message}`);
}

/** Safe error text for logs (never includes API keys). */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isRetryable(err: unknown): boolean {
  if (err instanceof OpenAI.APIConnectionTimeoutError) return true;
  if (err instanceof OpenAI.RateLimitError) return true;
  if (err instanceof OpenAI.InternalServerError) return true;
  if (err instanceof OpenAI.APIConnectionError) return true;
  if (err instanceof OpenAI.APIError) {
    const status = err.status;
    return status === 408 || status === 429 || (typeof status === 'number' && status >= 500);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Core completion
// ---------------------------------------------------------------------------

async function callLLM(
  userContent: string,
  purpose: 'summarize' | 'merge',
  model: string,
): Promise<string> {
  const openai = getClient();
  const { maxAttempts, retryBaseDelayMs, maxTokens, temperature } = TUNING;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        temperature,
        max_tokens: maxTokens,
      });

      const text = response.choices[0]?.message?.content?.trim();
      if (!text) {
        throw new LlmRequestError('LLM returned an empty response.');
      }
      return text;
    } catch (err) {
      if (err instanceof LlmConfigError) throw err;
      if (err instanceof LlmRequestError) throw err;

      if (!isRetryable(err) || attempt === maxAttempts) {
        throw new LlmRequestError(
          `LLM ${purpose} failed after ${attempt} attempt(s): ${errorMessage(err)}`,
          err,
        );
      }

      const delay = retryBaseDelayMs * Math.pow(2, attempt - 1);
      logWarn(
        `${purpose} attempt ${attempt}/${maxAttempts} failed (${errorMessage(err)}); ` +
          `retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }

  throw new LlmRequestError('LLM retry loop exited unexpectedly.');
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

function splitIntoChunks(text: string, maxChars: number, overlap: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let pos = 0;

  while (pos < text.length) {
    const end = Math.min(pos + maxChars, text.length);
    chunks.push(text.slice(pos, end));
    if (end === text.length) break;
    pos = Math.max(0, end - overlap);
  }

  return chunks;
}

async function mergeChunkSummaries(summaries: string[], model: string): Promise<string> {
  if (summaries.length === 1) return summaries[0];

  const combined = summaries
    .map((s, i) => `[Part ${i + 1} of ${summaries.length}]\n${s}`)
    .join('\n\n---\n\n');

  return callLLM(
    `These are summaries of different parts of the same meeting. ` +
      `Merge them into one cohesive summary:\n\n${combined}`,
    'merge',
    model,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Summarize a meeting transcript via the configured LLM gateway.
 * Long transcripts are chunked sequentially, then merged into one summary.
 */
export async function summarizeTranscript(
  transcript: string,
  meetingTitle?: string,
  model?: string,
): Promise<string> {
  const resolvedModel = resolveModel(model);

  const trimmed = transcript.trim();
  if (!trimmed) {
    throw new LlmRequestError('Transcript is empty; nothing to summarize.');
  }

  const prefix = meetingTitle?.trim() ? `Meeting: ${meetingTitle.trim()}\n\n` : '';
  const fullText = prefix + trimmed;

  if (fullText.length <= TUNING.maxCharsPerRequest) {
    return callLLM(`Meeting transcript:\n\n${fullText}`, 'summarize', resolvedModel);
  }

  const chunks = splitIntoChunks(fullText, TUNING.maxCharsPerRequest, TUNING.chunkOverlapChars);
  logInfo(`Transcript length ${fullText.length} chars; summarizing ${chunks.length} chunk(s) sequentially`);

  const results: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    logInfo(`Summarizing chunk ${i + 1}/${chunks.length}`);
    results.push(await callLLM(`Meeting transcript:\n\n${chunks[i]}`, 'summarize', resolvedModel));
  }

  return mergeChunkSummaries(results, resolvedModel);
}

/** Lists available completion models from the configured gateway. */
export async function listAvailableModels(): Promise<string[]> {
  const openai = getClient();
  const response = await openai.models.list();
  return response.data.map((m) => m.id).sort();
}

/** Lightweight connectivity check (no secrets in the returned payload). */
export async function checkLLMConnection(model?: string): Promise<{
  ok: boolean;
  gatewayUrl: string;
  model: string;
  error?: string;
}> {
  try {
    const creds = runtimeCredentials();
    assertConfig(creds);
    const openai = getClient();
    const resolvedModel = resolveModel(model);
    await openai.chat.completions.create({
      model: resolvedModel,
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      max_tokens: 10,
    });
    return { ok: true, gatewayUrl: creds.gatewayUrl, model: resolvedModel };
  } catch (err) {
    const creds = runtimeCredentials();
    return {
      ok: false,
      gatewayUrl: creds.gatewayUrl || '(not set)',
      model: model?.trim() || creds.model || '(not set)',
      error: errorMessage(err),
    };
  }
}
