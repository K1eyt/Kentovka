# Скачивает портативный Node.js (LTS) с официального nodejs.org в папку .\node
# Ничего не устанавливает в систему, права администратора не нужны.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'   # иначе скачивание в PowerShell 5 очень медленное

$root = $PSScriptRoot
$dest = Join-Path $root 'node'
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }

Write-Host 'Ищу последнюю LTS-версию Node.js на nodejs.org...'
$index = Invoke-RestMethod -UseBasicParsing 'https://nodejs.org/dist/index.json'
$lts = $index | Where-Object { $_.lts -and ($_.files -contains "win-$arch-zip") } | Select-Object -First 1
if (-not $lts) { throw 'Не нашёл LTS-версию Node.js' }
$ver = $lts.version
$name = "node-$ver-win-$arch"
$url = "https://nodejs.org/dist/$ver/$name.zip"
$zip = Join-Path $env:TEMP "$name.zip"

Write-Host "Качаю Node.js $ver (~30 МБ)..."
Invoke-WebRequest -UseBasicParsing $url -OutFile $zip

Write-Host 'Проверяю контрольную сумму...'
$sums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$ver/SHASUMS256.txt").Content
$expected = ($sums -split "`n" | Where-Object { $_ -match "\s$name\.zip$" }) -replace '\s.*$', ''
$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if (-not $expected -or $expected.Trim().ToLower() -ne $actual) {
  Remove-Item $zip -Force
  throw 'Контрольная сумма не совпала, файл повреждён. Запусти ещё раз.'
}

Write-Host 'Распаковываю...'
$tmp = Join-Path $root 'node-tmp'
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Expand-Archive $zip -DestinationPath $tmp
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
Move-Item (Join-Path $tmp $name) $dest
Remove-Item $tmp -Recurse -Force
Remove-Item $zip -Force
Write-Host "Готово: Node.js $ver лежит в папке node"
