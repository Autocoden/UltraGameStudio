@echo off
setlocal enabledelayedexpansion
title UltraGameStudio Runner
cd /d "%~dp0"

set "EXE=app\src-tauri\target\release\UltraGameStudio.exe"
set "EXIT_CODE=1"
set "MODE=auto"
if /I "%~1"=="/run"   set "MODE=run"
if /I "%~1"=="/build" set "MODE=build"

echo ============================================================
echo   UltraGameStudio Runner
echo ============================================================
echo   run.bat          full rebuild (Rust + frontend), then launch
echo   run.bat /run     launch existing exe only (skip build)
echo   run.bat /build   full rebuild only, do not launch
echo ============================================================
echo.

REM default and /build always rebuild; only /run skips the build
set "NEED_BUILD=1"
if "%MODE%"=="run" set "NEED_BUILD=0"
if "%MODE%"=="run" goto after_decide
if not exist "%EXE%" (
  echo [..] no exe yet - first build required.
) else (
  echo [..] full rebuild - compiling Rust + frontend.
)

:after_decide
if "%NEED_BUILD%"=="1" goto do_build
goto do_launch

:do_build
where node >nul 2>nul || goto no_node
node -e "const [maj,min]=process.versions.node.split('.').map(Number); process.exit((maj===20&&min>=19)||maj>22||(maj===22&&min>=12)?0:1)" >nul 2>nul || goto bad_node
where cargo >nul 2>nul || goto no_cargo
call :ensure_windows_rc
if errorlevel 1 goto no_rc
set "RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc"
echo [..] checking dependencies ...
pushd app
call npm install
set "CMD_RC=!errorlevel!"
popd
if not "!CMD_RC!"=="0" goto npm_fail
:have_deps
if exist "%EXE%" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "app\scripts\stop-ultragamestudio-instances.ps1"
  if errorlevel 1 goto stop_exe_fail
)
echo.
if "%MODE%"=="build" goto do_build_full
goto do_build_exe

:do_build_full
echo [..] building full installer (NSIS) ...
echo ============================================================
pushd app
call npm run package
set "CMD_RC=!errorlevel!"
popd
goto build_result

:do_build_exe
echo [..] building runnable exe only (skip NSIS installer) ...
echo ============================================================
pushd app
call npm run cli:build
set "CMD_RC=!errorlevel!"
popd
if not "!CMD_RC!"=="0" goto build_fail
pushd app
call npm run tauri -- build --no-bundle
set "CMD_RC=!errorlevel!"
popd

:build_result
if not "!CMD_RC!"=="0" goto build_fail
echo [OK] build done: %EXE%
if "%MODE%"=="build" goto build_only_done

:do_launch
if not exist "%EXE%" goto no_exe
powershell -NoProfile -ExecutionPolicy Bypass -File "app\scripts\stop-ultragamestudio-instances.ps1"
if errorlevel 1 goto stop_exe_fail
echo.
echo [..] launching UltraGameStudio ...
start "" "%EXE%"
echo [OK] launched an independent window. You can close this console.
echo      (self-test tip: point the in-app workspace to a project COPY.)
powershell -NoProfile -Command "Start-Sleep -Seconds 3" >nul
set "EXIT_CODE=0"
goto end

:build_only_done
echo.
echo [OK] build complete (not launched).
set "EXIT_CODE=0"
goto pause_end

:ensure_windows_rc
where rc >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%R in ('where rc 2^>nul') do (
    echo [OK] Windows resource compiler: %%R
    exit /b 0
  )
)
set "RC="
for /f "delims=" %%R in ('powershell -NoProfile -ExecutionPolicy Bypass -File "app\scripts\find-windows-rc.ps1" x64 2^>nul') do set "RC=%%R"
if not defined RC exit /b 1
for %%D in ("!RC!") do set "PATH=%%~dpD;!PATH!"
echo [OK] Windows resource compiler: !RC!
exit /b 0

:no_node
echo [X] Node.js 20.19+ or 22.12+ not found: https://nodejs.org
goto pause_end
:bad_node
for /f "delims=" %%v in ('node -v') do echo [X] Node.js %%v is unsupported. Install Node.js 20.19+ or 22.12+.
goto pause_end
:no_cargo
echo [X] Rust/cargo not found: https://rustup.rs
goto pause_end
:no_rc
echo [X] Windows SDK resource compiler rc.exe not found.
echo     Install "Windows SDK" or Visual Studio Build Tools with "Desktop development with C++".
goto pause_end
:npm_fail
echo [X] npm install failed.
goto pause_end
:build_fail
echo [X] build failed - see errors above.
goto pause_end
:stop_exe_fail
echo [X] failed to close running exe before rebuild.
goto pause_end
:no_exe
echo [X] exe not found: %EXE%
goto pause_end

:pause_end
pause
:end
endlocal & exit /b %EXIT_CODE%
