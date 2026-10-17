/**
 * The HTML run report and the cell/status wording it shares with the console summary.
 *
 * Pure: every function takes playlist summaries (the status objects built by
 * {@link module:youtube.getPlaylistStatus} and updated by phases 1.5 and 2) and returns
 * strings, so the report is testable without a run.
 *
 * @module report
 */

/**
 * The per-playlist fields the report reads. A summary is the status object from
 * {@link module:youtube.getPlaylistStatus}, plus the run flags `src/index.js` sets on it;
 * only the fields used here are listed.
 *
 * @typedef {object} ReportRow
 * @property {string} handle - `@Handle` of the channel.
 * @property {string} [playlistTitle] - Playlist title (absent on a whole-channel error).
 * @property {?string} [url] - Playlist URL, when the playlist exists.
 * @property {?string} [error] - Error text; when set, the row shows only this.
 * @property {boolean} [dryRun] - The run was `--dry-run`.
 * @property {boolean} [previewRemovals] - Watched deletions were reported, not made.
 * @property {number} [toAdd] - Videos missing from the playlist.
 * @property {number} [added] - Videos inserted this run.
 * @property {Array<object>} [toRemove] - Watched videos still in the playlist.
 * @property {Array<object>} [toDrop] - Videos below the `after=` cutoff still in the playlist.
 * @property {number} [removed] - Videos deleted this run.
 * @property {number} [videoCount] - Videos in the playlist after the run.
 * @property {number} [totalVideos] - Videos the playlist should hold.
 * @property {string} [action] - `up to date`, `updated`, `created`, `will create`, ...
 * @property {number} [shortsExcluded] - Shorts kept out of a videos playlist.
 * @property {string} [shortsSibling] - Title of the split channel's Shorts playlist.
 * @property {boolean} [shortsOnly] - This is a Shorts-only playlist.
 * @property {boolean} [shortsMixedIn] - Shorts were not separated (`shorts=yes`).
 * @property {?string} [after] - The `after=` cutoff as YYYY-MM-DD.
 * @property {number} [outOfScope] - Uploads below the cutoff.
 * @property {boolean} [manualSortRequired] - Inserts fell back to appending.
 * @property {boolean} [quotaHit] - The run stopped on quota before finishing this playlist.
 */

/**
 * Escape text for an HTML element body or a double-quoted attribute.
 *
 * @param {*} s - Any value; it is stringified first.
 * @returns {string} The text with `&`, `<`, `>` and `"` escaped.
 */
export function esc(s) {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
  );
}

/**
 * Sort a copy of the summaries alphabetically (A-Z) by channel handle, for display.
 *
 * Playlist title breaks the tie: a `shorts=split` channel contributes two rows under
 * one handle, and without it their order would depend on which finished first.
 *
 * @template {{handle?: string, playlistTitle?: string}} T
 * @param {T[]} summaries - Rows to sort; not modified.
 * @returns {T[]} A new, sorted array.
 */
export function sortByChannel(summaries) {
  /**
   * Sort key: handle, then playlist title, both lowercased.
   *
   * @param {T} s - A row.
   * @returns {string} The key.
   */
  const key = (s) => `${(s.handle || '').toLowerCase()}\x00${(s.playlistTitle || '').toLowerCase()}`;
  return [...summaries].sort((a, b) => key(a).localeCompare(key(b)));
}

/** Empty numeric cell. A dash reads as "nothing happened" faster than a 0 does. */
const DASH = '—';

/**
 * Videos added to the playlist this run — or, in --dry-run, how many would be.
 *
 * @param {ReportRow} s - One playlist's summary.
 * @returns {string} `+N`, `N to add`, or a dash when there is nothing.
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
 *
 * @param {ReportRow} s - One playlist's summary.
 * @returns {string} `−N`, `N to remove`, `N would remove`, both halves, or a dash.
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
 *
 * @param {ReportRow} s - One playlist's summary.
 * @returns {string} Comma-separated notes, starting with the action.
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
 * Build the HTML report table shared by the workflow and the standalone email test.
 *
 * `account` labels which YouTube account the playlists belong to. It is optional and
 * comes from configuration (ACCOUNT_LABEL), never a hard-coded address — this file is
 * public and the report is not.
 *
 * @param {ReportRow[]} summaries - One row per playlist (or per failed channel).
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] - Mark the report as a dry run in its heading.
 * @param {string} [options.account=''] - Account label for the header line.
 * @param {string} [options.warning=''] - Account-wide warning shown as a banner above
 *   the table (the sync-marker conflict).
 * @returns {string} A complete, UTF-8-declared HTML document.
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
