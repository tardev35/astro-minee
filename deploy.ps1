param (
    [Parameter(Mandatory=$true, HelpMessage="Enter your domain name (e.g., finnbet-vip.com)")]
    [string]$Domain
)

# 1. Server Config
$VPS_IP = "45.32.122.181"  
$VPS_USER = "root"

# 2. Cloudflare Config
$CF_ZONE_ID = "YOUR_ZONE_ID_HERE"
$CF_API_TOKEN = "YOUR_API_TOKEN_HERE"

Write-Host "========================================" -ForegroundColor Magenta
Write-Host "ULTIMATE DEPLOYMENT: $Domain" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Magenta

# --- Step 1: Build ---
Write-Host "`n[1/4] Building Astro project..." -ForegroundColor Cyan
npx astro build --force

if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: Build failed! Please check your code." -ForegroundColor Red
    exit
}

# --- Step 2: Compress ---
Write-Host "`n[2/4] Compressing files for hyper-speed upload..." -ForegroundColor Cyan
if (Test-Path "dist.tar.gz") { Remove-Item "dist.tar.gz" }
tar -czf dist.tar.gz -C dist .

# --- Step 3: Upload & Configure ---
Write-Host "`n[3/4] Uploading & Configuring Server..." -ForegroundColor Cyan
scp dist.tar.gz "${VPS_USER}@${VPS_IP}:/var/www/${Domain}/"

if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: Upload failed! Check your connection." -ForegroundColor Red
    Remove-Item "dist.tar.gz"
    exit
}

# Single-line SSH command to avoid parsing errors
$sshCommand = "rm -rf /var/www/${Domain}/dist/* && tar -xzf /var/www/${Domain}/dist.tar.gz -C /var/www/${Domain}/dist/ && rm /var/www/${Domain}/dist.tar.gz && chown -R www-data:www-data /var/www/${Domain} && chmod -R 755 /var/www/${Domain}"

ssh "${VPS_USER}@${VPS_IP}" $sshCommand

Remove-Item "dist.tar.gz"
Write-Host "  -> Files updated and permissions fixed!" -ForegroundColor Green

# --- Step 4: Clean Cloudflare Cache ---
Write-Host "`n[4/4] Cleaning Cloudflare Cache..." -ForegroundColor Cyan

if ($CF_ZONE_ID -eq "YOUR_ZONE_ID_HERE" -or $CF_API_TOKEN -eq "YOUR_API_TOKEN_HERE") {
    Write-Host "  -> CF Keys not set. (Please purge Cloudflare cache manually)" -ForegroundColor DarkYellow
} else {
    $headers = @{
        "Authorization" = "Bearer $CF_API_TOKEN"
        "Content-Type"  = "application/json"
    }
    $body = '{"purge_everything":true}'
    $apiUrl = "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/purge_cache"

    try {
        $response = Invoke-RestMethod -Uri $apiUrl -Method POST -Headers $headers -Body $body
        if ($response.success) {
            Write-Host "  -> Cloudflare cache purged successfully!" -ForegroundColor Green
        } else {
            Write-Host "  -> Cache purge failed." -ForegroundColor Yellow
        }
    } catch {
        Write-Host "  -> Error: Cache purge failed - $_" -ForegroundColor Red
    }
}

Write-Host "`nDEPLOYMENT COMPLETE! Your site is live and blazing fast." -ForegroundColor Magenta
Write-Host "========================================" -ForegroundColor Magenta