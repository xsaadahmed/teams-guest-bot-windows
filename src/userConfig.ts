import * as fs from 'fs';
import * as path from 'path';

export interface UserConfig {
  /** Your Teams display name — used for mute-gated mic capture. */
  localParticipantName: string;
  /** OpenAI-compatible gateway base URL (e.g. https://api.x.ai/v1). */
  llmGatewayUrl: string;
  /** API key for the LLM gateway — stored locally only. */
  llmApiKey: string;
  /** Default completion model when the UI is set to Auto. */
  llmModel: string;
}

export interface EffectiveLlmConfig {
  gatewayUrl: string;
  apiKey: string;
  model: string;
  fromEnv: {
    apiKey: boolean;
    gatewayUrl: boolean;
    model: boolean;
  };
  /** When true, saved Settings values override .env (see LLM_ALLOW_UI_OVERRIDE). */
  uiOverride: boolean;
}

const CONFIG_PATH =
  process.env.TEAMS_BOT_CONFIG_PATH || path.join(process.cwd(), '.teams-bot-config.json');

const DEFAULTS: UserConfig = {
  localParticipantName: '',
  llmGatewayUrl: '',
  llmApiKey: '',
  llmModel: '',
};

export function getConfigPath(): string {
  return CONFIG_PATH;
}

function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function loadUserConfig(): UserConfig {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULTS };
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<UserConfig>;
    return {
      localParticipantName: trimString(raw.localParticipantName),
      llmGatewayUrl: trimString(raw.llmGatewayUrl),
      llmApiKey: trimString(raw.llmApiKey),
      llmModel: trimString(raw.llmModel),
    };
  } catch (err) {
    console.warn('[userConfig] Could not read config, using defaults:', err);
    return { ...DEFAULTS };
  }
}

