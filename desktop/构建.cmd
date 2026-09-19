@echo off
setlocal
rem ============================================================================
rem  Build the portable app using ONLY the Node runtime bundled in this folder.
rem
rem  Why this exists: this bundle ships a complete Node runtime under
rem  build\runtime\node, so a machine that has never had Node.js or npm
rem  installed can still build the app. `npm run build` cannot do that -- it
rem  needs npm on PATH first. Everything npm does here is `node scripts\*.mjs`,
rem  which is exactly what this script runs.
rem
rem  No network access is needed: the runtime and the Electron distribution are
rem  already present, so prepare-runtime.mjs skips both downloads.
rem
rem  Usage: double-click this file, or run it from a command prompt.
rem ============================================================================

set "ROOT=%~dp0"
set "NODE=%ROOT%build\runtime\node\node.exe"

echo [bootstrap] root   %ROOT%
echo [bootstrap] node   %NODE%
echo.

if not exist "%NODE%" (
  echo [bootstrap] FAILED: the bundled Node runtime is missing.
  echo [bootstrap] Expected it at the path above. This bundle is incomplete, or
  echo [bootstrap] you are running the plain source snapshot ^(the src-*.tar.gz^)
  echo [bootstrap] rather than the self-contained bundle.
  echo [bootstrap] With a system Node.js installed you can use: npm run prepare:runtime
  exit /b 1
)

rem prepare-runtime.mjs is idempotent: with the runtime already assembled it
rem reports what it found and downloads nothing.
echo [bootstrap] step 1/2  preparing the runtime
"%NODE%" "%ROOT%scripts\prepare-runtime.mjs"
if errorlevel 1 goto :failed

echo.
echo [bootstrap] step 2/2  building the portable app
"%NODE%" "%ROOT%scripts\build.mjs"
if errorlevel 1 goto :failed

echo.
echo [bootstrap] done. The portable app is here:
echo                %ROOT%dist\DeepSeek Harness
echo [bootstrap] Double-click "DeepSeek Harness.exe" there to start it.
echo.
echo [bootstrap] To build the installer as well ^(needs NSIS, already bundled^):
echo                "%NODE%" "%ROOT%scripts\build-installer.mjs"
exit /b 0

:failed
rem Outside the parenthesised blocks above, so %ERRORLEVEL% is still current.
echo.
echo [bootstrap] FAILED with exit code %ERRORLEVEL%
exit /b %ERRORLEVEL%
