// Linux Download Manager — Production UI Controller

// Tauri IPC helpers
function getTauri() {
    return typeof window !== "undefined" ? window.__TAURI__ : null;
}

async function invoke(cmd, args = {}) {
    const tauri = getTauri();
    if (tauri?.core?.invoke) {
        return await tauri.core.invoke(cmd, args);
    }
    // Fallback if accessed via pure static browser without Tauri
    if (cmd === "list_downloads") return [];
    if (cmd === "app_settings") {
        return {
            defaultDownloadDir: "~/Downloads",
            maxConcurrentDownloads: 3,
            defaultBandwidthLimitKbps: 0,
            askBrowserDownloadLocation: true,
            hiddenSites: [],
        };
    }
    return {};
}

function listen(evt, callback) {
    const tauri = getTauri();
    if (tauri?.event?.listen) {
        return tauri.event.listen(evt, callback);
    }
    return Promise.resolve(() => {});
}

// Application State
let allDownloads = [];
const liveDownloadStats = new Map();
let currentFilter = "all";
let currentCategory = "all";
let searchQuery = "";
let sortBy = "newest";
let appSettings = null;
let currentMetadata = null;
let deleteCandidateId = null;
const pendingBrowserDownloads = [];
let currentBrowserDownload = null;

// Initialize on DOM Ready
document.addEventListener("DOMContentLoaded", async () => {
    initTheme();
    initEventListeners();
    loadViewState();
    markSidebarActive();
    const sortSelect = document.getElementById("sort-select");
    if (sortSelect) {
        sortSelect.value = sortBy;
        sortSelect.dispatchEvent(new Event("sync"));
    }
    await loadSettings();
    await loadDownloads();
    initRealtimeListeners();
    startStatsTicker();
});

// ── Event Listeners ─────────────────────────────────────────────────────────

const SORT_OPTIONS = ["newest", "oldest", "name", "size"];
const STATUS_FILTERS = ["all", "in_progress", "queued", "paused", "completed", "failed"];
const CATEGORY_FILTERS = ["all", "video", "audio", "archive", "document", "image", "other"];

function saveViewState() {
    try {
        localStorage.setItem("ldm_sort", sortBy);
        localStorage.setItem("ldm_filter", currentFilter);
        localStorage.setItem("ldm_category", currentCategory);
    } catch (_) {}
}

function loadViewState() {
    try {
        const sort = localStorage.getItem("ldm_sort");
        if (SORT_OPTIONS.includes(sort)) sortBy = sort;
        const filter = localStorage.getItem("ldm_filter");
        if (STATUS_FILTERS.includes(filter)) currentFilter = filter;
        const category = localStorage.getItem("ldm_category");
        if (CATEGORY_FILTERS.includes(category)) currentCategory = category;
    } catch (_) {}
}

// Reflect persisted view state onto the sidebar nav buttons (initial DOM
// hard-codes "All Downloads" and the status section as active).
function markSidebarActive() {
    document.querySelectorAll(".sidebar-nav [data-filter]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.filter === currentFilter);
    });
    document.querySelectorAll(".sidebar-nav [data-category]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.category === currentCategory);
    });
}

// ── Sidebar Collapse ────────────────────────────────────────────────────────

function setSidebarCollapsed(collapsed) {
    const sidebar = document.getElementById("app-sidebar");
    const btn = document.getElementById("sidebar-collapse-btn");
    if (!sidebar) return;
    sidebar.classList.toggle("collapsed", collapsed);
    if (btn) {
        btn.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
        btn.setAttribute("aria-label", btn.title);
        btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    }
    try {
        localStorage.setItem("ldm_sidebar_collapsed", collapsed ? "1" : "0");
    } catch (_) {}
}

function initSidebarCollapse() {
    const btn = document.getElementById("sidebar-collapse-btn");
    if (!btn) return;
    btn.addEventListener("click", () => {
        const sidebar = document.getElementById("app-sidebar");
        setSidebarCollapsed(!sidebar.classList.contains("collapsed"));
    });
    // Collapsed by default; a remembered preference wins afterwards.
    let stored = null;
    try {
        stored = localStorage.getItem("ldm_sidebar_collapsed");
    } catch (_) {}
    setSidebarCollapsed(stored === null || stored === "1");
}

