# Issues

Open problems and pending decisions for this repository, newest first. The format and rules are
in the bookkeeping profile in `CLAUDE.md` ("`ISSUES.md`: open problems and pending decisions").

- **Statuses:** `OPEN`, `RESOLVED`, or `WONTFIX`. A closed entry is never deleted; it gains a
  `Resolved` or `Won't fix` line.
- **Severity:**
  - `HIGH`: wrong now, enforceable now, or has a fixed date;
  - `MEDIUM`: a real gap with no immediate clock;
  - `LOW`: tidy-up.

---

## OPEN — The sync marker's machine key comes from `os.hostname()`, which changed on its own

- **Date:** 2026-09-15
- **Area:** `machineKey()` in `src/`; the sync marker (FEAT-0010)
- **Severity:** MEDIUM. A live machine whose name changes reports a conflict against itself,
  but the sync still runs ("report, never block"), and only one host syncs today.
- **Issue:** on the Mac, `os.hostname()` went from `locasta` to `Mac.lan` within three days,
  while `scutil --get ComputerName` and `LocalHostName` still read `locasta`. The key is
  "built from the least stable of the three names macOS keeps", so a live machine in that
  position "stops recognising its own claim and reports a conflict against itself".
- **Source:** `docs/prompts/prompt-sync-marker-v2.md` §3a ("Observed 2026-09-15: the hostname
  key churned, and the marker went stale"), which ends "Not built; recorded so the next person
  weighs the same three options"; `WORKLOG.md` 2026-09-15, "Handover completed, and two
  findings from it". Also in the local, git-ignored
  `docs/turnover/turnover-windows-2026-09-15.md` §4 item 3: "None was applied. Do not
  implement one as a drive-by." Seeded from those texts; not re-observed here.
- **Options:** the three recorded in §3a, none free: (1) a `SYNC_MACHINE_KEY` override in
  `.env`, defaulting to the hostname, but `.env` is copied wholesale in a host move so it must
  be set per machine; (2) read `ComputerName`, more accurate but needs `scutil`, which breaks
  the platform-neutral rule for `src/`; (3) a stored id, ruled out earlier for the same
  host-move reason. Or leave it, since the failure is one report, not a missed sync. Kent
  decides.

## OPEN — The Windows half of the task runner has never been run on Windows

- **Date:** 2026-09-15
- **Area:** `build.ps1`, `make.js` scheduling targets (FEAT-0011): `setup`, `install`,
  `uninstall`, `run-now`, `authorize`, `claim`
- **Severity:** MEDIUM. Windows is the deployment platform and these targets install the
  nightly job, but nothing records them failing; they are simply unproven.
- **Issue:** "The Windows scheduling half (`Register-ScheduledTask`, `Get-ScheduledTaskInfo`,
  `Start-ScheduledTask`) is written to the form the README already documents but has not been
  run on Windows; only the shim's argument handling was tested, against pwsh 7.6 on macOS."
  The other targets listed above "are unexercised for the same reasons they need care: they
  install system jobs, need a browser, or spend quota."
- **Source:** `WORKLOG.md` 2026-09-15, "Task runner built — FEAT-0011", paragraph "What is not
  verified"; `features.yaml` FEAT-0011 `notes:` ("Known limits"); `VERSIONS.md`
  2026.09.15-84b809c ("Not yet run on Windows"). No later entry records a Windows run.
- **Options:** exercise the targets on the Windows host in a sitting where Kent is present,
  minding the quota rules in `AGENTS.md` (`run-now` spends quota); record the result in
  `WORKLOG.md` and FEAT-0011. Kent decides when, since it touches the live host's scheduled
  job.
