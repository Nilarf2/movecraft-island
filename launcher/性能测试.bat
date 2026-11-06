@echo off
chcp 65001 >nul
title MoveCraft 性能测试
cd /d "%~dp0"

if not exist "runtime\python.exe" (
  echo.
  echo   [错误] 缺少 runtime 文件夹，程序无法启动。
  echo   请把整个压缩包完整解压后再试，不要只复制部分文件。
  echo.
  pause
  exit /b 1
)

if not exist "web\perf-lab.html" (
  echo.
  echo   [错误] 缺少 web\perf-lab.html，性能测试无法启动。
  echo   请把整个压缩包完整解压后再试。
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动性能测试，请稍等几秒钟…
echo   浏览器打开后点「开始三档测试」，低、中、高各测 20 秒；默认不启用摄像头。
echo   测完点「复制报告」，把结果发回来。
echo.
"runtime\python.exe" start_game.py --path /perf-lab.html
if errorlevel 1 (
  echo.
  echo   性能测试异常退出，请把上面的提示截图反馈。
  echo.
  pause
)