function initEventListeners() {
    // Topbar
    document.getElementById("btn-new-download").addEventListener("click", openNewDownloadModal);
    document.getElementById("btn-open-settings").addEventListener("click", openSettingsModal);
    document.getElementById("btn-pause-all").addEventListener("click", togglePauseAll);

    // Theme selector
    const themeSelect = document.getElementById("settings-theme-select");
    if (themeSelect) {
        themeSelect.addEventListener("change", () => {
            applyTheme(themeSelect.value);
        });
    }

    // Initialize custom dropdowns (replaces native dark GTK menu)
    initCustomDropdowns();

    // Collapsible sidebar (collapsed by default)
    initSidebarCollapse();

    // Sidebar status filters
    document.querySelectorAll(".sidebar-nav [data-filter]").forEach((btn) => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".sidebar-nav [data-filter]").forEach((b) => b.classList.remove("active"));
            btn.classList.add("active");
            currentFilter = btn.dataset.filter;
            saveViewState();
            renderDownloadsList();
        });
    });

    // Sidebar category filters
    document.querySelectorAll(".sidebar-nav [data-category]").forEach((btn) => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".sidebar-nav [data-category]").forEach((b) => b.classList.remove("active"));
            btn.classList.add("active");
            currentCategory = btn.dataset.category;
            saveViewState();
            renderDownloadsList();
        });
    });

    // Open default download directory from the sidebar (path label or folder button)
    async function openDefaultFolder() {
        if (appSettings?.defaultDownloadDir) {
            try {
                await invoke("open_folder", { path: appSettings.defaultDownloadDir });
                showToast("Opened download directory", "info");
            } catch (err) {
                showToast("Could not open folder: " + err, "error");
            }
        }
    }
    document.getElementById("sidebar-open-folder-btn").addEventListener("click", openDefaultFolder);
    document.getElementById("sidebar-download-dir").addEventListener("click", openDefaultFolder);

    // Search and Sort
    const searchInput = document.getElementById("search-input");
    const clearSearchBtn = document.getElementById("search-clear-btn");

    searchInput.addEventListener("input", (e) => {
        searchQuery = e.target.value.trim().toLowerCase();
        clearSearchBtn.hidden = !searchQuery;
        renderDownloadsList();
    });

    clearSearchBtn.addEventListener("click", () => {
        searchInput.value = "";
        searchQuery = "";
        clearSearchBtn.hidden = true;
        renderDownloadsList();
    });

    document.getElementById("sort-select").addEventListener("change", (e) => {
        sortBy = e.target.value;
        saveViewState();
        renderDownloadsList();
    });

    document.getElementById("clear-completed-btn").addEventListener("click", openClearFinishedModal);

    // New Download Modal
    document.getElementById("modal-close-btn").addEventListener("click", closeNewDownloadModal);
    document.getElementById("modal-cancel-btn").addEventListener("click", closeNewDownloadModal);
    document.getElementById("inspect-btn").addEventListener("click", inspectUrlInput);
    document.getElementById("paste-clipboard-btn").addEventListener("click", pasteFromClipboard);
    document.getElementById("pick-dir-btn").addEventListener("click", pickDirectory);
    document.getElementById("start-btn").addEventListener("click", startDownloadJob);

    document.getElementById("url-input").addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            if (currentMetadata) {
                startDownloadJob();
            } else {
                inspectUrlInput();
            }
        }
    });

    // Settings Modal
    document.getElementById("settings-close-btn").addEventListener("click", closeSettingsModal);
    document.getElementById("settings-cancel-btn").addEventListener("click", closeSettingsModal);
    document.getElementById("settings-browse-btn").addEventListener("click", pickDirectoryForSettings);
    document.getElementById("save-settings").addEventListener("click", saveSettings);
    document.getElementById("browser-download-start").addEventListener("click", startBrowserDownloadFromDialog);
    document.getElementById("browser-download-browse").addEventListener("click", browseBrowserDownloadLocation);
    document.getElementById("browser-download-cancel").addEventListener("click", closeBrowserDownloadDialog);
    document.getElementById("browser-download-close").addEventListener("click", closeBrowserDownloadDialog);
    document.getElementById("bd-inspect-btn").addEventListener("click", inspectBrowserDownloadUrl);
    document.getElementById("bd-start-all-btn").addEventListener("click", startAllBrowserDownloads);
    document.getElementById("bd-browser-handle-btn").addEventListener("click", letBrowserHandleDownload);
    document.getElementById("browser-download-filename").addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            startBrowserDownloadFromDialog();
        }
    });
    document.getElementById("browser-download-modal").addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            startBrowserDownloadFromDialog();
        }
    });
    document.getElementById("settings-max-concurrent").addEventListener("input", (e) => {
        document.getElementById("concurrent-display").textContent = e.target.value;
    });
    document.querySelectorAll("[data-extension-tab]").forEach((tab) => tab.addEventListener("click", () => {
        document.querySelectorAll("[data-extension-tab]").forEach((item) => item.classList.toggle("active", item === tab));
        document.getElementById("extension-download-panel").hidden = tab.dataset.extensionTab !== "download";
        document.getElementById("extension-hidden-sites-panel").hidden = tab.dataset.extensionTab !== "hidden-sites";
    }));
    document.getElementById("hidden-site-add-btn").addEventListener("click", addHiddenSite);
    document.getElementById("hidden-site-input").addEventListener("keydown", (event) => {
        if (event.key === "Enter") addHiddenSite();
    });
    document.getElementById("hidden-sites-list").addEventListener("click", (event) => {
        const button = event.target.closest("[data-show-site]");
        if (!button) return;
        updateHiddenSites((appSettings?.hiddenSites ?? []).filter((site) => site !== button.dataset.showSite));
    });

    document.getElementById("btn-open-ext-folder").addEventListener("click", async () => {
        try {
            const folder = await invoke("extension_folder");
            if (!folder) {
                showToast("Extension folder not found — re-run ./install.sh", "error");
                return;
            }
            await invoke("open_folder", { path: folder });
            showToast("Opened extension folder", "info");
        } catch (err) {
            showToast("Could not open extension folder", "error");
        }
    });

    // Delete Modal
    document.getElementById("delete-modal-close-btn").addEventListener("click", closeDeleteModal);
    document.getElementById("delete-cancel-btn").addEventListener("click", closeDeleteModal);
    document.getElementById("delete-confirm-btn").addEventListener("click", confirmDeleteDownload);

    // Clear Finished Modal
    document.getElementById("clear-finished-close-btn").addEventListener("click", closeClearFinishedModal);
    document.getElementById("clear-finished-cancel-btn").addEventListener("click", closeClearFinishedModal);
    document.getElementById("clear-finished-confirm-btn").addEventListener("click", confirmClearFinished);

    // Browser download dialog: copy URL
    document.getElementById("bd-copy-url-btn").addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(document.getElementById("browser-download-url").value);
            showToast("URL copied to clipboard", "info");
        } catch (err) {
            showToast("Could not copy URL: " + err, "error");
        }
    });

    // Keyboard Shortcuts
    window.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
            e.preventDefault();
            openNewDownloadModal();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
            e.preventDefault();
            searchInput.focus();
        } else if (e.key === "Escape") {
            closeTopmostModal(e);
        }
    });
}

// ── Modals ──────────────────────────────────────────────────────────────────

async function openNewDownloadModal() {
    const modal = document.getElementById("new-download-modal");
    modal.hidden = false;
    const urlInput = document.getElementById("url-input");
    urlInput.focus();

    // Auto-paste if valid URL on clipboard
    try {
        if (navigator.clipboard?.readText) {
            const clipText = (await navigator.clipboard.readText()).trim();
            if (/^https?:\/\//i.test(clipText) && !urlInput.value) {
                urlInput.value = clipText;
                inspectUrlInput();
            }
        }
    } catch (_) {}
}

function closeNewDownloadModal() {
    document.getElementById("new-download-modal").hidden = true;
    document.getElementById("url-input").value = "";
    document.getElementById("custom-filename-input").value = "";
    document.getElementById("checksum-input").value = "";
    document.getElementById("bandwidth-input").value = "";
    document.getElementById("schedule-input").value = "";
    document.getElementById("metadata-panel").hidden = true;
    currentMetadata = null;
}

function openSettingsModal() {
    document.getElementById("settings-modal").hidden = false;
    loadSettings();
}

function closeSettingsModal() {
    document.getElementById("settings-modal").hidden = true;
    // Revert the unsaved folder pick (theme is reverted the same way).
    document.getElementById("settings-download-dir").textContent =
        appSettings?.defaultDownloadDir || "~/Downloads";
    applyTheme(getSavedTheme());
    const themeSelect = document.getElementById("settings-theme-select");
    if (themeSelect) {
        themeSelect.value = getSavedTheme();
        themeSelect.dispatchEvent(new Event("sync"));
    }
}

function openDeleteModal(downloadId, fileName) {
    deleteCandidateId = downloadId;
    document.getElementById("delete-item-name").textContent = fileName;
    document.getElementById("delete-file-checkbox").checked = false;
    document.getElementById("delete-modal").hidden = false;
}

function closeDeleteModal() {
    deleteCandidateId = null;
    document.getElementById("delete-modal").hidden = true;
}

// Esc behaves like a normal desktop app: it closes only the topmost visible
// modal and defers to other Esc consumers first (custom dropdown menus).
// The browser-download confirm dialog is excluded on purpose: dismissing it
// cancels a pending download, so that decision stays with the explicit
// Cancel button.
const MODAL_STACK = ["settings-modal", "new-download-modal", "clear-finished-modal", "delete-modal", "browser-download-modal"];

function closeTopmostModal(event) {
    // Let Esc first close any open custom dropdown menu instead of the modal.
    const openDropdown = document.querySelector(".custom-dropdown.open");
    if (openDropdown) {
        openDropdown.classList.remove("open");
        const btn = openDropdown.querySelector(".custom-dropdown-btn");
        if (btn) btn.setAttribute("aria-expanded", "false");
        return;
    }

    const openIds = MODAL_STACK.filter((id) => !document.getElementById(id).hidden);
    if (!openIds.length) return;
    // Last match in the stack order = visually topmost.
    const topId = openIds[openIds.length - 1];

    switch (topId) {
        case "settings-modal":
            closeSettingsModal();
            break;
        case "new-download-modal":
            closeNewDownloadModal();
            break;
        case "clear-finished-modal":
            closeClearFinishedModal();
            break;
        case "delete-modal":
            closeDeleteModal();
            break;
        case "browser-download-modal":
            // Intentionally ignored — explicit Cancel only.
            break;
    }
    if (event) event.preventDefault();
}

function resetBrowserDownloadMetadata() {
    document.getElementById("bd-metadata-panel").hidden = true;
    const inspectBtn = document.getElementById("bd-inspect-btn");
    if (inspectBtn) {
        inspectBtn.textContent = "Inspect";
        inspectBtn.disabled = false;
    }
}

