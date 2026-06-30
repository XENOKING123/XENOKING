@echo off
REM ── XENO TOOL Web — Windows launcher ────────────────────────────────────
REM Runs the XENO TOOL web server on this PC. Open the printed URL from any
REM browser on your network (phone, laptop, tablet) — no install needed.

setlocal
set "PS5UPLOAD_WEB_MODE=1"
set "PS5UPLOAD_ENGINE_PORT=6969"
set "PS5UPLOAD_WEB_DIST=%~dp0dist"

echo.
echo   XENO TOOL Web
echo   =============
echo   Serving on port 6969.
echo   Open  http://YOUR-PC-IP:6969  from any browser on your network.
echo   (Find YOUR-PC-IP by running ^"ipconfig^" — look for IPv4 Address.)
echo.
echo   Press Ctrl+C to stop.
echo.

"%~dp0xeno-web-server.exe"
endlocal
