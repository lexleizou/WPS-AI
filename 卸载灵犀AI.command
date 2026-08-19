#!/usr/bin/env bash
set -euo pipefail
INSTALL_DIR="$HOME/Library/Application Support/LingxiAI"
UNINSTALLER="$INSTALL_DIR/plugin/tools/pre-uninstall-mac.sh"

echo "将卸载灵犀AI/WPS-AI，并保留 Sally 等其他 WPS 插件。"
read -r -p "输入 YES 继续：" answer
[ "$answer" = "YES" ] || { echo "已取消。"; exit 0; }

if [ -x "$UNINSTALLER" ]; then
  bash "$UNINSTALLER"
else
  echo "未找到官方卸载脚本：$UNINSTALLER" >&2
  exit 1
fi
rm -rf "$INSTALL_DIR"
echo "灵犀AI已卸载；历史安装前备份仍保留在 ~/.lingxi-ai-backups/。"