function deriveFilenameFromUrl(url) {
    try {
        const pathname = new URL(url).pathname;
        const lastSegment = pathname.split("/").pop();
        if (lastSegment && lastSegment.includes(".")) return decodeURIComponent(lastSegment);
    } catch (_) {}
    return "";
}

function showNextBrowserDownload() {
    currentBrowserDownload = pendingBrowserDownloads.shift() || null;
    const modal = document.getElementById("browser-download-modal");
    if (!currentBrowserDownload) {
        modal.hidden = true;
        syncBrowserDialogFocus();
        return;
    }

    const url = currentBrowserDownload.url || "";
    document.getElementById("browser-download-url").value = url;
    document.getElementById("browser-download-location").value = currentBrowserDownload.saveDir || appSettings?.defaultDownloadDir || "";
    document.getElementById("browser-download-filename").value = currentBrowserDownload.sourceTitle || deriveFilenameFromUrl(url) || "Download";

    // Source page display
    const sourcePageEl = document.getElementById("bd-source-page");
    const sourcePageValue = document.getElementById("bd-source-page-value");
    if (currentBrowserDownload.sourcePageUrl) {
        try {
            sourcePageValue.textContent = new URL(currentBrowserDownload.sourcePageUrl).hostname;
        } catch (_) {
            sourcePageValue.textContent = currentBrowserDownload.sourcePageUrl;
        }
        sourcePageEl.hidden = false;
    } else {
        sourcePageEl.hidden = true;
    }

    // Queue counter
    const queueCounter = document.getElementById("bd-queue-counter");
    const remaining = pendingBrowserDownloads.length;
    if (remaining > 0) {
        queueCounter.textContent = `1 of ${remaining + 1}`;
        queueCounter.hidden = false;
    } else {
        queueCounter.hidden = true;
    }

    // Start All button visibility
    document.getElementById("bd-start-all-btn").hidden = remaining === 0;

    resetBrowserDownloadMetadata();
    modal.hidden = false;
    document.getElementById("browser-download-filename").focus();

    // IDM-style: the window this dialog lives in should be in front of
    // everything while a confirmation is pending (it also re-shows/focuses
    // the app if the browser triggered this while we're in the background).
    syncBrowserDialogFocus();

    // Auto-probe file details so they are never left empty; the Inspect
    // button stays available as a manual retry.
    performBrowserDownloadInspect(true);
}

// Keep the always-on-top pin in sync with the confirm dialog's visibility.
// Every queue transition funnels through showNextBrowserDownload.
function syncBrowserDialogFocus() {
    const visible = !document.getElementById("browser-download-modal").hidden;
    invoke("set_browser_dialog_focus", { active: visible }).catch(() => {});
}

function closeBrowserDownloadDialog() {
    currentBrowserDownload = null;
    resetBrowserDownloadMetadata();
    showNextBrowserDownload();
}

async function startBrowserDownloadFromDialog() {
    const saveDir = document.getElementById("browser-download-location").value.trim();
    if (!saveDir || !currentBrowserDownload) {
        showToast("Enter a save location to continue", "error");
        return;
    }
    const button = document.getElementById("browser-download-start");
    button.disabled = true;
    try {
        const editedFilename = document.getElementById("browser-download-filename").value.trim();
        if (editedFilename) currentBrowserDownload.sourceTitle = editedFilename;
        await invoke("start_browser_download", { request: currentBrowserDownload, saveDir });
        showToast("Download added to the queue", "success");
        currentBrowserDownload = null;
        resetBrowserDownloadMetadata();
        showNextBrowserDownload();
    } catch (error) {
        showToast("Could not start download: " + error, "error");
    } finally {
        button.disabled = false;
    }
}

// Stale-response guard: only the newest probe is allowed to write the UI
// (protects against auto-inspect and a manual Inspect click racing).
let browserInspectRun = 0;

async function performBrowserDownloadInspect(silent) {
    if (!currentBrowserDownload) return;
    const url = currentBrowserDownload.url;
    if (!url) return;

    const run = ++browserInspectRun;
    const btn = document.getElementById("bd-inspect-btn");
    if (!silent) {
        btn.textContent = "Inspecting…";
        btn.disabled = true;
    }

    // Placeholder while probing, so the card never shows stale data.
    const panel = document.getElementById("bd-metadata-panel");
    panel.hidden = false;
    document.getElementById("bd-size").textContent = "Checking…";
    document.getElementById("bd-type").textContent = "Checking…";
    document.getElementById("bd-resumable").textContent = "Checking…";

    try {
        const meta = await invoke("inspect_url", { url });
        if (run !== browserInspectRun) return;

        document.getElementById("bd-size").textContent = meta.contentLength
            ? formatBytes(meta.contentLength)
            : "Unknown / Stream";
        document.getElementById("bd-type").textContent = meta.contentType || "Binary";
        document.getElementById("bd-resumable").textContent = meta.resumable ? "Yes" : "No";

        const badge = document.getElementById("bd-resumable-badge");
        badge.textContent = meta.resumable ? "Resumable: Yes" : "Resumable: No";
        badge.style.color = meta.resumable ? "var(--status-success)" : "var(--status-warning)";
        badge.style.background = meta.resumable ? "var(--status-success-bg)" : "var(--status-warning-bg)";

        // Inspect returns the server-suggested filename (Content-Disposition); always use it
        if (meta.suggestedFileName) {
            document.getElementById("browser-download-filename").value = meta.suggestedFileName;
        }
    } catch (error) {
        if (run !== browserInspectRun) return;

        // Leave honest dashes so the user knows to retry with Inspect.
        document.getElementById("bd-size").textContent = "—";
        document.getElementById("bd-type").textContent = "—";
        document.getElementById("bd-resumable").textContent = "—";
        const badge = document.getElementById("bd-resumable-badge");
        badge.textContent = "Resumable: —";
        badge.style.color = "";
        badge.style.background = "";
        if (!silent) showToast("Could not inspect URL: " + error, "error");
    } finally {
        if (!silent) {
            btn.textContent = "Inspect";
            btn.disabled = false;
        }
    }
}

function inspectBrowserDownloadUrl() {
    return performBrowserDownloadInspect(false);
}

async function startAllBrowserDownloads() {
    const saveDir = document.getElementById("browser-download-location").value.trim() || appSettings?.defaultDownloadDir || "";
    if (!saveDir) {
        showToast("Enter a save location to continue", "error");
        return;
    }

    const allRequests = [currentBrowserDownload, ...pendingBrowserDownloads].filter(Boolean);
    pendingBrowserDownloads.length = 0;
    currentBrowserDownload = null;
    document.getElementById("browser-download-modal").hidden = true;
    resetBrowserDownloadMetadata();
    syncBrowserDialogFocus();

    let started = 0;
    for (const req of allRequests) {
        try {
            await invoke("start_browser_download", { request: req, saveDir });
            started++;
        } catch (error) {
            showToast(`Could not start ${req.sourceTitle || "download"}: ${error}`, "error");
        }
    }
    if (started > 0) showToast(`${started} download${started > 1 ? "s" : ""} added to the queue`, "success");
}

async function letBrowserHandleDownload() {
    if (!currentBrowserDownload) return;
    const url = currentBrowserDownload.url;
    try {
        await invoke("open_url", { url });
        showToast("Opened in browser", "info");
    } catch (error) {
        showToast("Could not open in browser: " + error, "error");
    }
    currentBrowserDownload = null;
    resetBrowserDownloadMetadata();
    showNextBrowserDownload();
}

async function browseBrowserDownloadLocation() {
    try {
        const initialDir = document.getElementById("browser-download-location").value || appSettings?.defaultDownloadDir;
        const path = await invoke("pick_save_directory", { initialDir });
        if (path) document.getElementById("browser-download-location").value = path;
    } catch (error) {
        showToast("Could not choose a save folder: " + error, "error");
    }
}

