#!/usr/bin/env bash
# 仅供开发/CI 在无显示环境下运行并演示应用（工程验证级）。
# 教师正式使用不需要该脚本，也不涉及 Xvfb 或命令行。
set -u
DISPLAY_NUM="${DISPLAY_NUM:-99}"
GEOM="${GEOM:-1280x900x24}"

pkill -f "Xvfb :${DISPLAY_NUM}" 2>/dev/null || true
sleep 1
Xvfb ":${DISPLAY_NUM}" -screen 0 "${GEOM}" -nolisten tcp >/tmp/xvfb.log 2>&1 &
sleep 2
export DISPLAY=":${DISPLAY_NUM}"
export YUWENDESK_DEV_ALLOW_PLATFORM=1
cd "$(dirname "$0")/../apps/desktop"
exec npx electron . --no-sandbox --disable-gpu
