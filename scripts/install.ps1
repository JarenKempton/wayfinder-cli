[CmdletBinding()]
param(
    [string]$Version = $env:WAYFINDER_VERSION,
    [string]$InstallDir = $env:WAYFINDER_INSTALL_DIR,
    [string]$Repository = $env:WAYFINDER_REPOSITORY,
    [string]$BaseUrl = $env:WAYFINDER_BASE_URL
)

$ErrorActionPreference = 'Stop'
if (-not $Version) { $Version = 'latest' }
if (-not $Repository) { $Repository = 'JarenKempton/wayfinder-cli' }
if (-not $InstallDir) { $InstallDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\Wayfinder\bin' }

$architecture = if ($env:WAYFINDER_ARCH) { $env:WAYFINDER_ARCH } else { [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() }
switch ($architecture.ToLowerInvariant()) {
    { $_ -in 'x64', 'amd64', 'x86_64' } { $machine = 'x64'; break }
    { $_ -in 'arm64', 'aarch64' } { $machine = 'arm64'; break }
    default { throw "wayfinder: unsupported architecture: $architecture" }
}

$asset = "wayfinder-windows-$machine.exe"
if (-not $BaseUrl) {
    if ($Version -eq 'latest') {
        $BaseUrl = "https://github.com/$Repository/releases/latest/download"
    } else {
        $tag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
        $BaseUrl = "https://github.com/$Repository/releases/download/$tag"
    }
}
$BaseUrl = $BaseUrl.TrimEnd('/')

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$destination = Join-Path $InstallDir 'wayfinder.exe'
$temporary = Join-Path $InstallDir ('.wayfinder.' + [Guid]::NewGuid().ToString('N') + '.exe')
$backup = Join-Path $InstallDir ('.wayfinder-backup.' + [Guid]::NewGuid().ToString('N') + '.exe')
$checksums = Join-Path ([IO.Path]::GetTempPath()) ('wayfinder-checksums.' + [Guid]::NewGuid().ToString('N'))

try {
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$asset" -OutFile $temporary
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/checksums.txt" -OutFile $checksums
    $line = Get-Content -LiteralPath $checksums | Where-Object { $_ -match "^[0-9a-fA-F]{64}\s+\*?$([regex]::Escape($asset))$" } | Select-Object -First 1
    if (-not $line) { throw "wayfinder: checksums.txt has no entry for $asset" }
    $expected = ($line -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $temporary).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "wayfinder: checksum verification failed for $asset" }

    if (Test-Path -LiteralPath $destination) {
        try {
            [IO.File]::Replace($temporary, $destination, $backup)
            Remove-Item -LiteralPath $backup -Force
        } catch {
            if ((-not (Test-Path -LiteralPath $destination)) -and (Test-Path -LiteralPath $backup)) {
                Move-Item -LiteralPath $backup -Destination $destination
            }
            throw
        }
    } else {
        Move-Item -LiteralPath $temporary -Destination $destination
    }
} finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $checksums -Force -ErrorAction SilentlyContinue
}

Write-Host "Installed wayfinder to $destination"
$pathEntries = $env:PATH -split [IO.Path]::PathSeparator
if ($InstallDir -notin $pathEntries) {
    Write-Warning "$InstallDir is not on PATH. Add it to your user PATH, then open a new terminal."
}
