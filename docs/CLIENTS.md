# Connecting assistants

Every client uses the same address: your server's `/mcp` path, for example `https://gym-mcp.example.com/mcp`. Replace the example host with your own `PUBLIC_ORIGIN` in everything below.

Your server also serves a guide at its root (`https://gym-mcp.example.com/`) with a copy button for the URL and these steps for the common assistants.

Contents: [How sign-in works](#how-sign-in-works) · [Claude apps](#claude-desktop-claudeai-and-cowork) · [Claude Code](#claude-code) · [Codex](#codex) · [ChatGPT](#chatgpt) · [Cursor](#cursor) · [VS Code](#vs-code-and-github-copilot) · [Other clients](#other-clients) · [Bearer token fallback](#clients-without-oauth) · [Troubleshooting](#troubleshooting)

## How sign-in works

1. You add the server URL to the assistant and choose Connect (or Login).
2. The assistant opens a sign-in page on your openGym MCP server in a browser.
3. In openGym, pick the profile to share, open **Settings → Account → Pair the mobile app**, and confirm with your passkey or password. openGym shows an 8-character one-time code, valid for 5 minutes.
4. Type the code into the sign-in page. Choose whether to allow changes: leave **Also allow changes** ticked for read and write, or untick it for read-only.
5. Choose **Connect openGym**. The browser returns to the assistant, which is now connected.

The pairing page in openGym is labelled for the mobile app, but the same code links an assistant. Each code works once. Your passkey or password is never sent to this service, and the assistant receives an MCP access token, not your openGym session.

You never need to create a client ID or secret. Leave any "advanced" OAuth fields empty.

To disconnect, remove the connector in the assistant. You can also end every paired session at once with **Sign out everywhere** in openGym.

## Claude Desktop, claude.ai and Cowork

1. Open **Settings → Connectors**.
2. Choose **Add custom connector**.
3. Name it `openGym` and paste `https://gym-mcp.example.com/mcp` as the remote MCP server URL.
4. Leave the advanced OAuth client ID and client secret fields empty. Add the connector, then choose **Connect**.
5. Complete the pairing-code sign-in described above.

Custom connectors in the Claude apps are called from Anthropic's servers, so your hostname must be reachable from the public internet.

If a failed attempt shows an invalid client error, close that sign-in tab and choose Connect again. If Claude keeps the failed attempt, remove the connector and add it again. Do not enter a guessed client ID.

## Claude Code

```sh
claude mcp add --transport http --scope user opengym https://gym-mcp.example.com/mcp
```

In Claude Code run `/mcp`, select `opengym`, and complete the browser sign-in. Tool permissions are still governed by Claude Code's own approval settings.

## Codex

```sh
codex mcp add opengym --url https://gym-mcp.example.com/mcp
codex mcp login opengym --scopes opengym:read,opengym:write
```

Use `--scopes opengym:read` for a read-only connection.

## ChatGPT

Add a custom MCP server (under plugins or connectors, depending on your plan and workspace settings):

1. Use `https://gym-mcp.example.com/mcp` as the server URL and choose **OAuth** for authentication.
2. If a client registration choice is shown, choose client ID metadata documents (CIMD) or dynamic client registration (DCR). Leave static client ID and secret fields empty.
3. Complete the pairing-code sign-in, then enable the connection in the chats where you want to use it.

Availability and approval controls depend on your account type and workspace.

## Cursor

Add this to Cursor's MCP configuration, then use its Connect or Login action:

```json
{
  "mcpServers": {
    "opengym": { "url": "https://gym-mcp.example.com/mcp" }
  }
}
```

## VS Code and GitHub Copilot

In `.vscode/mcp.json`:

```json
{
  "servers": {
    "opengym": { "type": "http", "url": "https://gym-mcp.example.com/mcp" }
  }
}
```

Start the server from the MCP view and complete the sign-in.

## Other clients

Any client that supports Streamable HTTP with OAuth, S256 PKCE and either dynamic client registration or client ID metadata documents can use the same URL. The server accepts these redirect URLs: HTTPS, loopback `http://127.0.0.1`, `http://localhost` and `http://[::1]` (any port), and the `cursor:`, `vscode:` and `vscode-insiders:` schemes.

The endpoint is stateless and answers each POST with a JSON response. It does not open an SSE stream, and `GET /mcp` returns 405. Standard clients handle this without configuration.

An unauthenticated request gets HTTP 401 with a `WWW-Authenticate` header pointing at the protected resource metadata, so clients can discover the authorization server on their own. Discovery documents are at `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`.

### stdio-only clients

For clients that can only launch local command servers, use the separately maintained [`mcp-remote`](https://github.com/geelen/mcp-remote) relay, which handles the OAuth flow:

```json
{
  "mcpServers": {
    "opengym": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://gym-mcp.example.com/mcp"]
    }
  }
}
```

## Clients without OAuth

If a client cannot do OAuth but can send custom headers, the endpoint also accepts an openGym paired-session token as a bearer token:

```
Authorization: Bearer <your-own-paired-session-token>
```

Supply it through the client's secret storage or environment-variable header support. Never put a token in the URL or commit it to configuration. This token is a full openGym profile session. This service still limits what it can do to the documented tools, but the connection always has read and write access and cannot be restricted to read-only. Prefer OAuth wherever the client supports it.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| The sign-in page says the sign-in expired | Pages last 10 minutes and work once, and do not survive a server restart. Close the tab and choose Connect again in the assistant. |
| "That code was not accepted" | Create a fresh code in openGym. Codes expire after 5 minutes and work once. After 5 wrong attempts the page is closed and you start again from the assistant. |
| The assistant says authorization expired or was revoked | The 30-day grant ended, you signed out everywhere, or the connection was removed. Reconnect. |
| Write tools are refused | The connection was made read-only. Disconnect and reconnect with **Also allow changes** ticked. |
| Browser shows HTTP 421 | The reverse proxy is not passing the original Host header. See [DEPLOYMENT.md](DEPLOYMENT.md). |

## Reference

- [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Claude remote connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- [OpenAI authentication](https://developers.openai.com/plugins/build/auth)
- [Cursor MCP](https://docs.cursor.com/context/model-context-protocol)
- [VS Code MCP](https://code.visualstudio.com/docs/agent-customization/mcp-servers)