async function pasteFromClipboard() {
    try {
        const text = (await navigator.clipboard.readText()).trim();
        if (text) {
            document.getElementById("url-input").value = text;
            inspectUrlInput();
        }
    } catch (_) {
        showToast("Clipboard access unavailable", "error");
    }
}

// ── URL Inspection & Start Download ─────────────────────────────────────────

async function inspectUrlInput() {
    const url = document.getElementById("url-input").value.trim();
    if (!url) return;

    const btn = document.getElementById("inspect-btn");
    btn.textContent = "Inspecting…";
    btn.disabled = true;

    try {
        const metadata = await invoke("inspect_url", { url });
        currentMetadata = metadata;
        showMetadataCard(metadata);
    } catch (error) {
        showToast("Could not inspect URL: " + error, "error");
    } finally {
        btn.textContent = "Inspect";
        btn.disabled = false;
    }
}

function showMetadataCard(meta) {
    const panel = document.getElementById("metadata-panel");
    panel.hidden = false;

    document.getElementById("custom-filename-input").value = meta.suggestedFileName || "";
    document.getElementById("meta-size").textContent = meta.contentLength
        ? formatBytes(meta.contentLength)
        : "Unknown / Stream";
    document.getElementById("meta-type").textContent = meta.contentType || "Binary";
    document.getElementById("meta-resumable").textContent = meta.resumable ? "Yes (Multi-threaded)" : "No";

    const badge = document.getElementById("meta-resumable-badge");
    badge.textContent = meta.resumable ? "Resumable: Yes" : "Resumable: No";
    badge.style.color = meta.resumable ? "var(--status-success)" : "var(--status-warning)";
    badge.style.background = meta.resumable ? "var(--status-success-bg)" : "var(--status-warning-bg)";
}

async function startDownloadJob() {
    const url = document.getElementById("url-input").value.trim();
    if (!url) {
        showToast("Please enter a download URL", "error");
        return;
    }

    const customFileName = document.getElementById("custom-filename-input").value.trim() || null;
    const saveDir = document.getElementById("save-dir-input").value.trim() || null;
    const expectedChecksum = document.getElementById("checksum-input").value.trim() || null;
    const bandwidthVal = document.getElementById("bandwidth-input").value;
    const bandwidthLimitKbps = bandwidthVal ? parseInt(bandwidthVal) : null;
    const scheduledAt = document.getElementById("schedule-input").value || null;

    const startBtn = document.getElementById("start-btn");
    startBtn.disabled = true;

    try {
        await invoke("start_download", {
            url,
            saveDir,
            expectedChecksum,
            scheduledAt,
            bandwidthLimitKbps,
            customFileName,
        });

        showToast("Download started", "success");
        closeNewDownloadModal();
        await loadDownloads();
    } catch (error) {
        showToast("Could not start download: " + error, "error");
    } finally {
        startBtn.disabled = false;
    }
}

async function pickDirectory() {
    try {
        const path = await invoke("pick_save_directory");
        if (path) {
            document.getElementById("save-dir-input").value = path;
        }
    } catch (error) {
        console.error("Could not pick folder:", error);
    }
}

async function pickDirectoryForSettings() {
    try {
        const path = await invoke("pick_save_directory");
        if (path) {
            document.getElementById("settings-download-dir").textContent = path;
        }
    } catch (error) {
        console.error("Could not pick folder:", error);
    }
}

// ── Theme Management ────────────────────────────────────────────────────────

function getSavedTheme() {
    try {
        return localStorage.getItem("ldm_theme") || "system";
    } catch {
        return "system";
    }
}

function applyTheme(choice) {
    let effective = choice;
    if (choice === "system") {
        effective = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    document.documentElement.setAttribute("data-theme", effective);
}

function initTheme() {
    applyTheme(getSavedTheme());
    if (window.matchMedia) {
        window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
            if (getSavedTheme() === "system") {
                applyTheme("system");
            }
        });
    }
}

// ── Custom Dropdowns ────────────────────────────────────────────────────────

function setupCustomDropdown(containerId, selectId) {
    const container = document.getElementById(containerId);
    const select = document.getElementById(selectId);
    if (!container || !select) return;

    const trigger = container.querySelector(".custom-dropdown-btn");
    const label = container.querySelector(".custom-dropdown-label");
    const items = container.querySelectorAll(".custom-dropdown-item");

    function updateUI() {
        const val = select.value;
        items.forEach((item) => {
            const isMatch = item.dataset.value === val;
            item.classList.toggle("active", isMatch);
            if (isMatch && label) {
                label.textContent = item.textContent;
            }
        });
    }

    if (trigger) {
        trigger.addEventListener("click", (e) => {
            e.stopPropagation();
            const isOpen = container.classList.contains("open");
            document.querySelectorAll(".custom-dropdown.open").forEach((d) => {
                if (d !== container) d.classList.remove("open");
            });
            container.classList.toggle("open", !isOpen);
            trigger.setAttribute("aria-expanded", !isOpen ? "true" : "false");
        });
    }

    items.forEach((item) => {
        item.addEventListener("click", (e) => {
            e.stopPropagation();
            const val = item.dataset.value;
            select.value = val;
            updateUI();
            container.classList.remove("open");
            if (trigger) trigger.setAttribute("aria-expanded", "false");
            select.dispatchEvent(new Event("change"));
        });
    });

    select.addEventListener("sync", updateUI);
    updateUI();
}

function initCustomDropdowns() {
    setupCustomDropdown("sort-dropdown", "sort-select");
    setupCustomDropdown("theme-dropdown", "settings-theme-select");

    document.addEventListener("click", () => {
        document.querySelectorAll(".custom-dropdown.open").forEach((d) => {
            d.classList.remove("open");
            const btn = d.querySelector(".custom-dropdown-btn");
            if (btn) btn.setAttribute("aria-expanded", "false");
        });
    });
}

// ── Application Settings ────────────────────────────────────────────────────

async function loadSettings() {
    try {
        const themeSelect = document.getElementById("settings-theme-select");
        if (themeSelect) {
            themeSelect.value = getSavedTheme();
            themeSelect.dispatchEvent(new Event("sync"));
        }

        appSettings = await invoke("app_settings");
        if (appSettings) {
            document.getElementById("settings-download-dir").textContent = appSettings.defaultDownloadDir || "~/Downloads";
            document.getElementById("sidebar-download-dir").textContent = appSettings.defaultDownloadDir || "~/Downloads";
            document.getElementById("settings-max-concurrent").value = appSettings.maxConcurrentDownloads || 3;
            document.getElementById("concurrent-display").textContent = appSettings.maxConcurrentDownloads || 3;
            document.getElementById("settings-bandwidth-limit").value = appSettings.defaultBandwidthLimitKbps || "";
            document.getElementById("settings-ask-browser-location").checked = appSettings.askBrowserDownloadLocation !== false;
            renderHiddenSites();
        }
    } catch (error) {
        console.error("Could not load settings:", error);
    }
}

function renderHiddenSites() {
    const list = document.getElementById("hidden-sites-list");
    list.replaceChildren();
    const sites = [...new Set(appSettings?.hiddenSites ?? [])].sort();
    if (!sites.length) {
        const empty = document.createElement("div");
        empty.className = "hidden-sites-empty";
        empty.textContent = "No sites are hidden. The download icon is available on all supported sites.";
        list.appendChild(empty);
        return;
    }
    for (const site of sites) {
        const row = document.createElement("div");
        row.className = "hidden-site-row";
        const domain = document.createElement("span");
        domain.className = "hidden-site-domain";
        domain.textContent = site;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-secondary btn-sm";
        button.dataset.showSite = site;
        button.textContent = "Show on site";
        row.append(domain, button);
        list.appendChild(row);
    }
}

