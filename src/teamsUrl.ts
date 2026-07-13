/**
 * A normal Teams meeting link (the one from a calendar invite) opens an "Open Microsoft Teams?"
 * app-launcher dialog that a headless/automated browser can't interact with - it's not a real
 * link to the meeting lobby. The fix (confirmed by multiple independent open-source Teams bots)
 * is to rewrite it into Teams' own "v2" deep-link format with `&anon=true`, which goes straight
 * to the browser join lobby and skips the native-app prompt entirely.
 *
 * Handles:
 *  - Netskope proxy links: https://teams.microsoft.com.rproxy.goskope.com/meet/... →
 *    https://teams.microsoft.com/meet/... (the proxied host is blocked by corporate IT filters)
 *  - Standard work/school links: https://teams.microsoft.com/l/meetup-join/<thread>/<ts>?context=...
 *  - Personal "Teams Free" links: https://teams.live.com/meet/<id>?p=<passcode>
 * Anything else is passed through unchanged (with a warning) - Playwright will likely hit the
 * app-launcher dialog and fail to find the join button, which shows up clearly in the logs.
 */
export function toDirectJoinUrl(originalLink: string): string {
  try {
    if (originalLink.includes('/v2/?meetingjoin=true')) {
      try {
        const url = new URL(originalLink);
        if (!url.searchParams.has('suppressPrompt')) {
          url.searchParams.set('suppressPrompt', 'true');
          return url.toString();
        }
      } catch {
        // fall through
      }
      return originalLink;
    }

    const url = new URL(originalLink);
    // Corporate Netskope wraps Teams as teams.microsoft.com.rproxy.goskope.com — navigating
    // that host hits an IT "Noncompliant action" block page. Strip back to the real Teams host.
    if (url.hostname === 'teams.microsoft.com.rproxy.goskope.com') {
      url.hostname = 'teams.microsoft.com';
    }
    // A trailing dot on the hostname (e.g. teams.microsoft.com.) is valid DNS but breaks
    // Chromium navigation with ERR_CONNECTION_CLOSED — strip it.
    url.hostname = url.hostname.replace(/\.+$/, '');

    // Personal Teams Free: use v2 deep-link (same trick as work/school) to skip the
    // dl/launcher page that triggers the native "Open ms-teams.exe?" protocol bubble.
    if (url.hostname.includes('teams.live.com') && url.pathname.match(/^\/meet\/([^/]+)/)) {
      const meetId = url.pathname.match(/^\/meet\/([^/]+)/)![1];
      const p = url.searchParams.get('p') ?? '';
      const hashParams = new URLSearchParams();
      if (p) hashParams.set('p', p);
      hashParams.set('anon', 'true');
      hashParams.set('webjoin', 'true');
      return `https://teams.live.com/v2/?meetingjoin=true&webjoin=true&suppressPrompt=true#/meet/${meetId}?${hashParams.toString()}`;
    }

    if (url.pathname.match(/^\/meet\/[^/]+/) && url.searchParams.has('p')) {
      if (!url.searchParams.has('anon')) {
        url.searchParams.set('anon', 'true');
      }
      url.searchParams.set('suppressPrompt', 'true');
      return url.toString();
    }

    if (url.hostname.includes('teams.live.com')) {
      if (!url.searchParams.has('anon')) {
        url.searchParams.set('anon', 'true');
      }
      url.searchParams.set('suppressPrompt', 'true');
      return url.toString();
    }

    if (url.hostname.includes('teams.microsoft.com')) {
      const match = originalLink.match(
        /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/(.*?)\/(\d+)\?context=(.*?)(?:$|&)/,
      );

      if (match) {
        const [, threadId, timestamp, context] = match;
        return `https://teams.microsoft.com/v2/?meetingjoin=true&suppressPrompt=true#/l/meetup-join/${threadId}/${timestamp}?context=${context}&anon=true&suppressPrompt=true`;
      }
    }

    console.warn(
      `[teamsUrl] Could not recognize this link's format, passing it through unchanged: ${originalLink}`,
    );
    return originalLink;
  } catch (err) {
    console.error('[teamsUrl] Failed to parse meeting URL, passing it through unchanged:', err);
    return originalLink;
  }
}
