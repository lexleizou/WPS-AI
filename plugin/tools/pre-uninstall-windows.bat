@echo off
REM Inno Setup 卸载前调本脚本: 停服务 + 删 publish.xml + 删 ~/.lingxi-ai
setlocal

set "TARGET=%USERPROFILE%\.lingxi-ai"
set "PUBLISH=%APPDATA%\kingsoft\wps\jsaddons\publish.xml"

REM 1. 删 Run 键
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v LingxiAI >nul 2>&1
if not errorlevel 1 reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v LingxiAI /f >nul 2>&1

REM 2. 删旧版计划任务（兼容老安装）
schtasks /Query /TN "LingxiAI" >nul 2>&1
if not errorlevel 1 schtasks /Delete /TN "LingxiAI" /F >nul 2>&1

REM 3. 杀后台进程
taskkill /IM lingxi-launcher.exe /F >nul 2>&1
REM kill node/wrapper; filter aligned with post-install (also *lingxi-ai*), name list adds launcher
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0stop-lingxi-processes.ps1" -RootDir "%USERPROFILE%\.lingxi-ai" >nul 2>&1
timeout /t 2 /nobreak >nul 2>&1

REM 4. Fix W1: publish.xml is WPS's shared JS-addon manifest. Remove only the lingxi
REM    entries and keep other vendors' entries; deleting the whole file unregisters them all.
if not exist "%PUBLISH%" goto after_publish
set "OTHER_ENTRIES=%TEMP%\lingxi_other_addons_%RANDOM%.txt"
findstr /i "jspluginonline" "%PUBLISH%" | findstr /v /i "lingxi-ai" > "%OTHER_ENTRIES%" 2>nul
set "OTHER_SIZE=0"
for %%Z in ("%OTHER_ENTRIES%") do set "OTHER_SIZE=%%~zZ"
if "%OTHER_SIZE%"=="0" (
  del /F /Q "%PUBLISH%" >nul 2>&1
  goto publish_cleanup
)
(
  echo ^<?xml version="1.0" encoding="UTF-8" standalone="yes"?^>
  echo ^<jsplugins^>
  type "%OTHER_ENTRIES%"
  echo ^</jsplugins^>
) > "%PUBLISH%"
:publish_cleanup
del /F /Q "%OTHER_ENTRIES%" >nul 2>&1
:after_publish

REM 5. 删 ~/.lingxi-ai 用户数据
if exist "%TARGET%" rmdir /S /Q "%TARGET%"
if exist "%TARGET%" (
  timeout /t 1 /nobreak >nul 2>&1
  rmdir /S /Q "%TARGET%"
)
if exist "%TARGET%" (
  timeout /t 1 /nobreak >nul 2>&1
  rmdir /S /Q "%TARGET%"
)

endlocal
exit /b 0
