import * as fs from 'fs';
import * as path from 'path';

/**
 * Corporate laptops often block Playwright's mkdtemp under the default %TEMP%
 * (EPERM on playwright-artifacts-*). Route temp files into the project folder.
 * Set TEAMS_BOT_USE_SYSTEM_TEMP=1 to keep the Windows default temp directory.
 */
function bootstrapWinEnv(): void {
  if (process.platform !== 'win32') return;

  const useSystemTemp = process.env.TEAMS_BOT_USE_SYSTEM_TEMP?.trim().toLowerCase();
  if (useSystemTemp === '1' || useSystemTemp === 'true' || useSystemTemp === 'yes') {
    return;
  }

  const root = process.cwd();
  const botTemp = path.join(root, '.bot-temp');
  fs.mkdirSync(botTemp, { recursive: true });
  process.env.TEMP = botTemp;
  process.env.TMP = botTemp;

  if (!process.env.TEAMS_BOT_BROWSER_PROFILE?.trim()) {
    process.env.TEAMS_BOT_BROWSER_PROFILE = path.join(root, '.teams-bot-browser-profile');
  }
}

bootstrapWinEnv();
