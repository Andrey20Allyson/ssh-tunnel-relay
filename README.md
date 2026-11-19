# SSH Tunnel Relay

Acesse por SSH um computador Windows que está atrás de NAT/CGNAT (sem IP público e sem abrir portas no roteador), passando tudo por um relay HTTPS hospedado no Easypanel.

> Nos exemplos, troque `https://SEU-RELAY` pelo domínio do relay (ex.: `https://meu-relay.exemplo.easypanel.host`).
> A **página inicial do relay** gera todos esses comandos já preenchidos, com botão de copiar.

---

## Sumário

- [Como funciona](#como-funciona)
- [1. Subir o relay (Easypanel)](#1-subir-o-relay-easypanel)
- [2. Preparar o computador que será acessado](#2-preparar-o-computador-que-será-acessado)
- [3. Servir: no computador que será acessado](#3-servir-no-computador-que-será-acessado)
- [4. Conectar: no computador que vai acessar](#4-conectar-no-computador-que-vai-acessar)
- [O secret](#o-secret)
- [Parâmetros](#parâmetros)
- [Endpoints do relay](#endpoints-do-relay)
- [Protocolo](#protocolo)
- [Segurança](#segurança)
- [Problemas comuns](#problemas-comuns)
- [Rodar localmente (desenvolvimento)](#rodar-localmente-desenvolvimento)

---

## Como funciona

```
[quem acessa]                                   [relay]                                 [computador acessado]
ssh -> 127.0.0.1:2222 -> connect.ps1  ==HTTPS/WebSocket==>  <==HTTPS/WebSocket==  serve.ps1 -> 127.0.0.1:22 (sshd)
```

- O **relay** (este projeto, Node.js) roda em Docker e só precisa da porta **80**. O Easypanel coloca HTTPS na frente pelo domínio dele.
- O computador acessado roda **`serve.ps1`**, que abre uma conexão de **saída** até o relay e fica esperando.
- Quem quer acessar roda **`connect.ps1`**, que abre uma porta local (`127.0.0.1:2222`) e, opcionalmente, já chama o `ssh`.
- O relay junta as duas pontas pelo **id** (ex.: `casa`) e só repassa bytes. O SSH continua criptografado de ponta a ponta.

Como os dois lados só fazem conexões de saída via HTTPS, funciona atrás de NAT, CGNAT, Wi-Fi público e a maioria dos firewalls.

---

## 1. Subir o relay (Easypanel)

1. Crie um serviço do tipo **App** (ou reaproveite um existente).
2. **Fonte → Upload**: envie o `ssh-tunel-relay.zip` (ou conecte o repositório no GitHub). Construção: **Dockerfile**.
3. **Ambiente**:
   ```
   TUNNEL_SECRET=um-token-longo-e-aleatorio
   ```
4. **Domínios**: o domínio deve apontar para a porta **80** do serviço (ex.: `https://meu-relay...` → `http://servico:80/`).
5. **Implantar**.
6. Confira: abra `https://SEU-RELAY/health` → `{"status":"ok",...}`.

Não é preciso publicar portas extras nem mexer no firewall da VPS.

### Variáveis de ambiente

| Variável | Obrigatória | Padrão | Descrição |
|---|---|---|---|
| `TUNNEL_SECRET` | **sim** | – | Senha compartilhada exigida de quem serve e de quem conecta. |
| `PORT` | não | `80` | Porta HTTP do container. |
| `PUBLIC_URL` | não | detectado | URL pública do relay, usada nos scripts. Por padrão vem dos headers `X-Forwarded-*` do proxy. |

---

## 2. Preparar o computador que será acessado

Uma vez só. Instala e liga o servidor SSH do Windows. Em um **PowerShell como Administrador**:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
```

Teste nesse mesmo computador:

```powershell
whoami                      # o usuário é a parte depois da "\"
ssh SEU_USUARIO@localhost
```

> Contas Microsoft: a senha do SSH é a **senha da conta Microsoft** (não o PIN do Windows Hello).

---

## 3. Servir: no computador que será acessado

Deixa este computador disponível com um id. A janela precisa ficar aberta; se a internet cair, ele **reconecta sozinho**.

**PowerShell**
```powershell
irm "https://SEU-RELAY/serve.ps1?id=casa" | iex
```

**cmd**
```bat
powershell -NoProfile -Command "& ([scriptblock]::Create((irm 'https://SEU-RELAY/serve.ps1?id=casa')))"
```

**Arquivo .cmd** (abra no navegador e dê dois cliques, ou no cmd):
```bat
curl -o tunnel-serve.cmd "https://SEU-RELAY/serve.cmd?id=casa" && .\tunnel-serve.cmd
```

Saída esperada:
```
  Relay   : https://SEU-RELAY
  Id      : casa
  Destino : 127.0.0.1:22
  ...
14:02:11  ONLINE como 'casa' -> 127.0.0.1:22 (aguardando conexoes)
```

Se o id não for informado, é usado o nome do computador (`$env:COMPUTERNAME`).

---

## 4. Conectar: no computador que vai acessar

Abre uma porta local e já inicia o `ssh` no computador remoto.

**PowerShell**
```powershell
irm "https://SEU-RELAY/connect.ps1?id=casa&user=SEU_USUARIO" | iex
```

**cmd**
```bat
powershell -NoProfile -Command "& ([scriptblock]::Create((irm 'https://SEU-RELAY/connect.ps1?id=casa&user=SEU_USUARIO')))"
```

**Arquivo .cmd**
```bat
curl -o tunnel-connect.cmd "https://SEU-RELAY/connect.cmd?id=casa&user=SEU_USUARIO" && .\tunnel-connect.cmd
```

Ao sair do `ssh` (`exit`), o túnel local é fechado.

### Só abrir a porta (scp, VS Code, WinSCP…)

```powershell
& ([scriptblock]::Create((irm 'https://SEU-RELAY/connect.ps1?id=casa'))) -NoSsh -LocalPort 2222
```

Enquanto essa janela estiver aberta, em outro terminal:

```powershell
ssh -o HostKeyAlias=casa -p 2222 SEU_USUARIO@127.0.0.1
scp -o HostKeyAlias=casa -P 2222 arquivo.txt SEU_USUARIO@127.0.0.1:Desktop/
```

Para o **VS Code Remote-SSH**, adicione em `~/.ssh/config`:

```
Host casa
    HostName 127.0.0.1
    Port 2222
    User SEU_USUARIO
    HostKeyAlias casa
```

> `HostKeyAlias` faz o `ssh` guardar a chave do host pelo **id**, e não por `127.0.0.1:2222`. Assim, acessar computadores diferentes pela mesma porta local não gera alerta de "chave mudou".

---

## O secret

Os dois scripts pedem o secret na tela (digitação oculta). Para não digitar, defina a variável **antes** de rodar o comando, na mesma janela:

| Onde | Comando |
|---|---|
| PowerShell | `$env:TUNNEL_SECRET = 'SEU_SECRET'` |
| cmd / arquivo .cmd | `set "TUNNEL_SECRET=SEU_SECRET"` |

Não coloque o secret na URL: URLs ficam registradas nos logs do proxy.

---

## Parâmetros

### Na URL (funcionam com `irm | iex`, cmd e `.cmd`)

| Parâmetro | Script | Descrição |
|---|---|---|
| `id` | serve, connect | Id do computador acessado. Letras, números, `.`, `_`, `-`. |
| `user` | connect | Usuário do Windows no computador acessado. Se presente, o `ssh` abre direto. |
| `port` | connect | Porta local (padrão `2222`). |

### No PowerShell (forma `[scriptblock]::Create`)

```powershell
& ([scriptblock]::Create((irm https://SEU-RELAY/serve.ps1))) -Id casa -TargetPort 22
& ([scriptblock]::Create((irm https://SEU-RELAY/connect.ps1))) -Id casa -User SEU_USUARIO -LocalPort 2222
```

**serve.ps1**

| Parâmetro | Padrão | Descrição |
|---|---|---|
| `-Id` | `?id=` ou nome do computador | Id deste computador. |
| `-Secret` | `$env:TUNNEL_SECRET` ou pergunta | Secret do relay. |
| `-Relay` | URL de onde o script foi baixado | URL do relay. |
| `-TargetHost` | `127.0.0.1` | Host do serviço a expor. |
| `-TargetPort` | `22` | Porta do serviço a expor (dá para expor outro TCP, ex.: `3389` do RDP). |

**connect.ps1**

| Parâmetro | Padrão | Descrição |
|---|---|---|
| `-Id` | `?id=` ou pergunta | Id do computador a acessar. |
| `-User` | `?user=` ou pergunta | Usuário remoto. Vazio = só abre a porta. |
| `-LocalPort` | `?port=` ou `2222` | Porta local. |
| `-NoSsh` | – | Não abre o `ssh`; só mantém a porta local. |
| `-Secret` | `$env:TUNNEL_SECRET` ou pergunta | Secret do relay. |
| `-Relay` | URL de onde o script foi baixado | URL do relay. |

Também são lidas as variáveis `TUNNEL_ID`, `TUNNEL_USER` e `TUNNEL_RELAY`.

---

## Endpoints do relay

| Caminho | Descrição |
|---|---|
| `/` | Página com os comandos e botão de copiar (no navegador). Em texto simples via `curl`. |
| `/serve.ps1`, `/connect.ps1` | Scripts PowerShell, com a URL do relay e os parâmetros (`?id=&user=&port=`) já embutidos. |
| `/serve.cmd`, `/connect.cmd` | Arquivos `.cmd` que chamam os scripts acima. |
| `/health` | `{"status":"ok","hostsOnline":1,"activeSessions":0,...}`: use no Uptime Kuma (monitor HTTP). |
| `/ws` | WebSocket usado pelos scripts. |

---

## Protocolo

Cada conexão WebSocket em `/ws` envia como **primeira mensagem** um JSON dizendo quem ela é:

| Mensagem | Quem envia | Significado |
|---|---|---|
| `{"role":"serve","id":"casa","secret":"…"}` | computador acessado | Canal de controle: "estou disponível como `casa`". |
| `{"role":"connect","id":"casa","secret":"…"}` | quem acessa | "Quero falar com `casa`". |
| `{"role":"accept","session":"…"}` | computador acessado | Canal de dados aberto para uma sessão específica. |

Fluxo de cada conexão:

1. `connect` chega → o relay cria uma sessão e manda `{"type":"open","session":"…"}` pelo canal de controle do `serve`.
2. O `serve` conecta em `127.0.0.1:22` e abre um novo WebSocket com `{"role":"accept","session":"…"}`.
3. O relay responde `{"type":"connected"}` ao `connect` e, daí em diante, só repassa frames binários entre os dois.

Se algo falhar, o relay envia `{"type":"error","message":"…"}` (ou `"fatal"` para erros definitivos, como secret inválido, em que o `serve` para de tentar reconectar).

---

## Segurança

- O **secret** controla quem pode usar o relay. Quem tem o secret chega até a **tela de login do SSH**, mas ainda precisa da senha ou chave do Windows.
- Tentativas com secret errado são registradas no log do relay e respondidas com atraso.
- **Recomendado:** login por chave e senha desativada no computador acessado:
  1. No computador que acessa: `ssh-keygen -t ed25519` e copie o conteúdo de `~/.ssh/id_ed25519.pub`.
  2. No computador acessado (PowerShell Admin), se o usuário for administrador:
     ```powershell
     Add-Content C:\ProgramData\ssh\administrators_authorized_keys "COLE_A_CHAVE_PUBLICA"
     icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"
     ```
     (usuário comum: `C:\Users\USUARIO\.ssh\authorized_keys`)
  3. Teste o login por chave; depois edite `C:\ProgramData\ssh\sshd_config` com `PasswordAuthentication no` e rode `Restart-Service sshd`.
- `irm | iex` executa o que o relay devolver. Use só com o **seu** relay, sempre via HTTPS, e evite rodar como Administrador sem necessidade.

---

## Problemas comuns

| Mensagem / sintoma | Causa e solução |
|---|---|
| `nenhum computador online com id '…'` | O `serve` não está rodando nesse computador, ou o id está diferente. |
| `servico local 127.0.0.1:22 indisponivel` | O OpenSSH Server não está instalado ou ligado no computador acessado (passo 2). |
| `secret invalido` | O secret não confere com o `TUNNEL_SECRET` do relay. |
| `Acesso negado` ao rodar pelo cmd | Alguns antivírus bloqueiam `powershell -Command "irm … \| iex"` e `-ExecutionPolicy Bypass`. Use a forma com `[scriptblock]::Create` (é a que este README e a página usam no cmd). Dentro de um PowerShell já aberto, `irm \| iex` funciona normalmente. |
| `serve.cmd` abre outro programa | Outro programa com o mesmo nome no PATH (ex.: o pacote `serve` do npm). Por isso os arquivos se chamam `tunnel-*.cmd` e são executados com `.\`. |
| Porta local `2222` em uso | Use `?port=2223` na URL ou `-LocalPort 2223`. |
| Alerta `REMOTE HOST IDENTIFICATION HAS CHANGED` | O computador com esse id foi reinstalado ou trocado: `ssh-keygen -R casa`. |
| Relay não responde | Veja `https://SEU-RELAY/health` e os logs do serviço no Easypanel. |

---

## Rodar localmente (desenvolvimento)

```powershell
npm install
$env:TUNNEL_SECRET = 'teste'; $env:PORT = '8080'; node server.js
```

Em outras janelas:

```powershell
$env:TUNNEL_SECRET = 'teste'
irm "http://127.0.0.1:8080/serve.ps1?id=casa" | iex          # servir
irm "http://127.0.0.1:8080/connect.ps1?id=casa&user=SEU_USUARIO" | iex   # conectar
```

Também dá para rodar os scripts direto da pasta `scripts/` (eles carregam o `Tunnel.cs` ao lado) informando `-Relay http://127.0.0.1:8080`.

### Estrutura

```
server.js            relay (HTTP + WebSocket)
public/index.html    página inicial com os comandos
scripts/serve.ps1    script do computador acessado
scripts/connect.ps1  script de quem acessa
scripts/Tunnel.cs    núcleo do túnel (C#, carregado pelos dois scripts via Add-Type)
Dockerfile           imagem para o Easypanel
```
