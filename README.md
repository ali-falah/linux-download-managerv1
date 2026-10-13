# Linux Download Manager

A high-performance, full-featured download manager for Linux built with Rust and Tauri. Designed as a modern, native alternative to Internet Download Manager (IDM) with native browser integration and intelligent media capture.

## Key Features

- **Multi-Part Accelerated Downloads**: Splits files into multi-threaded concurrent chunks using HTTP range requests for maximum network throughput.
- **Robust Pause & Resume**: Safely pause, resume, and recover interrupted downloads without restarting from zero.
- **Light & Dark Themes**:
  - **Low-Glare Paper Light Theme**: Soft, warm off-white tones specifically designed for eye-comfort and light sensitivity.
  - **Modern Dark Theme**: Clean, low-contrast dark interface for low-light environments.
  - **System Theme Sync**: Automatically adapts to your desktop environment's color scheme with persistent user preferences.
- **Browser Extension Integration**:
  - One-click downloads directly from Chromium-based browsers (Google Chrome, Brave, Chromium, Microsoft Edge, Vivaldi).
  - Native messaging bridge communicating directly with the desktop engine.
- **Video & Media Sniffing**:
  - Downloads video and audio from YouTube, Twitter/X, Reddit, TikTok, and other platforms via `yt-dlp` and `ffmpeg`.
  - Floating in-page media download button for instant media detection.
- **Bandwidth Management & Queueing**:
  - Configurable global and per-download speed limits (KB/s).
  - Maximum concurrent active downloads queue with automatic job scheduling.
- **Integrity Verification**: Checksum validation supporting MD5, SHA-1, and SHA-256.
- **Desktop Integration**: Native notifications, system tray icon, and `.desktop` application menu launcher.

## Requirements

The application runs on modern Linux distributions (Arch Linux / CachyOS, Ubuntu / Debian, Fedora).

### Build & Runtime Dependencies

- **Rust & Cargo** (1.75+)
- **WebKit2GTK** (`webkit2gtk-4.1`)
- **GTK 3** (`gtk+-3.0`)
- **libsoup 3** (`libsoup-3.0`)
- **yt-dlp** (for social media and video stream downloading)
- **ffmpeg** (for video and audio stream muxing)
- **Node.js** or **Deno** (used by `yt-dlp` for modern stream signature extraction)

## Installation

Run the automated installer from the repository root:

```bash
./install.sh
```

The installer will:
1. Compile the optimized release binary.
2. Install the executable to `~/.local/bin/linux-download-manager`.
3. Set up the background native host bridge in `~/.local/share/linux-download-manager/bin/`.
4. Register the desktop launcher in `~/.local/share/applications/`.
5. Prepare the browser extension in `~/Documents/Linux Download Manager Extension`.
6. Configure native messaging manifests for installed Chromium browsers.

### Running the App

- **From App Menu**: Search for **Linux Download Manager** in your desktop application launcher.
- **From Terminal**:
  ```bash
  linux-download-manager
  ```

## Browser Extension Setup

To enable browser download interception and video detection:

1. Open your browser's extensions page (`chrome://extensions` or `brave://extensions`).
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select the folder:
   ```
   ~/Documents/Linux Download Manager Extension
   ```
5. Pin the extension to your toolbar for easy access.

## Development

To run the application locally in development mode with live inspection:

```bash
./dev.sh
```

## Uninstallation

To remove the application, desktop entry, and native messaging configuration:

```bash
./uninstall.sh
```
