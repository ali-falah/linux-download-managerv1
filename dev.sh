#!/usr/bin/env bash
# Quick dev launcher for Linux Download Manager
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${REPO_DIR}"

NATIVE_HOST_NAME="com.eko.linuxdownloadmanager"
EXTENSION_ID="dhbkcopeagecbkoncdjefnjlcienhlpg"
NATIVE_HOST_BIN="${REPO_DIR}/target/debug/browser_native_host"
EXT_DIR="${HOME}/Documents/Linux Download Manager Extension"

# Terminate any running app instance (exact process name only to never affect terminal)
pkill -x linux-download-manager 2>/dev/null || true

# Build the native messaging host binary (needed for browser-extension communication)
echo "==> Building native host binary…"
cargo build --manifest-path src-tauri/Cargo.toml --bin browser_native_host

# Install native messaging host manifest pointing to the debug binary.
# This overwrites any release manifest from install.sh — re-run install.sh
# to restore the production manifest.
echo "==> Installing native messaging host manifest (dev)…"
DEV_HOST_PAYLOAD=$(cat <<EOF
{
  "name": "${NATIVE_HOST_NAME}",
  "description": "Native messaging bridge for Linux Download Manager (dev)",
  "path": "${NATIVE_HOST_BIN}",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://${EXTENSION_ID}/"]
}
EOF
)

for browser_root in \
  "${HOME}/.config/google-chrome/NativeMessagingHosts" \
  "${HOME}/.config/chromium/NativeMessagingHosts" \
  "${HOME}/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts" \
  "${HOME}/.config/microsoft-edge-dev/NativeMessagingHosts" \
  "${HOME}/.config/microsoft-edge/NativeMessagingHosts" \
  "${HOME}/.config/vivaldi/NativeMessagingHosts"; do
  parent="$(dirname "${browser_root}")"
  if [[ -d "${parent}" ]]; then
    mkdir -p "${browser_root}"
    echo "${DEV_HOST_PAYLOAD}" > "${browser_root}/${NATIVE_HOST_NAME}.json"
  fi
done

# Sync browser extension files (exclude native-host-manifest.json template)
echo "==> Syncing browser extension → ${EXT_DIR}"
mkdir -p "${EXT_DIR}"
for file in manifest.json service-worker.js content-script.js content-style.css player-manifest-observer.js; do
  cp "browser/chromium/${file}" "${EXT_DIR}/" 2>/dev/null || true
done

echo "==> Starting Linux Download Manager in Development Mode…"
cargo run --manifest-path src-tauri/Cargo.toml "$@"


# Sync browser extension files to ~/Documents/Linux Download Manager Extension
mkdir -p "$HOME/Documents/Linux Download Manager Extension"
cp -r browser/chromium/* "$HOME/Documents/Linux Download Manager Extension/"