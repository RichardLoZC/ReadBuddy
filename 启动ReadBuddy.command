#!/bin/bash
# macOS 双击启动：ReadBuddy（独立窗口）
# 首次从 GitHub 下载若提示“无法验证开发者”，先在终端跑一次：xattr -d com.apple.quarantine 启动阅读器.command
cd "$(dirname "$0")" || exit 1

if ! command -v npm >/dev/null 2>&1; then
  echo "❌ 未检测到 Node.js（npm）。请先安装：https://nodejs.org/（建议 LTS 版）"
  echo "按任意键退出…"; read -n 1; exit 1
fi

if [ ! -x node_modules/.bin/electron ]; then
  echo "⏳ 首次运行，正在安装依赖（需要网络，约 1-3 分钟）…"
  npm install --no-audit --no-fund || { echo "❌ 依赖安装失败，请检查网络后重试"; read -n 1; exit 1; }
fi

exec npm run start
