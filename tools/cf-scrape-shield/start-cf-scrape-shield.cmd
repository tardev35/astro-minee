@echo off
REM Double-click to open the Cloudflare Scrape Shield tool.
REM Turns OFF Email Address Obfuscation, which is what injects the
REM render-blocking /cdn-cgi/scripts/.../email-decode.min.js into a page.
REM No .env needed - paste the API token into the page itself.
cd /d "%~dp0..\.."
echo Starting Cloudflare Scrape Shield...
echo   -^> http://localhost:9898   (Ctrl+C in this window to stop)
start "" http://localhost:9898
node tools/cf-scrape-shield/server.mjs
echo.
echo Server stopped. Press any key to close.
pause >nul
