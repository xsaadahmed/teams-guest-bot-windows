import * as fs from 'fs';
import * as path from 'path';

export interface UserConfig {
  /** Your Teams display name — used for mute-gated mic capture. */
  localParticipantName: string;
}

const CONFIG_PATH =
  process.env.TEAMS_BOT_CONFIG_PATH || path.join(process.cwd(), '.teams-bot-config.json');

const DEFAULTS: UserConfig = {
  localParticipantName: '',
};

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function loadUserConfig(): UserConfig {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULTS };
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<UserConfig>;
    return {
      localParticipantName:
        typeof raw.localParticipantName === 'string' ? raw.localParticipantName.trim() : '',
    };
  } catch (err) {
    console.warn('[userConfig] Could not read config, using defaults:', err);
    return { ...DEFAULTS };
  }
}

export function saveUserConfig(partial: Partial<UserConfig>): UserConfig {
  const next: UserConfig = {
    ...loadUserConfig(),
    ...partial,
  };
  if (typeof next.localParticipantName === 'string') {
    next.localParticipantName = next.localParticipantName.trim();
  } else {
    next.localParticipantName = '';
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  // Always sync env so mute gating picks up UI changes without restart.
  if (next.localParticipantName) {
    process.env.LOCAL_PARTICIPANT_NAME = next.localParticipantName;
  } else {
    delete process.env.LOCAL_PARTICIPANT_NAME;
  }
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
  const cfg = loadUserConfig();
  applyLocalParticipantNameToEnv(cfg.localParticipantName);
  return cfg;
}
