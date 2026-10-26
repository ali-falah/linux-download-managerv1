<!-- PLAN STATUS: completed | UPDATED: 2026-10-24T20:51:03.655Z -->
<!-- PLAN ID: plan_mvmuyugy_0 -->
<!-- Phase 1: completed -->
<!-- Phase 2: completed -->
<!-- Phase 3: completed -->
<!-- Phase 4: completed -->

# Improve Browser Download Dialog UX + App Usability

## Context / What this resolves:
The browser download dialog (shown when the extension intercepts a download) has several UX gaps: the filename is readonly, no file size/metadata is shown before confirming, Cancel permanently loses the download with no browser fallback, no source page is displayed for trust, no queue indicator when multiple downloads are pending, no "Start All" for bulk confirm, and no Enter key support. The dialog is also inconsistent with the "New Download" modal which has richer features.

## Approach / Why this way:
Enhance the existing browser download modal in-place rather than merging the two modals (too risky/large). Reuse existing patterns: `inspect_url` command for metadata, `formatBytes` for size display, the same metadata card styling from the New Download modal. Add a new `open_url` backend command for the "Let browser handle" fallback. All UI uses existing CSS classes/components per the design system.

---

## Phase 1: Add `open_url` backend command

**Goal:** Enable "Let browser handle" — when the user doesn't want the app to handle a browser-intercepted download, open the URL in the system's default browser so the browser downloads it natively.

**Files:**
- `src-tauri/src/commands.rs` (modify) — add `open_url` command
- `src-tauri/src/lib.rs` (modify) — register `open_url` in the invoke handler

**Steps:**
1. Add `open_url` command in commands.rs using `xdg-open` (same pattern as `open_file`/`open_folder`).
2. Register it in lib.rs `generate_handler!` list.

**Risks:** `xdg-open` might open a browser tab instead of triggering a download for some URLs. The extension's `wasRecentlyCaptured` prevents re-interception, so the browser will handle it natively. This is acceptable — it's a fallback, not the primary path.

---

## Phase 2: Redesign browser download modal HTML

**Goal:** Add editable filename, source page display, queue counter, metadata preview area, "Start All" button, "Let browser handle" button, and URL truncation display.

**Files:**
- `ui/index.html` (modify) — redesign `#browser-download-modal`

**Steps:**
1. Make filename input editable (remove `readonly`), add `id` keep same.
2. Add source page row below URL (shows domain/origin, derived from `sourcePageUrl`).
3. Add queue counter badge in modal header ("1 of 3").
4. Add metadata preview area (hidden by default, shown on inspect) with file size, content type, resumable status — reuse existing `metadata-card` CSS classes.
5. Add "Inspect" button next to URL field.
6. Add "Let browser handle" button in footer (ghost style).
7. Add "Start All" button in footer (secondary style), shown only when queue > 1.
8. Wrap URL in a container that supports truncation display.

**Risks:** HTML structure changes must not break existing event listener IDs. All existing IDs (`browser-download-url`, `browser-download-location`, `browser-download-filename`, `browser-download-start`, `browser-download-cancel`, `browser-download-close`, `browser-download-browse`) must be preserved.

---

## Phase 3: Add JS logic for browser download dialog enhancements

**Goal:** Wire up all new UI elements — inspect, Start All, Let browser handle, Enter key, queue counter, editable filename passthrough, source page display, URL truncation.

**Files:**
- `ui/main.js` (modify) — enhance browser download functions

**Steps:**
1. Update `showNextBrowserDownload()`: set source page display, update queue counter, truncate URL display, reset metadata panel.
2. Update `startBrowserDownloadFromDialog()`: pass edited filename by setting `currentBrowserDownload.sourceTitle` to the input value before invoking.
3. Add `inspectBrowserDownloadUrl()`: calls `inspect_url` with the current browser download URL, shows metadata in the new preview area.
4. Add `startAllBrowserDownloads()`: iterates `pendingBrowserDownloads` + current, starts each with default save dir, clears queue.
5. Add `letBrowserHandleDownload()`: calls `open_url` with the current download URL, then proceeds to next.
6. Add `closeBrowserDownloadDialog()`: also reset metadata panel state.
7. Add Enter key handler on the browser download modal (Enter → start, Esc handled by existing `closeAllModals`).
8. Register new event listeners in `initEventListeners()`.
9. Add a `browserDownloadMetadata` variable to track inspect state.

**Risks:** The `sourceTitle` field serves as both page title and filename. For regular downloads it's the raw filename (good). For media captures it might be a page title. The inspect call will populate `suggestedFileName` which the user can use to correct the filename field. This is acceptable — the inspect button gives them the real filename.

---

## Phase 4: Recheck all added code for bugs/mistakes

**Goal:** Verify every changed file for correctness — no orphaned variables, no broken IDs, no type mismatches, no missing event listeners.

**Files:**
- All modified files (read-only review)

**Steps:**
1. Read back each modified file section.
2. Check all new HTML element IDs match JS references.
3. Check all new JS functions are called from event listeners.
4. Check no existing functionality is broken (modal open/close, browse, start, cancel).
5. Run `cargo check` for Rust syntax.
6. Check IDE diagnostics for JS.

**Risks:** Finding issues here means looping back to fix them in the relevant phase.

---

## Manual Tests
1. Trigger a browser download (click a download link with extension active) → dialog should show URL, source page, editable filename, inspect button, metadata area (hidden).
2. Click "Inspect" → metadata area should show file size, content type, resumable status.
3. Edit the filename → click "Start Download" → download should start with the edited name.
4. Click "Let browser handle" → URL opens in system browser, dialog moves to next (or closes).
5. Trigger 3 downloads at once → dialog should show "1 of 3", "Start All" button visible. Click "Start All" → all 3 start.
6. Press Enter in the dialog → download should start. Press Esc → dialog should close.
7. Verify the New Download modal still works unchanged.