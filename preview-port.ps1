# Port probe for preview.cmd. Keeps "BIFROST is already running" apart from
# "some unrelated program owns this port", and reports the first free port.
# Prints one line and exits:
#   OPEN  <port>  a BIFROST preview server is already serving this port
#   START <port>  this port is free and can host the preview server
#   BUSY  <port>  the whole scanned range is owned by other programs

param(
    [int]$Preferred = 8000,
    [int]$Range = 10
)

$ErrorActionPreference = 'SilentlyContinue'

function Test-BifrostServer([int]$Port) {
    foreach ($address in @('127.0.0.1', '::1')) {
        $client = $null
        try {
            $client = New-Object Net.Sockets.TcpClient
            $async = $client.BeginConnect($address, $Port, $null, $null)
            if (-not $async.AsyncWaitHandle.WaitOne(600)) { continue }
            $client.EndConnect($async)

            $stream = $client.GetStream()
            $request = "GET /.bifrost-ping HTTP/1.0`r`nHost: localhost`r`nConnection: close`r`n`r`n"
            $bytes = [Text.Encoding]::ASCII.GetBytes($request)
            $stream.Write($bytes, 0, $bytes.Length)

            $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
            if ($reader.ReadToEnd().Contains('BIFROST_PREVIEW_OK')) {
                return $true
            }
        } catch {
            # Try the next loopback family.
        } finally {
            if ($client) { $client.Close() }
        }
    }

    return $false
}

function Test-PortFree([int]$Port) {
    foreach ($address in @([Net.IPAddress]::Loopback, [Net.IPAddress]::IPv6Loopback)) {
        $probe = $null
        try {
            $probe = [Net.Sockets.TcpListener]::new($address, $Port)
            try {
                $probe.Server.SetSocketOption(
                    [Net.Sockets.SocketOptionLevel]::IPv6,
                    [Net.Sockets.SocketOptionName]::IPv6Only,
                    $true
                )
            } catch {
                # Not an IPv6 socket; nothing to set.
            }
            $probe.Start()
        } catch {
            return $false
        } finally {
            if ($probe) { $probe.Stop() }
        }
    }

    return $true
}

for ($offset = 0; $offset -lt $Range; $offset++) {
    $port = $Preferred + $offset
    if (Test-BifrostServer $port) {
        Write-Output "OPEN $port"
        exit 0
    }
}

for ($offset = 0; $offset -lt $Range; $offset++) {
    $port = $Preferred + $offset
    if (Test-PortFree $port) {
        Write-Output "START $port"
        exit 0
    }
}

Write-Output "BUSY $Preferred"
exit 1