async function addHiddenSite() {
    const input = document.getElementById("hidden-site-input");
    const value = input.value.trim();
    if (!value) return;
    try {
        const hostname = new URL(value.includes("://") ? value : `https://${value}`).hostname.toLowerCase();
        if (!hostname) throw new Error("Enter a valid website address");
        const sites = [...new Set([...(appSettings?.hiddenSites ?? []), hostname])];
        await updateHiddenSites(sites);
        input.value = "";
    } catch (error) {
        showToast(error.message || "Enter a valid website address", "error");
    }
}

async function updateHiddenSites(hiddenSites) {
    try {
        appSettings = await invoke("update_app_settings", { hiddenSites });
        renderHiddenSites();
        showToast("Hidden sites updated", "success");
    } catch (error) {
        showToast("Could not update hidden sites: " + error, "error");
    }
}

async function saveSettings() {
    const maxConcurrent = parseInt(document.getElementById("settings-max-concurrent").value);
    const bandwidthLimit = parseInt(document.getElementById("settings-bandwidth-limit").value) || 0;

    const args = {
        maxConcurrentDownloads: maxConcurrent,
        defaultBandwidthLimitKbps: bandwidthLimit,
        askBrowserDownloadLocation: document.getElementById("settings-ask-browser-location").checked,
    };

    // Only send the folder when the user actually picked a new one.
    const pickedDir = document.getElementById("settings-download-dir").textContent.trim();
    if (pickedDir && pickedDir !== (appSettings?.defaultDownloadDir || "")) {
        args.defaultDownloadDir = pickedDir;
    }

    try {
        await invoke("update_app_settings", args);

        const themeSelect = document.getElementById("settings-theme-select");
        if (themeSelect) {
            const selectedTheme = themeSelect.value;
            try {
                localStorage.setItem("ldm_theme", selectedTheme);
            } catch (e) {
                console.error("Could not save theme preference:", e);
            }
            applyTheme(selectedTheme);
            themeSelect.dispatchEvent(new Event("sync"));
        }

        showToast("Settings saved", "success");
        await loadSettings();
        closeSettingsModal();
    } catch (error) {
        showToast("Could not save settings: " + error, "error");
        // Revert the folder display (and everything else) to persisted values.
        await loadSettings();
    }
}

// ── Downloads Data Loading ──────────────────────────────────────────────────

async function loadDownloads() {
    try {
        const list = await invoke("list_downloads");
        allDownloads = Array.isArray(list) ? list : [];
        updateCounts();
        renderDownloadsList();
    } catch (error) {
        console.error("Could not load downloads:", error);
        allDownloads = [];
        updateCounts();
        renderDownloadsList();
    }
}

function openClearFinishedModal() {
    const finishedCount = allDownloads.filter((d) => d.status === "completed" || d.status === "failed").length;
    if (finishedCount === 0) {
        showToast("No finished items to clear", "info");
        return;
    }
    document.getElementById("clear-finished-count").textContent = finishedCount;
    document.getElementById("clear-finished-modal").hidden = false;
}

function closeClearFinishedModal() {
    document.getElementById("clear-finished-modal").hidden = true;
}

async function confirmClearFinished() {
    closeClearFinishedModal();
    try {
        const count = await invoke("clear_completed");
        showToast(`Cleared ${count} finished item${count === 1 ? "" : "s"}`, "info");
        await loadDownloads();
    } catch (error) {
        showToast("Could not clear list: " + error, "error");
    }
}

async function confirmDeleteDownload() {
    if (!deleteCandidateId) return;
    const deleteFile = document.getElementById("delete-file-checkbox").checked;
    const id = deleteCandidateId;

    try {
        await invoke("delete_download", { id, deleteFile });
        showToast(deleteFile ? "Deleted download and file" : "Removed download from list", "info");
        closeDeleteModal();
        await loadDownloads();
    } catch (err) {
        showToast("Could not delete download: " + err, "error");
    }
}

async function togglePauseAll() {
    const hasActive = allDownloads.some((d) => d.status === "in_progress");
    const hasPaused = allDownloads.some((d) => d.status === "paused");

    if (hasActive) {
        for (const dl of allDownloads.filter((d) => d.status === "in_progress")) {
            try { await invoke("pause_download", { id: dl.id }); } catch (_) {}
        }
        showToast("Paused all downloads", "info");
    } else if (hasPaused) {
        for (const dl of allDownloads.filter((d) => d.status === "paused")) {
            try { await invoke("resume_download", { id: dl.id }); } catch (_) {}
        }
        showToast("Resumed downloads", "info");
    }
    await loadDownloads();
}

// ── Rendering Download Items ────────────────────────────────────────────────

// Skip re-rendering when nothing visually relevant changed. The adaptive
// poll runs every 800 ms during active downloads; live byte/speed updates
// are patched into card DOM directly elsewhere, so a full innerHTML rebuild
// on every tick only destroys hover/focus states and wastes cycles.
let lastRenderSignature = null;

