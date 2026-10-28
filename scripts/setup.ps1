# One-time setup (needs internet). After this everything runs offline.
# Downloads llama.cpp (Vulkan build: uses AMD/Intel/NVIDIA GPUs, falls back to CPU)
# plus Gemma 4 E4B weights and its vision projector for image input.
param(
    [string]$LlamaBuild = "b11960",
    [string]$ModelRepo  = "unsloth/gemma-4-E4B-it-GGUF",
    [string]$ModelFile  = "gemma-4-E4B-it-Q4_K_M.gguf",
    [string]$MmprojFile = "mmproj-F16.gguf"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is very slow with the progress bar
$root = Split-Path $PSScriptRoot -Parent

$binDir = Join-Path $root "bin\llama.cpp"
if (-not (Test-Path (Join-Path $binDir "llama-server.exe"))) {
    $zip = Join-Path $env:TEMP "llama-$LlamaBuild-win-vulkan-x64.zip"
    $url = "https://github.com/ggml-org/llama.cpp/releases/download/$LlamaBuild/llama-$LlamaBuild-bin-win-vulkan-x64.zip"
    Write-Host "Downloading llama.cpp $LlamaBuild ..."
    Invoke-WebRequest $url -OutFile $zip
    New-Item -ItemType Directory -Force $binDir | Out-Null
    Expand-Archive $zip -DestinationPath $binDir -Force
    Remove-Item $zip
}

$modelDir = Join-Path $root "models"
New-Item -ItemType Directory -Force $modelDir | Out-Null
foreach ($file in @($ModelFile, $MmprojFile)) {
    $path = Join-Path $modelDir $file
    if (Test-Path $path) { continue }
    Write-Host "Downloading $ModelRepo/$file ..."
    # curl.exe ships with Windows and resumes partial downloads with -C -
    curl.exe -L -C - --fail -o "$path.part" "https://huggingface.co/$ModelRepo/resolve/main/$file"
    if ($LASTEXITCODE -ne 0) { throw "Download of $file failed" }
    Move-Item "$path.part" $path
}

Write-Host "Installing tikz-service dependencies ..."
Push-Location (Join-Path $root "tikz-service")
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "npm ci failed (is Node.js installed?)" }
Pop-Location

Write-Host "Done. Run scripts\start.ps1 and open http://127.0.0.1:8080"
