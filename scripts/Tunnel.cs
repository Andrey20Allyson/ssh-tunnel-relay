// Nucleo do tunel usado por serve.ps1 e connect.ps1 (carregado via Add-Type).
// Escrito em C# 5 para compilar no Windows PowerShell 5.1 (.NET Framework 4.5+).
using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace SshTunnel
{
    public static class Tunnel
    {
        // O PowerShell le esta fila e imprime as linhas (Console direto de outras threads nao e confiavel).
        public static readonly ConcurrentQueue<string> Logs = new ConcurrentQueue<string>();

        static CancellationTokenSource cts = new CancellationTokenSource();
        static TcpListener listener;
        const int BufferSize = 64 * 1024;

        // ------------------------------------------------------------ utilitarios

        static void Log(string m) { Logs.Enqueue(DateTime.Now.ToString("HH:mm:ss") + "  " + m); }

        static void Forget(Task t) { }

        static string Msg(Exception e)
        {
            while (e.InnerException != null) e = e.InnerException;
            return e.Message;
        }

        static string Short(string sid) { return sid != null && sid.Length > 8 ? sid.Substring(0, 8) : sid; }

        static string J(string s)
        {
            var sb = new StringBuilder("\"");
            foreach (char c in s ?? "")
            {
                if (c == '"' || c == '\\') { sb.Append('\\').Append(c); }
                else if (c < 0x20) { sb.Append(' '); }
                else { sb.Append(c); }
            }
            return sb.Append('"').ToString();
        }

        static string Field(string json, string name)
        {
            Match m = Regex.Match(json ?? "", "\"" + name + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
            return m.Success ? Regex.Unescape(m.Groups[1].Value) : null;
        }

        public static void Stop()
        {
            cts.Cancel();
            TcpListener l = listener;
            listener = null;
            if (l != null) { try { l.Stop(); } catch { } }
        }

        // ------------------------------------------------------------ websocket

        static async Task<ClientWebSocket> Open(string url, string hello)
        {
            var ws = new ClientWebSocket();
            ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
            await ws.ConnectAsync(new Uri(url), cts.Token);
            byte[] b = Encoding.UTF8.GetBytes(hello);
            await ws.SendAsync(new ArraySegment<byte>(b), WebSocketMessageType.Text, true, cts.Token);
            return ws;
        }

        static async Task SendText(WebSocket ws, string text, SemaphoreSlim gate)
        {
            await gate.WaitAsync();
            try
            {
                byte[] b = Encoding.UTF8.GetBytes(text);
                await ws.SendAsync(new ArraySegment<byte>(b), WebSocketMessageType.Text, true, cts.Token);
            }
            finally { gate.Release(); }
        }

        // Le a proxima mensagem de texto; null se o websocket fechou.
        static async Task<string> ReceiveText(WebSocket ws)
        {
            var buf = new byte[8192];
            var ms = new MemoryStream();
            while (true)
            {
                WebSocketReceiveResult r = await ws.ReceiveAsync(new ArraySegment<byte>(buf), cts.Token);
                if (r.MessageType == WebSocketMessageType.Close) return null;
                ms.Write(buf, 0, r.Count);
                if (!r.EndOfMessage) continue;
                if (r.MessageType == WebSocketMessageType.Text) return Encoding.UTF8.GetString(ms.ToArray());
                ms.SetLength(0);
            }
        }

        static void Close(ClientWebSocket ws)
        {
            if (ws == null) return;
            try { ws.Abort(); } catch { }
            try { ws.Dispose(); } catch { }
        }

        // ------------------------------------------------------------ bombeamento de bytes

        static async Task Pump(WebSocket ws, TcpClient tcp)
        {
            NetworkStream ns = tcp.GetStream();
            await Task.WhenAny(TcpToWs(ns, ws), WsToTcp(ws, ns));
        }

        static async Task TcpToWs(NetworkStream ns, WebSocket ws)
        {
            var buf = new byte[BufferSize];
            try
            {
                while (true)
                {
                    int n = await ns.ReadAsync(buf, 0, buf.Length, cts.Token);
                    if (n <= 0) break;
                    await ws.SendAsync(new ArraySegment<byte>(buf, 0, n), WebSocketMessageType.Binary, true, cts.Token);
                }
            }
            catch { }
        }

        static async Task WsToTcp(WebSocket ws, NetworkStream ns)
        {
            var buf = new byte[BufferSize];
            try
            {
                while (true)
                {
                    WebSocketReceiveResult r = await ws.ReceiveAsync(new ArraySegment<byte>(buf), cts.Token);
                    if (r.MessageType == WebSocketMessageType.Close) break;
                    if (r.MessageType == WebSocketMessageType.Binary && r.Count > 0)
                        await ns.WriteAsync(buf, 0, r.Count, cts.Token);
                }
            }
            catch { }
        }

        // ------------------------------------------------------------ SERVE (computador acessado)

        public static Task Serve(string wsUrl, string id, string secret, string targetHost, int targetPort)
        {
            cts = new CancellationTokenSource();
            return Task.Run(async () =>
            {
                while (!cts.IsCancellationRequested)
                {
                    bool fatal = false;
                    try { fatal = await ServeOnce(wsUrl, id, secret, targetHost, targetPort); }
                    catch (Exception e)
                    {
                        if (!cts.IsCancellationRequested) Log("falha na conexao com o relay: " + Msg(e));
                    }
                    if (fatal || cts.IsCancellationRequested) break;
                    Log("reconectando em 5s...");
                    try { await Task.Delay(5000, cts.Token); } catch { }
                }
            });
        }

        // Retorna true se o erro for definitivo (ex.: secret errado) e nao vale a pena reconectar.
        static async Task<bool> ServeOnce(string wsUrl, string id, string secret, string targetHost, int targetPort)
        {
            ClientWebSocket ws = await Open(wsUrl,
                "{\"role\":\"serve\",\"id\":" + J(id) + ",\"secret\":" + J(secret) + "}");
            var gate = new SemaphoreSlim(1, 1);
            try
            {
                while (true)
                {
                    string msg = await ReceiveText(ws);
                    if (msg == null) { Log("relay fechou a conexao"); return false; }
                    string type = Field(msg, "type");
                    if (type == "ready")
                        Log("ONLINE como '" + id + "' -> " + targetHost + ":" + targetPort + " (aguardando conexoes)");
                    else if (type == "fatal") { Log("ERRO: " + Field(msg, "message")); return true; }
                    else if (type == "error") Log("relay: " + Field(msg, "message"));
                    else if (type == "open")
                        Forget(HandleSession(wsUrl, Field(msg, "session"), targetHost, targetPort, ws, gate));
                }
            }
            finally { Close(ws); }
        }

        static async Task HandleSession(string wsUrl, string sid, string targetHost, int targetPort,
                                        ClientWebSocket control, SemaphoreSlim gate)
        {
            var tcp = new TcpClient();
            ClientWebSocket ws = null;
            string error = null;
            try { await tcp.ConnectAsync(targetHost, targetPort); }
            catch (Exception e) { error = Msg(e); }

            if (error != null)
            {
                Log("sessao " + Short(sid) + ": nao conectou em " + targetHost + ":" + targetPort + " - " + error);
                try
                {
                    await SendText(control, "{\"type\":\"reject\",\"session\":" + J(sid) + ",\"message\":" +
                        J("servico local " + targetHost + ":" + targetPort + " indisponivel no computador remoto") + "}", gate);
                }
                catch { }
                tcp.Close();
                return;
            }

            try
            {
                tcp.NoDelay = true;
                ws = await Open(wsUrl, "{\"role\":\"accept\",\"session\":" + J(sid) + "}");
                Log("sessao " + Short(sid) + " aberta");
                await Pump(ws, tcp);
            }
            catch (Exception e) { Log("sessao " + Short(sid) + " erro: " + Msg(e)); }
            finally
            {
                Close(ws);
                tcp.Close();
                Log("sessao " + Short(sid) + " encerrada");
            }
        }

        // ------------------------------------------------------------ CONNECT (quem acessa)

        public static Task Connect(string wsUrl, string id, string secret, int localPort)
        {
            cts = new CancellationTokenSource();
            var l = new TcpListener(IPAddress.Loopback, localPort);
            l.Start(); // lanca excecao aqui mesmo se a porta estiver ocupada
            listener = l;
            Log("porta local 127.0.0.1:" + localPort + " -> '" + id + "'");
            return Task.Run(async () =>
            {
                while (!cts.IsCancellationRequested)
                {
                    TcpClient c;
                    try { c = await l.AcceptTcpClientAsync(); }
                    catch { break; }
                    Forget(HandleClient(wsUrl, id, secret, c));
                }
            });
        }

        static async Task HandleClient(string wsUrl, string id, string secret, TcpClient tcp)
        {
            ClientWebSocket ws = null;
            try
            {
                tcp.NoDelay = true;
                ws = await Open(wsUrl,
                    "{\"role\":\"connect\",\"id\":" + J(id) + ",\"secret\":" + J(secret) + "}");
                string msg = await ReceiveText(ws);
                string type = Field(msg, "type");
                if (type != "connected")
                {
                    Log("ERRO: " + (msg == null ? "relay fechou a conexao" : Field(msg, "message")));
                    return;
                }
                Log("conectado a '" + id + "'");
                await Pump(ws, tcp);
                Log("conexao com '" + id + "' encerrada");
            }
            catch (Exception e) { Log("ERRO: " + Msg(e)); }
            finally
            {
                Close(ws);
                tcp.Close();
            }
        }
    }
}
