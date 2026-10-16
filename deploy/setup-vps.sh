#!/usr/bin/env bash
set -e

# ==============================================================================
# setup-vps.sh - Production setup script for myMusicAnywhere
# ==============================================================================

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

echo "Starting myMusicAnywhere setup in $APP_DIR..."

# 1. Check ffmpeg
if ! command -v ffmpeg &> /dev/null; then
  echo "Warning: ffmpeg not found in PATH. Ensure ffmpeg is installed for audio processing."
fi

# 2. Install Node.js dependencies
echo "Installing Node.js dependencies..."
npm install --production=false

# 3. Build Next.js production bundle
echo "Building Next.js application..."
npm run build

# 4. Start or reload with PM2
echo "Starting application with PM2..."
pm2 startOrReload ecosystem.config.cjs
pm2 save

echo "Deployment complete. Check status with: pm2 status mymusicanywhere"
