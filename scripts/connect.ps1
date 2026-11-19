# connect.ps1 - acessa um computador que esta rodando serve.ps1.
#
#   irm "https://SEU-RELAY/connect.ps1?id=casa&user=SEU_USUARIO" | iex
#   & ([scriptblock]::Create((irm https://SEU-RELAY/connect.ps1))) -Id casa -User SEU_USUARIO
#
# Abre uma porta local (padrao 2222) que leva ao computador remoto e, se -User for
# informado, ja abre o ssh. Use -NoSsh para so deixar a porta aberta
# (ex.: para usar com scp, VS Code Remote-SSH, etc).
& {
    param(
        [string]$Id = $env:TUNNEL_ID,
        [string]$Secret = $env:TUNNEL_SECRET,
        [string]$Relay = $env:TUNNEL_RELAY,
        [string]$User = $env:TUNNEL_USER,
        [int]$LocalPort = 0,
        [switch]$NoSsh
    )

    $ErrorActionPreference = 'Stop'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    # valores preenchidos pelo relay ao servir o script
    $defRelay = '__RELAY_URL__'
    $defId = '__DEFAULT_ID__'
    $defUser = '__DEFAULT_USER__'
    $defPort = '__DEFAULT_PORT__'

    if (-not $Relay) {
        if ($defRelay -notlike '__*') { $Relay = $defRelay } else { throw 'Informe -Relay https://seu-relay' }
    }
    if (-not $Id -and $defId -and $defId -notlike '__*') { $Id = $defId }
    if (-not $Id) { $Id = Read-Host 'Id do computador que voce quer acessar' }
    if (-not $LocalPort) { if ($defPort -match '^\d+$') { $LocalPort = [int]$defPort } else { $LocalPort = 2222 } }
    if (-not $Secret) {
        $s = Read-Host 'Secret do relay' -AsSecureString
        $Secret = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
    }
    if (-not $NoSsh -and -not $User) {
        if ($defUser -and $defUser -notlike '__*') { $User = $defUser }
        else { $User = Read-Host 'Usuario no computador remoto (Enter = so abrir a porta local)' }
    }
    if ($User -and -not (Get-Command ssh -ErrorAction SilentlyContinue)) {
        Write-Warning 'Cliente ssh nao encontrado; abrindo apenas a porta local.'
        $User = ''
    }
    $Relay = $Relay.TrimEnd('/')
    $wsUrl = ($Relay -replace '^http', 'ws') + '/ws'

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

    $task = [SshTunnel.Tunnel]::Connect($wsUrl, $Id, $Secret, $LocalPort)
    try {
        Show-TunnelLogs
        if ($User -and -not $NoSsh) {
            Write-Host "Abrindo ssh $User@$Id ..." -ForegroundColor Cyan
            # HostKeyAlias: guarda a chave do host pelo id, nao por 127.0.0.1:porta
            & ssh -o "HostKeyAlias=$Id" -p $LocalPort "$User@127.0.0.1"
        }
        else {
            Write-Host ''
            Write-Host '  Porta local pronta. Em outro terminal:'
            Write-Host "    ssh -o HostKeyAlias=$Id -p $LocalPort USUARIO@127.0.0.1" -ForegroundColor Cyan
            Write-Host ''
            Write-Host '  Ctrl+C para encerrar.'
            Write-Host ''
            while (-not $task.IsCompleted) {
                Show-TunnelLogs
                Start-Sleep -Milliseconds 300
            }
        }
    }
    finally {
        [SshTunnel.Tunnel]::Stop()
        Start-Sleep -Milliseconds 300
        Show-TunnelLogs
    }
} @args
