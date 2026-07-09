import { Page } from '@playwright/test';
import { ensureRosterPanelOpen } from './teamsJoin';

/**
 * Reads whether a named participant's mic is muted from the Teams meeting roster UI.
 * Opens the roster panel first (via ensureRosterPanelOpen) so mute icons are in the DOM.
 *
 * Returns null if the participant or mute state could not be determined.
 */
export async function isLocalParticipantMuted(page: Page, participantName: string): Promise<boolean | null> {
  const name = participantName.trim();
  if (!name) return null;

  await ensureRosterPanelOpen(page);

  for (const frame of page.frames()) {
    try {
      const result = await frame.evaluate((targetName) => {
        function normalize(value: string): string {
          return value.replace(/\s+/g, ' ').trim().toLowerCase();
        }
        const target = normalize(targetName);

        const rows = Array.from(document.querySelectorAll('[data-cid="roster-participant"]'));
        for (const row of rows) {
          const rowLabel = row.getAttribute('aria-label') || '';
          const tid = row.getAttribute('data-tid') || '';
          const prefix = 'attendeesInMeeting-';
          const nameFromTid = tid.startsWith(prefix) ? tid.slice(prefix.length) : '';

          const matches =
            normalize(rowLabel).startsWith(target) || normalize(nameFromTid) === target;
          if (!matches) continue;

          // Most reliable: the mic icon's own data-cid, right on this row.
          if (row.querySelector('[data-cid="roster-participant-muted"]')) return true;
          if (row.querySelector('[data-cid="roster-participant-unmuted"]')) return false;

          // Fallback: the row's own aria-label ends in "Muted" / "Unmuted".
          const segments = rowLabel.split(',').map((s) => s.trim());
          const last = (segments[segments.length - 1] || '').toLowerCase();
          if (last === 'muted') return true;
          if (last === 'unmuted') return false;
        }
        return null;
      }, name);
      if (result !== null) return result;
    } catch {
      // frame not ready
    }
  }
  return null;
}
