# Runs everything offline:
#   - tikz-service (TikZ -> SVG via TeX in WebAssembly) on http://127.0.0.1:3001
#   - llama-server: loads Gemma (text + vision) and serves the web UI on http://127.0.0.1:8080
# Open http://127.0.0.1:8080 once llama-server says it is listening. Ctrl+C stops both.
param(
    [string]$ModelFile  = "gemma-4-E4B-it-Q4_K_M.gguf",
    [string]$MmprojFile = "mmproj-F16.gguf",
    [int]$Port = 8080,
    [int]$TikzPort = 3001,
    [int]$Context = 8192,
    [int]$GpuLayers = 99   # set to 0 to force CPU only
)
$root = Split-Path $PSScriptRoot -Parent
$server = Get-ChildItem (Join-Path $root "bin\llama.cpp") -Recurse -Filter "llama-server.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $server) { throw "llama-server.exe not found - run scripts\setup.ps1 first (needs internet once)" }
$tikzDir = Join-Path $root "tikz-service"
if (-not (Test-Path (Join-Path $tikzDir "node_modules"))) { throw "tikz-service not installed - run scripts\setup.ps1 first" }

$env:PORT = $TikzPort
# Keep the TeX renderer alive: if it ever exits, restart it a second later instead of breaking the demo.
$tikzLoop = 'while ($true) { node src/server.js; Write-Host "tikz-service exited, restarting..."; Start-Sleep 1 }'
$tikz = Start-Process powershell -ArgumentList "-NoProfile", "-Command", $tikzLoop -WorkingDirectory $tikzDir -NoNewWindow -PassThru
try {
    & $server.FullName `
        -m (Join-Path $root "models\$ModelFile") `
        --mmproj (Join-Path $root "models\$MmprojFile") `
        --path (Join-Path $root "web") `
        --host 127.0.0.1 --port $Port `
        -c $Context -ngl $GpuLayers `
        --parallel 1 `
        --jinja
} finally {
    # /T also stops the node process the restart loop started
    if (-not $tikz.HasExited) { taskkill /PID $tikz.Id /T /F | Out-Null }
}
