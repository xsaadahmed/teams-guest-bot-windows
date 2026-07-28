import OpenAI from 'openai';

// ---------------------------------------------------------------------------
// Configuration (env-overridable; defaults suit an internal meeting summarizer)
// ---------------------------------------------------------------------------

/** Approximate chars-per-token heuristic used only for chunk sizing. */
const CHARS_PER_TOKEN_ESTIMATE = 4;

const CONFIG = {
  gatewayUrl: (process.env.LLM_GATEWAY_URL ?? '').trim(),
  apiKey: (process.env.LLM_API_KEY ?? '').trim(),
  model: (process.env.LLM_MODEL ?? '').trim(),

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

function assertConfig(): void {
  const missing: string[] = [];
  if (!CONFIG.gatewayUrl) missing.push('LLM_GATEWAY_URL');
  if (!CONFIG.apiKey) missing.push('LLM_API_KEY');
  // Note: MODEL is intentionally NOT required for non-completion operations
  // like listing available models. Completion calls resolve a model at runtime.
  if (missing.length > 0) {
    throw new LlmConfigError(
      `LLM is not configured. Set required environment variable(s): ${missing.join(', ')}.`,
    );
  }
  if (CONFIG.chunkOverlapChars >= CONFIG.maxCharsPerRequest) {
    throw new LlmConfigError(
      'LLM_CHUNK_OVERLAP_CHARS must be smaller than LLM_MAX_CHARS_PER_REQUEST.',
    );
  }
}

function resolveModel(model?: string): string {
  const trimmed = model?.trim();
  if (trimmed) return trimmed;
  if (CONFIG.model) return CONFIG.model;
  throw new LlmConfigError(
    'LLM_MODEL is not configured. Set LLM_MODEL or pass a model parameter from the UI.',
  );
}

// ---------------------------------------------------------------------------
// Client (lazy — so importing this module never throws on missing env)
// ---------------------------------------------------------------------------

let client: OpenAI | null = null;

function getClient(): OpenAI {
  assertConfig();
  if (!client) {
    client = new OpenAI({
      baseURL: CONFIG.gatewayUrl,
      apiKey: CONFIG.apiKey,
      timeout: CONFIG.requestTimeoutMs,
      maxRetries: 0, // we handle retries ourselves for clearer logs/control
    });
  }
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
  // Some gateways surface timeouts as generic API errors with status.
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
  const { maxAttempts, retryBaseDelayMs, maxTokens, temperature } = CONFIG;

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

      // Empty-response and other non-retryable failures: wrap once and stop.
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
// Public API — stable for future backend integration
// ---------------------------------------------------------------------------

/**
 * Summarize a meeting transcript via the configured LLM gateway.
 * Long transcripts are chunked sequentially (not in parallel) to respect
 * shared-gateway concurrency limits, then merged into one summary.
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

  if (fullText.length <= CONFIG.maxCharsPerRequest) {
    return callLLM(`Meeting transcript:\n\n${fullText}`, 'summarize', resolvedModel);
  }

  const chunks = splitIntoChunks(fullText, CONFIG.maxCharsPerRequest, CONFIG.chunkOverlapChars);
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
export async function checkLLMConnection(): Promise<{
  ok: boolean;
  gatewayUrl: string;
  model: string;
  error?: string;
}> {
  try {
    assertConfig();
    const openai = getClient();
    const resolvedModel = resolveModel();
    await openai.chat.completions.create({
      model: resolvedModel,
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      max_tokens: 10,
    });
    return { ok: true, gatewayUrl: CONFIG.gatewayUrl, model: resolvedModel };
  } catch (err) {
    return {
      ok: false,
      gatewayUrl: CONFIG.gatewayUrl || '(not set)',
      model: CONFIG.model || '(not set)',
      error: errorMessage(err),
    };
  }
}
