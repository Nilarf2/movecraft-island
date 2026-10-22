@echo off
chcp 65001 >nul
title MoveCraft 体感荒岛
cd /d "%~dp0"

if not exist "runtime\python.exe" (
  echo.
  echo   [错误] 缺少 runtime 文件夹，游戏无法启动。
  echo   请把整个压缩包完整解压后再试，不要只复制部分文件。
  echo.
  pause
  exit /b 1
)

if not exist "web\index.html" (
  echo.
  echo   [错误] 缺少 web 文件夹，游戏无法启动。
  echo   请把整个压缩包完整解压后再试。
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动，请稍等几秒钟…
echo.
"runtime\python.exe" start_game.py
if errorlevel 1 (
  echo.
  echo   游戏异常退出，请把上面的提示截图反馈。
  echo.
  pause
)
