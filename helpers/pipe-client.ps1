# Protected named-pipe client for the CLI. Mirrors the client rules in poppykit-demo docs/protected-channel.md.
# Opens the pipe at Identification impersonation level and, via CurrentUserOnly, requires the server end to be owned
# by the current user (Node's net.connect can do neither). stdin: the request frame (ends in LF).
# stdout: the response frame, only when complete (ends in LF). Exit codes:
#   0 complete response   10 could not connect (nothing sent)   11 server not owned by current user / access denied (nothing sent)
#   12 failure after the request was written (outcome uncertain)   13 response over the frame limit
param(
  [Parameter(Mandatory)][string]$Name,
  [Parameter(Mandatory)][int]$ConnectMs,
  [Parameter(Mandatory)][int]$RequestMs
)
$ErrorActionPreference = 'Stop'
$max = 8MB
function Fail([int]$code, [string]$text) { [Console]::Error.WriteLine("pipe-client: $text"); exit $code }

$ms = [IO.MemoryStream]::new()
[Console]::OpenStandardInput().CopyTo($ms)
$request = $ms.ToArray()

$client = [IO.Pipes.NamedPipeClientStream]::new('.', $Name, [IO.Pipes.PipeDirection]::InOut,
  [IO.Pipes.PipeOptions]'CurrentUserOnly, Asynchronous', [Security.Principal.TokenImpersonationLevel]::Identification)
try { $client.Connect($ConnectMs) }
catch [UnauthorizedAccessException] { Fail 11 'server owner not trusted' }
catch { Fail 10 'connect failed' }

$cts = [Threading.CancellationTokenSource]::new($RequestMs)
try {
  [void]$client.WriteAsync($request, 0, $request.Length, $cts.Token).GetAwaiter().GetResult()
  [void]$client.FlushAsync($cts.Token).GetAwaiter().GetResult()
  $response = [IO.MemoryStream]::new()
  $chunk = [byte[]]::new(65536)
  $complete = $false
  while (-not $complete) {
    $n = $client.ReadAsync($chunk, 0, $chunk.Length, $cts.Token).GetAwaiter().GetResult()
    if ($n -eq 0) { break }
    $lf = [Array]::IndexOf($chunk, [byte]10, 0, $n)
    if ($lf -ge 0 -and $lf -ne $n - 1) { Fail 12 "bytes after LF" }
    $take = $n
    if ($response.Length + $take -gt $max) { Fail 13 'response too large' }
    $response.Write($chunk, 0, $take)
    $complete = $lf -ge 0
  }
} catch { Fail 12 'transport failed after send' }
finally { $client.Dispose() }
if (-not $complete) { Fail 12 'response ended before LF' }
$out = [Console]::OpenStandardOutput()
$response.WriteTo($out)
$out.Flush()
exit 0