function isTruthyEnv(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * When set (true / 1 / yes), LLM gateway, API key, and model from Settings override .env.
 * Useful for testing alternate keys without editing .env. Set in .env or Start-Bot.cmd.
 */
export function isLlmUiOverrideEnabled(): boolean {
  return isTruthyEnv('LLM_ALLOW_UI_OVERRIDE');
}

/**
 * Which LLM_* vars were present in .env at server start (before UI config is synced into
 * process.env). Used only for UI lock + save guards — not for reading current values.
 */
let llmEnvLockedAtBoot: EffectiveLlmConfig['fromEnv'] = {
  gatewayUrl: false,
  apiKey: false,
  model: false,
};

/** Snapshot .env LLM vars once at boot — must run before applyLlmConfigToEnv(). */
function snapshotLlmEnvFromDotenv(): void {
  llmEnvLockedAtBoot = {
    gatewayUrl: Boolean(process.env.LLM_GATEWAY_URL?.trim()),
    apiKey: Boolean(process.env.LLM_API_KEY?.trim()),
    model: Boolean(process.env.LLM_MODEL?.trim()),
  };
}

function getLlmEnvFlags(): EffectiveLlmConfig['fromEnv'] {
  return llmEnvLockedAtBoot;
}

function envLlmValue(name: 'LLM_GATEWAY_URL' | 'LLM_API_KEY' | 'LLM_MODEL'): string {
  return (process.env[name] ?? '').trim();
}

/** Env vars from .env win when locked at boot; otherwise values from the saved config file. */
export function getEffectiveLlmConfig(): EffectiveLlmConfig {
  const file = loadUserConfig();
  const fromEnv = getLlmEnvFlags();
  const uiOverride = isLlmUiOverrideEnabled();

  if (uiOverride) {
    return {
      gatewayUrl: file.llmGatewayUrl || envLlmValue('LLM_GATEWAY_URL'),
      apiKey: file.llmApiKey || envLlmValue('LLM_API_KEY'),
      model: file.llmModel || envLlmValue('LLM_MODEL'),
      fromEnv,
      uiOverride: true,
    };
  }

  return {
    gatewayUrl: fromEnv.gatewayUrl
      ? envLlmValue('LLM_GATEWAY_URL')
      : file.llmGatewayUrl || envLlmValue('LLM_GATEWAY_URL'),
    apiKey: fromEnv.apiKey ? envLlmValue('LLM_API_KEY') : file.llmApiKey || envLlmValue('LLM_API_KEY'),
    model: fromEnv.model ? envLlmValue('LLM_MODEL') : file.llmModel || envLlmValue('LLM_MODEL'),
    fromEnv,
    uiOverride: false,
  };
}

export function isLlmConfigured(): boolean {
  const { gatewayUrl, apiKey } = getEffectiveLlmConfig();
  return Boolean(gatewayUrl && apiKey);
}

/** Mask an API key for display (never sent in full to the browser). */
export function maskApiKey(key: string): string | null {
  const k = key.trim();
  if (!k) return null;
  if (k.length <= 4) return '••••';
  return `••••${k.slice(-4)}`;
}

function applyLlmConfigToEnv(
  cfg: UserConfig,
  fromEnv: EffectiveLlmConfig['fromEnv'],
  uiOverride = isLlmUiOverrideEnabled(),
): void {
  const writeGateway = uiOverride || !fromEnv.gatewayUrl;
  const writeApiKey = uiOverride || !fromEnv.apiKey;
  const writeModel = uiOverride || !fromEnv.model;

  if (writeGateway) {
    if (cfg.llmGatewayUrl) process.env.LLM_GATEWAY_URL = cfg.llmGatewayUrl;
    else delete process.env.LLM_GATEWAY_URL;
  }
  if (writeApiKey) {
    if (cfg.llmApiKey) process.env.LLM_API_KEY = cfg.llmApiKey;
    else delete process.env.LLM_API_KEY;
  }
  if (writeModel) {
    if (cfg.llmModel) process.env.LLM_MODEL = cfg.llmModel;
    else delete process.env.LLM_MODEL;
  }
}

export function saveUserConfig(partial: Partial<UserConfig>): UserConfig {
  const current = loadUserConfig();
  const fromEnv = getLlmEnvFlags();
  const uiOverride = isLlmUiOverrideEnabled();
  const next: UserConfig = { ...current };

  if (partial.localParticipantName !== undefined) {
    next.localParticipantName =
      typeof partial.localParticipantName === 'string' ? partial.localParticipantName.trim() : '';
  }

  if (partial.llmGatewayUrl !== undefined) {
    if (!uiOverride && fromEnv.gatewayUrl) {
      throw new Error('LLM gateway URL is set via the LLM_GATEWAY_URL environment variable.');
    }
    next.llmGatewayUrl =
      typeof partial.llmGatewayUrl === 'string' ? partial.llmGatewayUrl.trim() : '';
  }

  if (partial.llmApiKey !== undefined) {
    if (!uiOverride && fromEnv.apiKey) {
      throw new Error('LLM API key is set via the LLM_API_KEY environment variable.');
    }
    next.llmApiKey = typeof partial.llmApiKey === 'string' ? partial.llmApiKey.trim() : '';
  }

  if (partial.llmModel !== undefined) {
    if (!uiOverride && fromEnv.model) {
      throw new Error('LLM model is set via the LLM_MODEL environment variable.');
    }
    next.llmModel = typeof partial.llmModel === 'string' ? partial.llmModel.trim() : '';
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');

  if (next.localParticipantName) {
    process.env.LOCAL_PARTICIPANT_NAME = next.localParticipantName;
  } else {
    delete process.env.LOCAL_PARTICIPANT_NAME;
  }

  applyLlmConfigToEnv(next, fromEnv, uiOverride);
  return next;
}

/**
 * Env var wins when already set (CMD / CI). Otherwise use the saved config file
 * so the UI first-run prompt persists across restarts without setting env every time.
 */
export function applyLocalParticipantNameToEnv(name?: string): string {
  const fromEnv = process.env.LOCAL_PARTICIPANT_NAME?.trim();
  if (fromEnv) return fromEnv;

  const resolved = (name ?? loadUserConfig().localParticipantName).trim();
  if (resolved) {
    process.env.LOCAL_PARTICIPANT_NAME = resolved;
  } else {
    delete process.env.LOCAL_PARTICIPANT_NAME;
  }
  return resolved;
}

/** Effective mute-gate name: env (if set) else config file. */
export function getLocalParticipantName(): string {
  return process.env.LOCAL_PARTICIPANT_NAME?.trim() || loadUserConfig().localParticipantName.trim();
}

/** Call once at server boot. */
export function bootstrapUserConfig(): UserConfig {
  snapshotLlmEnvFromDotenv();
  const cfg = loadUserConfig();
  applyLocalParticipantNameToEnv(cfg.localParticipantName);
  applyLlmConfigToEnv(cfg, getLlmEnvFlags(), isLlmUiOverrideEnabled());
  return cfg;
}
