@echo off
chcp 65001 >nul
title MoveCraft 大屏模式
cd /d "%~dp0"

if not exist "runtime\python.exe" (
  echo.
  echo   [错误] 缺少 runtime 文件夹，程序无法启动。
  echo   请把整个压缩包完整解压后再试，不要只复制部分文件。
  echo.
  pause
  exit /b 1
)

if not exist "web\stage.html" (
  echo.
  echo   [错误] 缺少 web\stage.html，大屏模式无法启动。
  echo   请把整个压缩包完整解压后再试。
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动大屏模式，请稍等几秒钟…
echo.
"runtime\python.exe" start_game.py --path /stage.html
if errorlevel 1 (
  echo.
  echo   大屏模式异常退出，请把上面的提示截图反馈。
  echo.
  pause
)
