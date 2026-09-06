@echo off
chcp 65001 >nul
rem Windows 双击启动：ReadBuddy（独立窗口）
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo ❌ 未检测到 Node.js（npm）。请先安装：https://nodejs.org/（建议 LTS 版）
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo ⏳ 首次运行，正在安装依赖（需要网络，约 1-3 分钟）…
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo ❌ 依赖安装失败，请检查网络后重试
    pause
    exit /b 1
  )
)

call npm run start
