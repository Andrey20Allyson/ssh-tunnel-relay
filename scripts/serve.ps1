# serve.ps1 - deixa ESTE computador acessivel pelo relay (padrao: SSH na porta 22).
#
#   irm "https://SEU-RELAY/serve.ps1?id=casa" | iex
#   & ([scriptblock]::Create((irm https://SEU-RELAY/serve.ps1))) -Id casa -TargetPort 22
#
# O secret e pedido na tela, ou lido de $env:TUNNEL_SECRET.
& {
    param(
        [string]$Id = $env:TUNNEL_ID,
        [string]$Secret = $env:TUNNEL_SECRET,
        [string]$Relay = $env:TUNNEL_RELAY,
        [string]$TargetHost = '127.0.0.1',
        [int]$TargetPort = 22
    )

    $ErrorActionPreference = 'Stop'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    # valores preenchidos pelo relay ao servir o script
    $defRelay = '__RELAY_URL__'
    $defId = '__DEFAULT_ID__'

    if (-not $Relay) {
        if ($defRelay -notlike '__*') { $Relay = $defRelay } else { throw 'Informe -Relay https://seu-relay' }
    }
    if (-not $Id) {
        if ($defId -and $defId -notlike '__*') { $Id = $defId } else { $Id = $env:COMPUTERNAME.ToLower() }
    }
    if (-not $Secret) {
        $s = Read-Host 'Secret do relay' -AsSecureString
        $Secret = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
    }
    $Relay = $Relay.TrimEnd('/')
    $wsUrl = ($Relay -replace '^http', 'ws') + '/ws'

    # ---- servidor SSH local
    if ($TargetPort -eq 22 -and $TargetHost -in @('127.0.0.1', 'localhost')) {
        $svc = Get-Service sshd -ErrorAction SilentlyContinue
        if (-not $svc) {
            Write-Warning "OpenSSH Server nao esta instalado. Em um PowerShell como Administrador rode:`n  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0`n  Start-Service sshd; Set-Service sshd -StartupType Automatic"
        }
        elseif ($svc.Status -ne 'Running') {
            try { Start-Service sshd; Write-Host 'sshd iniciado.' }
            catch { Write-Warning 'O servico sshd esta parado. Rode como Administrador: Start-Service sshd' }
        }
    }

    # ---- nucleo do tunel (C#)
    if (-not ('SshTunnel.Tunnel' -as [type])) {
        $cs = @'
__TUNNEL_CS__
'@
        if ($cs.Trim() -eq ('__TUNNEL' + '_CS__')) { $cs = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'Tunnel.cs') }
        Add-Type -TypeDefinition $cs -IgnoreWarnings
    }

    function Show-TunnelLogs {
        $line = $null
        while ([SshTunnel.Tunnel]::Logs.TryDequeue([ref]$line)) { Write-Host $line }
    }

    Write-Host ''
    Write-Host "  Relay   : $Relay"
    Write-Host "  Id      : $Id"
    Write-Host "  Destino : ${TargetHost}:$TargetPort"
    Write-Host ''
    $connectQuery = "id=$Id&user=$([uri]::EscapeDataString($env:USERNAME))"
    Write-Host '  Para acessar a partir de outro computador:'
    Write-Host "    PowerShell : irm `"$Relay/connect.ps1?$connectQuery`" | iex" -ForegroundColor Cyan
    Write-Host "    cmd        : powershell -NoProfile -Command `"& ([scriptblock]::Create((irm '$Relay/connect.ps1?$connectQuery')))`"" -ForegroundColor Cyan
    Write-Host "    arquivo    : $Relay/connect.cmd?$connectQuery" -ForegroundColor Cyan
    Write-Host ''
    Write-Host '  Ctrl+C para encerrar.'
    Write-Host ''

    $task = [SshTunnel.Tunnel]::Serve($wsUrl, $Id, $Secret, $TargetHost, $TargetPort)
    try {
        while (-not $task.IsCompleted) {
            Show-TunnelLogs
            Start-Sleep -Milliseconds 300
        }
    }
    finally {
        [SshTunnel.Tunnel]::Stop()
        Start-Sleep -Milliseconds 300
        Show-TunnelLogs
        Write-Host 'Tunel encerrado.'
    }
} @args
