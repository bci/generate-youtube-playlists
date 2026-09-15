export function esc(s) {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
  );
}

/** Build the HTML report table shared by the workflow and the standalone email test. */
// Sort a copy of the summaries alphabetically (A-Z) by channel handle, for display.
// Playlist title breaks the tie: a `shorts=split` channel contributes two rows under
// one handle, and without it their order would depend on which finished first.
export function sortByChannel(summaries) {
  const key = (s) => `${(s.handle || '').toLowerCase()}\x00${(s.playlistTitle || '').toLowerCase()}`;
  return [...summaries].sort((a, b) => key(a).localeCompare(key(b)));
}

// Empty numeric cell. A dash reads as "nothing happened" faster than a 0 does.
const DASH = '—';

/**
 * Videos added to the playlist this run — or, in --dry-run, how many would be.
 */
export function addedCell(s) {
  if (s.dryRun) return s.toAdd ? `${s.toAdd} to add` : DASH;
  return s.added ? `+${s.added}` : DASH;
}

/**
 * Videos deleted from the playlist this run — watched ones (s.toRemove) and ones
 * below the channel's `after=` cutoff (s.toDrop), which share the column because
 * they share the write budget.
 *
 * Only the watched half can be preview-only: --dry-run previews everything, but
 * --report-watched and --ignore-watched suppress just the watched deletions, and a
 * cutoff answers to the channel's own keep/remove. So a real run can genuinely
 * delete some videos while still only previewing others, and the cell says both.
 */
export function removedCell(s) {
  const watched = s.toRemove?.length || 0;
  if (s.dryRun) {
    const pending = watched + (s.toDrop?.length || 0);
    return pending ? `${pending} to remove` : DASH;
  }
  const done = s.removed || 0;
  const pending = s.previewRemovals ? watched : 0;
  if (done && pending) return `−${done}, ${pending} would remove`;
  if (pending) return `${pending} would remove`;
  return done ? `−${done}` : DASH;
}

/**
 * Words and standing context only — the per-run numbers have their own columns.
 * The watched-ledger internals (which signal fired, the running total, how many
 * videos are being held out of re-adds) stay in the console summary; they were
 * five overlapping counts in a sentence here, describing the same few videos.
 */
export function statusNote(s) {
  // `action` only tracks inserts, so a run that just pruned watched videos would
  // otherwise read "−3 … up to date".
  const action = s.action === 'up to date' && s.removed ? 'updated' : s.action;
  return [
    action,
    // "Skipped" is only true when nothing else holds them. On the videos half of a
    // split channel they went to the sibling playlist, and naming it is what makes
    // the two rows read as a pair rather than one playlist that lost videos.
    s.shortsExcluded
      ? s.shortsSibling
        ? `${s.shortsExcluded} shorts in “${s.shortsSibling}”`
        : `${s.shortsExcluded} shorts skipped`
      : null,
    // Which side of the Shorts split this playlist is, and worth saying for the same
    // reason the cutoff is: a playlist full of 40-second clips, or one whose count
    // dropped when its Shorts moved out, should read as a setting rather than a bug.
    s.shortsOnly ? 'shorts only' : null,
    s.shortsMixedIn ? 'shorts mixed in' : null,
    // Standing context, not a per-run count: without it a playlist that suddenly
    // holds 20 videos instead of 800 looks like a failure rather than a setting.
    s.after
      ? `only videos after ${s.after}` +
        (s.outOfScope ? ` (${s.outOfScope} older excluded)` : '')
      : null,
    s.manualSortRequired
      ? '⚠ playlist sort is not “Manual” — new videos were appended at the end; ' +
        'set the sort order back to “Manual” in YouTube to restore oldest → newest'
      : null,
    s.quotaHit ? '⚠ quota limit hit — continues next run' : null,
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * `account` labels which YouTube account the playlists belong to. It is optional and
 * comes from configuration (ACCOUNT_LABEL), never a hard-coded address — this file is
 * public and the report is not.
 */
export function buildHtml(summaries, { dryRun = false, account = '', warning = '' } = {}) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  // Only explain cutoffs when one is actually in play — the footnote is for the
  // reader wondering why a channel's total dropped, not a permanent disclaimer.
  const anyCutoff = summaries.some((s) => s.after);
  const anyShorts = summaries.some((s) => s.shortsOnly || s.shortsMixedIn || s.shortsExcluded);
  const numeric = 'text-align:right;white-space:nowrap';
  const rows = sortByChannel(summaries)
    .map((s) => {
      if (s.error) {
        // 6 columns in the header, so the error spans the other 5.
        return `<tr><td>${esc(s.handle)}</td><td colspan="5" style="color:#b00">Error: ${esc(s.error)}</td></tr>`;
      }
      const link = s.url
        ? `<a href="${esc(s.url)}">${esc(s.playlistTitle)}</a>`
        : esc(s.playlistTitle);
      return `<tr>
        <td>${esc(s.handle)}</td>
        <td>${link}</td>
        <td style="${numeric}">${esc(addedCell(s))}</td>
        <td style="${numeric}">${esc(removedCell(s))}</td>
        <td style="${numeric}">${s.videoCount ?? s.totalVideos}</td>
        <td>${esc(statusNote(s))}</td>
      </tr>`;
    })
    .join('\n');

  // Above the table, not in it: this is about the whole account, not one playlist, and
  // it is the reason the mail was sent at all.
  const banner = warning
    ? `<p style="margin:0 0 16px;padding:12px;border-left:4px solid #b00;background:#fff4f4;color:#b00">
    <strong>⚠️ ${esc(warning)}</strong>
  </p>`
    : '';

  // The charset is load-bearing, not boilerplate. This file is opened as a file:// URL
  // (`make report`) and mailed as an HTML body, and neither carries a Content-Type the
  // browser can fall back on. Undeclared, the em dashes, curly quotes and the ⚠️ above
  // get read as the locale default — cp1252 on Windows — and render as mojibake. It must
  // also stay within the first 1024 bytes, which is as far as browsers look.
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family:Arial,Helvetica,sans-serif;color:#222">
  <h2>YouTube Playlists${dryRun ? ' (dry run)' : ''}</h2>
  <p style="color:#666">Generated ${esc(now)}${account ? ` — account: ${esc(account)}` : ''}</p>
  ${banner}
  <table cellpadding="8" cellspacing="0" border="0" style="border-collapse:collapse;font-size:14px">
    <thead>
      <tr style="background:#f2f2f2;text-align:left">
        <th>Channel</th><th>Playlist</th>
        <th style="${numeric}">Added</th>
        <th style="${numeric}">Removed</th>
        <th style="${numeric}">In&nbsp;playlist</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <p style="color:#999;font-size:12px">
    All playlists are private and ordered oldest → newest. Removed videos are ones you
    liked or saved to the “Watched” playlist; they are never added back.${
      anyShorts
        ? ' Shorts are kept out of a channel’s main playlist unless its' +
          ' channel-list line says otherwise; a channel set to “split” gets a second' +
          ' playlist holding only its Shorts.'
        : ''
    }${
      anyCutoff
        ? ' A channel with an “only videos after” date collects nothing published' +
          ' before it, and older videos are deleted from its playlist unless the' +
          ' channel is marked “keep” in the channel list.'
        : ''
    }
  </p>
  </body></html>`;
}