function renderDownloadsList() {
    const container = document.getElementById("downloads-container");

    // Clean up stale live stats for downloads no longer in the list
    const validIds = new Set(allDownloads.map((dl) => dl.id));
    for (const key of liveDownloadStats.keys()) {
        if (!validIds.has(key)) liveDownloadStats.delete(key);
    }

    // Filter (scheduled items count as queued in the sidebar, so include them)
    let filtered = allDownloads.filter((dl) => {
        if (currentFilter !== "all" && dl.status !== currentFilter) {
            if (!(currentFilter === "queued" && dl.status === "scheduled")) return false;
        }
        if (currentCategory !== "all") {
            const cat = categorizeFile(dl.fileName);
            if (cat !== currentCategory) return false;
        }
        if (searchQuery) {
            const nameMatch = dl.fileName.toLowerCase().includes(searchQuery);
            const urlMatch = dl.url.toLowerCase().includes(searchQuery);
            if (!nameMatch && !urlMatch) return false;
        }
        return true;
    });

    // Sort
    filtered.sort((a, b) => {
        if (sortBy === "newest") return b.id - a.id;
        if (sortBy === "oldest") return a.id - b.id;
        if (sortBy === "name") return a.fileName.localeCompare(b.fileName);
        if (sortBy === "size") return (b.totalBytes || b.downloadedBytes || 0) - (a.totalBytes || a.downloadedBytes || 0);
        return 0;
    });

    const signature = [
        currentFilter, currentCategory, searchQuery, sortBy,
        ...filtered.map((dl) => [dl.id, dl.status, dl.fileName, dl.totalBytes, dl.checksumStatus || "", dl.errorMessage || ""].join("|")),
    ].join(";");
    if (signature === lastRenderSignature) return;
    lastRenderSignature = signature;

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M12 17V3"></path>
                        <path d="m6 11 6 6 6-6"></path>
                        <path d="M19 21H5"></path>
                    </svg>
                </div>
                <div class="empty-state-title">${searchQuery ? "No matching downloads" : "No downloads in this view"}</div>
                <div class="empty-state-desc">${searchQuery ? "Try a different search keyword." : "Click New Download to start, or set up the browser extension from Settings."}</div>
                ${!searchQuery ? `<button class="btn btn-primary" onclick="openNewDownloadModal()">+ New Download</button>` : ""}
            </div>
        `;
        return;
    }

    container.innerHTML = filtered.map((dl) => renderDownloadCard(dl)).join("");
    attachCardActionHandlers();
}

// Rolling client-side download speed tracker (IDM-style real-time smoothing)
const clientDownloadTrackers = new Map();

function getComputedDownloadSpeedAndEta(id, downloaded, total, backendSpeed, backendEta) {
    const now = Date.now();
    let tracker = clientDownloadTrackers.get(id);

    if (!tracker) {
        tracker = {
            lastBytes: downloaded,
            lastTime: now,
            speed: backendSpeed || 0,
            smoothedSpeed: backendSpeed || 0
        };
        clientDownloadTrackers.set(id, tracker);
        const initialSpeed = backendSpeed || 0;
        return {
            speed: initialSpeed,
            eta: backendEta || (initialSpeed > 0 && total && downloaded < total ? Math.round((total - downloaded) / initialSpeed) : null)
        };
    }

    const elapsedMs = now - tracker.lastTime;
    let speed = 0;

    if (backendSpeed && backendSpeed > 0) {
        speed = backendSpeed;
        tracker.smoothedSpeed = tracker.smoothedSpeed > 0
            ? Math.round(tracker.smoothedSpeed * 0.65 + backendSpeed * 0.35)
            : backendSpeed;
        tracker.lastBytes = downloaded;
        tracker.lastTime = now;
        speed = tracker.smoothedSpeed;
    } else if (elapsedMs >= 350) {
        const deltaBytes = Math.max(0, downloaded - tracker.lastBytes);
        const instantSpeed = Math.round((deltaBytes / elapsedMs) * 1000);
        if (instantSpeed > 0) {
            tracker.smoothedSpeed = tracker.smoothedSpeed > 0
                ? Math.round(tracker.smoothedSpeed * 0.65 + instantSpeed * 0.35)
                : instantSpeed;
            speed = tracker.smoothedSpeed;
        } else {
            speed = tracker.smoothedSpeed || 0;
        }
        tracker.lastBytes = downloaded;
        tracker.lastTime = now;
    } else {
        speed = tracker.smoothedSpeed || 0;
    }

    let eta = backendEta;
    if ((!eta || eta <= 0) && speed > 0 && total && downloaded < total) {
        eta = Math.round((total - downloaded) / speed);
    }

    return { speed, eta };
}

function renderDownloadCard(dl) {
    const liveStats = liveDownloadStats.get(dl.id);
    const downloaded = liveStats?.downloadedBytes ?? dl.downloadedBytes;
    const total = liveStats?.totalBytes ?? dl.totalBytes;
    const isDownloading = dl.status === "in_progress";

    const { speed, eta } = isDownloading
        ? getComputedDownloadSpeedAndEta(
            dl.id,
            downloaded,
            total,
            liveStats?.speedBytesPerSecond ?? dl.speedBytesPerSecond,
            liveStats?.etaSeconds ?? dl.etaSeconds
        )
        : { speed: 0, eta: null };

    if (isDownloading && speed > 0) {
        liveDownloadStats.set(dl.id, {
            speedBytesPerSecond: speed,
            etaSeconds: eta,
            downloadedBytes: downloaded,
            totalBytes: total,
        });
    }

    const progress = total ? Number(Math.min(100, (downloaded / total) * 100).toFixed(1)) : 0;
    const category = categorizeFile(dl.fileName);

    let host = "";
    try {
        host = new URL(dl.url).hostname.replace(/^www\./, "");
    } catch (_) {
        host = "web";
    }

    // Size text
    let sizeText = total
        ? `${formatBytes(downloaded)} / ${formatBytes(total)}`
        : formatBytes(downloaded);

    // Speed text
    let speedHtml = "";
    if (isDownloading && speed > 0) {
        speedHtml = `
            <span class="metric-divider">·</span>
            <span class="metric-speed">${formatBytes(speed)}/s</span>
        `;
    }

    // ETA text
    let etaHtml = "";
    if (isDownloading && eta && eta > 0) {
        etaHtml = `
            <span class="metric-divider">·</span>
            <span class="metric-eta">${formatTime(eta)} left</span>
        `;
    }

    // Checksum indicator
    let checksumHtml = "";
    if (dl.checksumStatus === "verified") {
        checksumHtml = `<span class="metric-checksum verified">✓ Checksum OK</span>`;
    } else if (dl.checksumStatus === "mismatch") {
        checksumHtml = `<span class="metric-checksum mismatch">✗ Checksum Mismatch</span>`;
    }

    // Action buttons
    let actions = "";
    if (dl.status === "completed") {
        actions = `
            <button class="btn btn-secondary btn-sm" data-action="open-file" data-path="${escapeAttr(dl.savePath)}" title="Open file">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                <span>Open</span>
            </button>
            <button class="btn btn-secondary btn-sm" data-action="open-folder" data-path="${escapeAttr(dl.savePath)}" title="Open enclosing folder">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path></svg>
                <span>Folder</span>
            </button>
            <button class="btn btn-ghost btn-sm btn-icon-only" data-action="copy-path" data-path="${escapeAttr(dl.savePath)}" title="Copy file path" aria-label="Copy file path">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path><path d="M14 2v4a2 2 0 0 0 2 2h4"></path></svg>
            </button>
            <button class="btn btn-ghost btn-sm btn-icon-only" data-action="copy-link" data-url="${escapeAttr(dl.url)}" title="Copy download URL" aria-label="Copy download URL">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>
            </button>
            <button class="btn btn-ghost btn-sm btn-icon-only" data-action="delete" data-id="${dl.id}" data-name="${escapeAttr(dl.fileName)}" title="Remove download" aria-label="Remove download">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
        `;
    } else if (isDownloading || dl.status === "queued") {
        actions = `
            <button class="btn btn-secondary btn-sm" data-action="pause" data-id="${dl.id}" title="Pause download">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16" rx="1" ry="1"></rect><rect x="14" y="4" width="4" height="16" rx="1" ry="1"></rect></svg>
                <span>Pause</span>
            </button>
            <button class="btn btn-ghost btn-sm btn-icon-only" data-action="copy-link" data-url="${escapeAttr(dl.url)}" title="Copy link" aria-label="Copy link">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>
            </button>
            <button class="btn btn-danger btn-sm" data-action="cancel" data-id="${dl.id}" title="Cancel download">Cancel</button>
        `;
    } else {
        // Paused or Failed
        actions = `
            <button class="btn btn-primary btn-sm" data-action="resume" data-id="${dl.id}" title="Resume download">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                <span>Resume</span>
            </button>
            <button class="btn btn-ghost btn-sm btn-icon-only" data-action="copy-path" data-path="${escapeAttr(dl.savePath)}" title="Copy file path" aria-label="Copy file path">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path><path d="M14 2v4a2 2 0 0 0 2 2h4"></path></svg>
            </button>
            <button class="btn btn-ghost btn-sm btn-icon-only" data-action="copy-link" data-url="${escapeAttr(dl.url)}" title="Copy link" aria-label="Copy link">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>
            </button>
            <button class="btn btn-ghost btn-sm btn-icon-only" data-action="delete" data-id="${dl.id}" data-name="${escapeAttr(dl.fileName)}" title="Remove" aria-label="Remove download">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
        `;
    }

    // Error Box
    let errorBox = "";
    if (dl.status === "failed" && dl.errorMessage) {
        errorBox = `<div class="card-error-box">${escapeHtml(dl.errorMessage)}</div>`;
    }

    return `
        <div class="download-card ${isDownloading ? "card-active" : ""}" data-download-id="${dl.id}">
            <div class="card-header">
                <div class="file-type-icon">
                    ${getCategorySvgIcon(category)}
                </div>
                <div class="card-title-group">
                    <div class="file-name-row">
                        <span class="file-name" title="${escapeAttr(dl.fileName)} (${escapeAttr(dl.savePath)})">${escapeHtml(dl.fileName)}</span>
                        <span class="domain-pill">${escapeHtml(host)}</span>
                    </div>
                </div>
                <div class="status-pill status-${dl.status}">
                    ${dl.status === "in_progress" ? `<span class="status-dot status-dot-active"></span>` : ""}
                    <span>${formatStatusLabel(dl.status)}</span>
                </div>
            </div>

            <div class="progress-container">
                <div class="progress-track">
                    <div class="progress-fill" style="width: ${progress}%"></div>
                </div>
            </div>

            <div class="card-footer">
                <div class="card-metrics">
                    <span class="metric-size">${sizeText}</span>
                    <span class="metric-percent">(${total ? `${progress}%` : "Live"})</span>
                    <span class="metric-speed-wrapper">${speedHtml}</span>
                    <span class="metric-eta-wrapper">${etaHtml}</span>
                    ${checksumHtml}
                </div>
                <div class="card-actions">
                    ${actions}
                </div>
            </div>
            ${errorBox}
        </div>
    `;
}

function attachCardActionHandlers() {
    document.querySelectorAll("[data-action]").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const action = btn.dataset.action;
            const id = btn.dataset.id ? parseInt(btn.dataset.id) : null;
            const path = btn.dataset.path;
            const url = btn.dataset.url;
            const name = btn.dataset.name;

            try {
                if (action === "pause") {
                    await invoke("pause_download", { id });
                    showToast("Paused", "info");
                    await loadDownloads();
                } else if (action === "resume") {
                    await invoke("resume_download", { id });
                    showToast("Resumed", "success");
                    await loadDownloads();
                } else if (action === "cancel") {
                    await invoke("cancel_download", { id });
                    showToast("Cancelled", "info");
                    await loadDownloads();
                } else if (action === "delete") {
                    openDeleteModal(id, name);
                } else if (action === "open-file") {
                    await invoke("open_file", { path });
                } else if (action === "open-folder") {
                    await invoke("open_folder", { path });
                } else if (action === "copy-path") {
                    await navigator.clipboard.writeText(path);
                    showToast("File path copied to clipboard", "info");
                } else if (action === "copy-link") {
                    await navigator.clipboard.writeText(url);
                    showToast("Link copied to clipboard", "info");
                }
            } catch (err) {
                showToast(`Action failed: ${err}`, "error");
            }
        });
    });
}

// ── Realtime IPC Updates & Stats Ticker ──────────────────────────────────────

let adaptivePollTimeout = null;

function scheduleAdaptivePoll() {
    clearTimeout(adaptivePollTimeout);
    const hasActive = allDownloads.some((d) => d.status === "in_progress");
    const interval = hasActive ? 800 : 3000;
    adaptivePollTimeout = setTimeout(async () => {
        await loadDownloads();
        scheduleAdaptivePoll();
    }, interval);
}

function initRealtimeListeners() {
    listen("download://state", (event) => {
        handleDownloadStateEvent(event.payload);
    });

    listen("tray-action", (event) => {
        if (event.payload === "add") {
            openNewDownloadModal();
        } else if (event.payload === "settings") {
            openSettingsModal();
        }
    });

    listen("browser-download-prompt", (event) => {
        pendingBrowserDownloads.push(event.payload);
        if (!currentBrowserDownload) showNextBrowserDownload();
    });

    scheduleAdaptivePoll();
}

// In-app announcement for a finished download. Complements the backend
// attention nudge: completion gets a normal toast with an "Open file"
// action; failure is sticky (never auto-dismisses) because it needs the
// user's decision.
function announceFinishedDownload(event) {
    const dl = allDownloads.find((d) => d.id === event.id);
    const name = dl?.fileName || "Download";

    if (event.status === "completed") {
        const suffix = event.errorMessage ? ` (${event.errorMessage})` : "";
        const actions = dl?.savePath
            ? [{
                  label: "Open file",
                  onClick: () => {
                      invoke("open_file", { path: dl.savePath }).catch((err) =>
                          showToast("Could not open file: " + err, "error")
                      );
                  },
              }]
            : [];
        showActionToast({
            message: `${name} — download completed${suffix}`,
            type: "success",
            duration: 6000,
            actions,
        });
    } else {
        showActionToast({
            message: `${name} — download failed${event.errorMessage ? `: ${event.errorMessage}` : ""}`,
            type: "error",
            sticky: true,
        });
    }
}

function handleDownloadStateEvent(event) {
    if (event.status === "in_progress") {
        const { speed, eta } = getComputedDownloadSpeedAndEta(
            event.id,
            event.downloadedBytes,
            event.totalBytes,
            event.speedBytesPerSecond,
            event.etaSeconds
        );
        liveDownloadStats.set(event.id, {
            speedBytesPerSecond: speed,
            etaSeconds: eta,
            downloadedBytes: event.downloadedBytes,
            totalBytes: event.totalBytes,
        });
    } else {
        liveDownloadStats.delete(event.id);
        clientDownloadTrackers.delete(event.id);
        if (event.status === "completed" || event.status === "failed") {
            announceFinishedDownload(event);
        }
    }

    // Fast DOM update if card exists
    const card = document.querySelector(`[data-download-id="${event.id}"]`);
    if (card) {
        const total = event.totalBytes;
        const downloaded = event.downloadedBytes;
        const progress = total ? Number(Math.min(100, (downloaded / total) * 100).toFixed(1)) : 0;
        const fill = card.querySelector(".progress-fill");
        if (fill) fill.style.width = `${progress}%`;

        const metricsEl = card.querySelector(".card-metrics");
        if (metricsEl) {
            const sizeEl = metricsEl.querySelector(".metric-size");
            if (sizeEl) {
                sizeEl.textContent = total
                    ? `${formatBytes(downloaded)} / ${formatBytes(total)}`
                    : formatBytes(downloaded);
            }
            const pctEl = metricsEl.querySelector(".metric-percent");
            if (pctEl) {
                pctEl.textContent = `(${total ? `${progress}%` : "Live"})`;
            }

            const stats = liveDownloadStats.get(event.id);
            const speed = stats?.speedBytesPerSecond || 0;
            const speedWrap = metricsEl.querySelector(".metric-speed-wrapper");
            if (speedWrap) {
                speedWrap.innerHTML = speed > 0
                    ? `<span class="metric-divider">·</span><span class="metric-speed">${formatBytes(speed)}/s</span>`
                    : "";
            }

            const eta = stats?.etaSeconds;
            const etaWrap = metricsEl.querySelector(".metric-eta-wrapper");
            if (etaWrap) {
                etaWrap.innerHTML = (eta && eta > 0)
                    ? `<span class="metric-divider">·</span><span class="metric-eta">${formatTime(eta)} left</span>`
                    : "";
            }
        }

        if (event.status !== "in_progress") {
            loadDownloads();
        }
    } else {
        loadDownloads();
    }
}

function startStatsTicker() {
    setInterval(() => {
        let totalSpeed = 0;
        let activeCount = 0;
        let queuedCount = 0;

        for (const dl of allDownloads) {
            if (dl.status === "in_progress") {
                activeCount++;
                const stats = liveDownloadStats.get(dl.id);
                const s = stats?.speedBytesPerSecond ?? dl.speedBytesPerSecond ?? 0;
                if (s > 0) {
                    totalSpeed += s;
                }
            } else if (dl.status === "queued" || dl.status === "scheduled") {
                queuedCount++;
            }
        }

        const speedEl = document.getElementById("global-speed");
        const pulseEl = document.getElementById("speed-pulse");
        const queueEl = document.getElementById("global-queue-status");
        const pauseAllLabel = document.getElementById("label-pause-all");

        if (totalSpeed > 0) {
            speedEl.textContent = formatSpeed(totalSpeed);
            pulseEl.classList.add("active");
        } else {
            speedEl.textContent = formatBytes(0);
            pulseEl.classList.remove("active");
        }

        if (activeCount > 0 || queuedCount > 0) {
            queueEl.textContent = `${activeCount} active · ${queuedCount} queued`;
        } else {
            queueEl.textContent = "Idle";
        }

        if (activeCount > 0) {
            pauseAllLabel.textContent = "Pause All";
        } else if (allDownloads.some((d) => d.status === "paused")) {
            pauseAllLabel.textContent = "Resume All";
        } else {
            pauseAllLabel.textContent = "Pause All";
        }
    }, 500);
}

function updateCounts() {
    const counts = {
        all: allDownloads.length,
        in_progress: 0,
        queued: 0,
        paused: 0,
        completed: 0,
        failed: 0,
    };

    const catCounts = {
        video: 0,
        audio: 0,
        archive: 0,
        document: 0,
        image: 0,
        other: 0,
    };

    for (const dl of allDownloads) {
        if (counts[dl.status] !== undefined) {
            counts[dl.status]++;
        } else if (dl.status === "scheduled") {
            counts.queued++;
        }

        const cat = categorizeFile(dl.fileName);
        if (catCounts[cat] !== undefined) {
            catCounts[cat]++;
        }
    }

    document.getElementById("count-all").textContent = counts.all;
    document.getElementById("count-in_progress").textContent = counts.in_progress;
    document.getElementById("count-queued").textContent = counts.queued;
    document.getElementById("count-paused").textContent = counts.paused;
    document.getElementById("count-completed").textContent = counts.completed;
    document.getElementById("count-failed").textContent = counts.failed;

    const catElements = {
        "cat-video": document.getElementById("cat-video"),
        "cat-audio": document.getElementById("cat-audio"),
        "cat-archive": document.getElementById("cat-archive"),
        "cat-document": document.getElementById("cat-document"),
        "cat-image": document.getElementById("cat-image"),
        "cat-other": document.getElementById("cat-other"),
    };
    for (const [id, el] of Object.entries(catElements)) {
        if (el) el.textContent = catCounts[id.replace("cat-", "")] ?? 0;
    }
}

// ── File Categorization & Utilities ─────────────────────────────────────────

function categorizeFile(filename) {
    if (!filename || typeof filename !== "string") return "other";
    const parts = filename.toLowerCase().split(".");
    if (parts.length < 2) return "other";
    const ext = parts.pop();

    const videoExts = ["mp4", "mkv", "webm", "avi", "mov", "flv", "wmv", "m4v", "ts", "m3u8"];
    const audioExts = ["mp3", "m4a", "wav", "flac", "aac", "ogg", "opus", "wma"];
    const archiveExts = ["zip", "tar", "gz", "bz2", "xz", "7z", "rar", "deb", "rpm", "appimage", "iso", "bin", "apk", "exe"];
    const docExts = ["pdf", "doc", "docx", "txt", "rtf", "odt", "epub", "xls", "xlsx", "ppt", "pptx", "csv", "md"];
    const imgExts = ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "tiff"];

    if (videoExts.includes(ext)) return "video";
    if (audioExts.includes(ext)) return "audio";
    if (archiveExts.includes(ext)) return "archive";
    if (docExts.includes(ext)) return "document";
    if (imgExts.includes(ext)) return "image";
    return "other";
}

function getCategorySvgIcon(cat) {
    switch (cat) {
        case "video":
            return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"></path><rect x="2" y="6" width="14" height="12" rx="2" ry="2"></rect></svg>`;
        case "audio":
            return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 10v3"></path><path d="M6 6v11"></path><path d="M10 3v18"></path><path d="M14 8v7"></path><path d="M18 5v13"></path><path d="M22 10v3"></path></svg>`;
        case "archive":
            return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="11"></line></svg>`;
        case "document":
            return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path><path d="M14 2v4a2 2 0 0 0 2 2h4"></path><path d="M10 9H8"></path><path d="M16 13H8"></path><path d="M16 17H8"></path></svg>`;
        case "image":
            return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"></path></svg>`;
        default:
            return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path><path d="M14 2v4a2 2 0 0 0 2 2h4"></path></svg>`;
    }
}

function formatStatusLabel(status) {
    switch (status) {
        case "in_progress": return "Downloading";
        case "completed": return "Completed";
        case "paused": return "Paused";
        case "queued": return "Queued";
        case "scheduled": return "Scheduled";
        case "failed": return "Failed";
        case "cancelled": return "Cancelled";
        default: return status;
    }
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + units[i];
}

function formatSpeed(bytesPerSecond) {
    const mbps = (bytesPerSecond * 8) / 1000000;
    return `${formatBytes(bytesPerSecond)}/s (${mbps.toFixed(1)} Mbps)`;
}

function formatTime(seconds) {
    if (!seconds || seconds <= 0) return "0s";
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function escapeHtml(text) {
    if (!text) return "";
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

function escapeAttr(text) {
    if (!text) return "";
    return text.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ── Toasts ──────────────────────────────────────────────────────────────────

const MAX_VISIBLE_TOASTS = 5;

function dismissToast(toast) {
    clearTimeout(toast._timer);
    toast.style.opacity = "0";
    toast.style.transform = "translateY(6px)";
    toast.style.transition = "all 0.2s ease";
    setTimeout(() => toast.remove(), 200);
}

function toastIconSvg(type) {
    if (type === "success") {
        return `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    }
    if (type === "error") {
        return `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
    }
    return `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
}

