$ErrorActionPreference = "Stop"
$DesktopRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $DesktopRoot
Set-Location -LiteralPath $DesktopRoot

if (-not (Test-Path -LiteralPath ".venv")) {
    py -3.10 -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw "가상 환경 생성에 실패했습니다. (종료 코드: $LASTEXITCODE)" }
}

& ".venv\Scripts\python.exe" -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "pip 업그레이드에 실패했습니다. (종료 코드: $LASTEXITCODE)" }
& ".venv\Scripts\python.exe" -m pip install -r requirements-dev.txt
if ($LASTEXITCODE -ne 0) { throw "의존성 설치에 실패했습니다. (종료 코드: $LASTEXITCODE)" }
& ".venv\Scripts\python.exe" -m pytest tests
if ($LASTEXITCODE -ne 0) { throw "테스트에 실패했습니다. (종료 코드: $LASTEXITCODE)" }
$NodeExe = (Get-Command node -ErrorAction Stop).Source
& ".venv\Scripts\pyinstaller.exe" `
    --noconfirm `
    --clean `
    --onefile `
    --windowed `
    --name "Image-Korean-Translator-ZIP" `
    --version-file "$DesktopRoot\version_info.txt" `
    --collect-all tkinterdnd2 `
    --add-binary "$NodeExe;runtime" `
    --add-data "$ProjectRoot\node_modules;node_modules" `
    --add-data "$ProjectRoot\bridge\server.js;bridge" `
    --add-data "$ProjectRoot\bridge\codex-exec-args.js;bridge" `
    --add-data "$ProjectRoot\bridge\codex-diagnostics.js;bridge" `
    --add-data "$ProjectRoot\bridge\codex-image-renderer.js;bridge" `
    --add-data "$ProjectRoot\bridge\image-renderer.js;bridge" `
    --add-data "$ProjectRoot\bridge\ocr-preprocessor.js;bridge" `
    --add-data "$ProjectRoot\bridge\ocr-results.js;bridge" `
    --add-data "$ProjectRoot\bridge\quality-prompts.js;bridge" `
    --add-data "$ProjectRoot\bridge\response-schema.json;bridge" `
    --add-data "$ProjectRoot\bridge\visual-qa-schema.json;bridge" `
    --add-data "$ProjectRoot\bridge\task-semaphore.js;bridge" `
    --add-data "$ProjectRoot\bridge\temp-cleanup.js;bridge" `
    main.py
if ($LASTEXITCODE -ne 0) { throw "실행 파일 빌드에 실패했습니다. (종료 코드: $LASTEXITCODE)" }

Write-Host "완료: $DesktopRoot\dist\Image-Korean-Translator-ZIP.exe"
