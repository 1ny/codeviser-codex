$ErrorActionPreference = 'Stop'

$node = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
if (-not $node) {
    $directCandidates = @(
        (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\runtimes\node\node.exe')
    )
    $node = $directCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

if (-not $node) {
    $searchRoots = @(
        (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\runtimes'),
        (Join-Path $env:USERPROFILE '.cache\codex-runtimes')
    ) | Where-Object { Test-Path -LiteralPath $_ }
    foreach ($root in $searchRoots) {
        $node = Get-ChildItem -LiteralPath $root -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1 -ExpandProperty FullName
        if ($node) { break }
    }
}

if (-not $node) {
    [Console]::Error.WriteLine('Node.js was not found. Install Node.js or reinstall Codex Desktop.')
    exit 9009
}

& $node (Join-Path $PSScriptRoot 'server.mjs')
exit $LASTEXITCODE