function showToast(message, type = "info", duration = 2800) {
    const container = document.getElementById("toast-container");
    if (!container) return;

    // Cap the stack so a burst (e.g. "Start All") doesn't flood the corner.
    while (container.children.length >= MAX_VISIBLE_TOASTS) {
        container.firstElementChild.remove();
    }

    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        ${toastIconSvg(type)}
        <span>${escapeHtml(message)}</span>
    `;
    startToastLifecycle(toast, duration);
    container.appendChild(toast);
}

// Rich toast: optional sticky mode (never auto-dismisses — used for
// failures that need the user's attention) and optional action buttons
// (e.g. "Open file" on a completed download).
function showActionToast({ message, type = "info", duration = 2800, sticky = false, actions = [] }) {
    const container = document.getElementById("toast-container");
    if (!container) return;

    while (container.children.length >= MAX_VISIBLE_TOASTS) {
        container.firstElementChild.remove();
    }

    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        ${toastIconSvg(type)}
        <span>${escapeHtml(message)}</span>
        ${actions.map((action) => `<button class="toast-action">${escapeHtml(action.label)}</button>`).join("")}
    `;

    toast.querySelectorAll(".toast-action").forEach((btn, index) => {
        btn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            dismissToast(toast);
            const action = actions[index];
            if (action) action.onClick();
        });
    });

    if (sticky) {
        // Sticky toasts stay until clicked — they report something the user
        // must at least acknowledge.
        toast.addEventListener("click", () => dismissToast(toast));
    } else {
        startToastLifecycle(toast, duration);
    }
    container.appendChild(toast);
}

function startToastLifecycle(toast, duration) {
    toast._timer = setTimeout(() => dismissToast(toast), duration);
    // Click anywhere on the toast to dismiss it.
    toast.addEventListener("click", () => dismissToast(toast));
    // Reading time: hold the timer while the pointer hovers.
    toast.addEventListener("mouseenter", () => clearTimeout(toast._timer));
    toast.addEventListener("mouseleave", () => {
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => dismissToast(toast), 1200);
    });
}
