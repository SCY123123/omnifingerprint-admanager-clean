# Deploy frontend to BT panel (served at your production domain)
#   usage:
#     $env:DEPLOY_SSH_HOST      = 'user@your-server-ip'        (required)
#     $env:DEPLOY_REMOTE_ROOT   = '/www/wwwroot/your-site'     (required)
#     $env:DEPLOY_SSH_KEY       = 'C:\path\to\deploy_key'      (optional, default ssh-keys\deploy_key)
#     npm run deploy:bt
#
# Flow: pack dist -> scp -> extract into $DEPLOY_REMOTE_ROOT/web
#       (previous web dir is kept as web.bak-prev for rollback)
#
# NOTE: keep this file ASCII-only. PowerShell 5.1 reads .ps1 as ANSI when there is
#       no BOM, so non-ASCII text would be mangled and break the parser.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$SshKey = $env:DEPLOY_SSH_KEY
if (-not $SshKey) { $SshKey = Join-Path $root 'ssh-keys\deploy_key' }
# The private key may live in the user profile instead of the repo (repo no longer keeps it).
if (-not (Test-Path $SshKey)) {
    $altKey = Join-Path $env:USERPROFILE '.ssh\deploy_key'
    if (Test-Path $altKey) { $SshKey = $altKey }
}
$SshHost = $env:DEPLOY_SSH_HOST
$RemoteRoot = $env:DEPLOY_REMOTE_ROOT
$TarName = 'dist-web.tar.gz'

if (-not $SshHost)    { throw "DEPLOY_SSH_HOST not set (e.g. 'user@your-server-ip')" }
if (-not $RemoteRoot) { throw "DEPLOY_REMOTE_ROOT not set (e.g. '/www/wwwroot/your-site')" }
if (-not (Test-Path $SshKey)) { throw "SSH key not found: $SshKey" }
if (-not (Test-Path 'dist\index.html')) { throw 'dist/index.html not found - run npm run build first' }

Write-Host '[1/3] packing dist ...' -ForegroundColor Cyan
Remove-Item -Force $TarName -ErrorAction SilentlyContinue
tar -czf $TarName -C dist .
if ($LASTEXITCODE -ne 0) { throw 'tar failed' }
Write-Host ('      ' + [Math]::Round((Get-Item $TarName).Length / 1MB, 2) + ' MB')

Write-Host '[2/3] uploading ...' -ForegroundColor Cyan
# Timeout flags are mandatory here: this scp has hung indefinitely before (server reachable,
# plain ssh worked fine, but the scp data channel never moved). scp has NO default timeout,
# so a stuck transfer used to hang the whole deploy forever with no output.
#   ConnectTimeout   -> give up if the TCP/SSH handshake takes > 20s
#   ServerAlive*     -> abort in ~45s when the peer stops responding mid-transfer
scp -i $SshKey -o StrictHostKeyChecking=no -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=3 $TarName "${SshHost}:/tmp/$TarName"
if ($LASTEXITCODE -ne 0) { throw 'scp failed (check network / ssh key)' }

Write-Host '[3/3] deploying on server ...' -ForegroundColor Cyan
$remoteCmd = "cd $RemoteRoot && rm -rf web.bak-prev && if [ -d web ]; then mv web web.bak-prev; fi && mkdir -p web && tar -xzf /tmp/dist-web.tar.gz -C web && chown -R www:www web && rm -f /tmp/dist-web.tar.gz && echo DEPLOYED_OK"
$out = ssh -i $SshKey -o StrictHostKeyChecking=no -o ConnectTimeout=25 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 $SshHost $remoteCmd
if ($LASTEXITCODE -ne 0 -or ($out -notmatch 'DEPLOYED_OK')) { throw "remote deploy failed: $out" }

Remove-Item -Force $TarName -ErrorAction SilentlyContinue
Write-Host ''
Write-Host 'Done. Deployed to your server.' -ForegroundColor Green
