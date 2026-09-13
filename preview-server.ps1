param(
    [int]$Port = 8000
)

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '.'))
$rootWithSeparator = $root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$listener = $null

$contentTypes = @{
    '.css' = 'text/css; charset=utf-8'
    '.html' = 'text/html; charset=utf-8'
    '.js' = 'text/javascript; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.svg' = 'image/svg+xml'
}

function Write-Response($stream, [int]$statusCode, [string]$reason, [string]$contentType, [byte[]]$body, [string]$method) {
    $header = "HTTP/1.1 $statusCode $reason`r`nContent-Type: $contentType`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
    $headerBytes = [Text.Encoding]::ASCII.GetBytes($header)
    $stream.Write($headerBytes, 0, $headerBytes.Length)
    if ($method -ne 'HEAD' -and $body.Length -gt 0) {
        $stream.Write($body, 0, $body.Length)
    }
}

try {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::IPv6Any, $Port)
    $listener.Server.SetSocketOption(
        [Net.Sockets.SocketOptionLevel]::IPv6,
        [Net.Sockets.SocketOptionName]::IPv6Only,
        $false
    )
    $listener.Start()

    $url = "http://localhost:$Port/"
    Write-Host "BIFROST preview running at $url"
    Start-Process $url
    Write-Host 'Press Ctrl+C to stop the server.'

    while ($true) {
        $client = $listener.AcceptTcpClient()
        $stream = $null
        try {
            $stream = $client.GetStream()
            $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::ASCII, $false, 4096, $true)
            $requestLine = $reader.ReadLine()
            while (($line = $reader.ReadLine()) -and $line -ne '') { }

            if (-not $requestLine) { continue }
            $requestParts = $requestLine.Split(' ')
            $method = $requestParts[0]
            $target = $requestParts[1]
            if ($method -notin @('GET', 'HEAD')) {
                Write-Response $stream 405 'Method Not Allowed' 'text/plain; charset=utf-8' ([Text.Encoding]::UTF8.GetBytes('Method Not Allowed')) $method
                continue
            }

            $path = [Uri]::UnescapeDataString(([Uri]::new("http://localhost$target")).AbsolutePath)
            if ($path -eq '/') { $path = '/index.html' }
            $relativePath = $path.TrimStart('/').Replace('/', [IO.Path]::DirectorySeparatorChar)
            $filePath = [IO.Path]::GetFullPath((Join-Path $root $relativePath))
            if ($filePath -ne $root -and -not $filePath.StartsWith($rootWithSeparator, [StringComparison]::OrdinalIgnoreCase)) {
                Write-Response $stream 403 'Forbidden' 'text/plain; charset=utf-8' ([Text.Encoding]::UTF8.GetBytes('Forbidden')) $method
                continue
            }

            if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
                Write-Response $stream 404 'Not Found' 'text/plain; charset=utf-8' ([Text.Encoding]::UTF8.GetBytes('Not Found')) $method
                continue
            }

            $extension = [IO.Path]::GetExtension($filePath).ToLowerInvariant()
            $contentType = $contentTypes[$extension]
            if (-not $contentType) { $contentType = 'application/octet-stream' }
            Write-Response $stream 200 'OK' $contentType ([IO.File]::ReadAllBytes($filePath)) $method
        } catch {
            # Close the connection if a client disconnects during a request.
        } finally {
            if ($stream) { $stream.Dispose() }
            $client.Dispose()
        }
    }
} catch {
    Write-Error "无法启动本地预览服务：$($_.Exception.Message)"
    exit 1
} finally {
    if ($listener) {
        $listener.Stop()
    }
}
