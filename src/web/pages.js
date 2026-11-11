import { WRITE } from '../scopes.js'
import { html, raw } from './html.js'

const PAIRING_PATH = 'Settings → Account → Pair the mobile app'
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']

// The openGym dumbbell, traced from the app icon. Colours come from the stylesheet.
const logo = raw(`<svg class="brand-mark" viewBox="80 169 352 174" aria-hidden="true">
  <rect x="80" y="242" width="352" height="28"/><rect x="80" y="199" width="36" height="114"/>
  <rect x="131" y="169" width="47" height="174"/><rect x="334" y="169" width="47" height="174"/>
  <rect x="396" y="199" width="36" height="114"/></svg>`)

function layout({ title, narrow = false, body }) {
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>${title}</title>
  <link rel="icon" type="image/svg+xml" href="/assets/icon.svg">
  <link rel="stylesheet" href="/assets/style.css">
  <script src="/assets/connect.js" defer></script>
</head>
<body>
  <main class="${narrow ? 'shell narrow' : 'shell'}">
    <header class="masthead">
      <a class="brand" href="/">${logo}<span class="wordmark">open<b>Gym</b></span><span class="chip">MCP</span></a>
    </header>
    ${body}
  </main>
</body>
</html>`.toString()
}

/** "Open openGym", linked when the public address of openGym is known. */
const openGymLink = (url, label = 'Open openGym') => url
  ? html`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
  : label

const copyable = (id, value, label) => html`
  <div class="copy-field">
    <input id="${id}" value="${value}" readonly aria-label="${label}">
    <button type="button" class="btn small" data-copy="${id}">Copy</button>
  </div>`

const assistant = (name, body, open = false) => html`
  <details name="assistant" ${open ? raw('open') : ''}>
    <summary>${name}</summary>
    <div class="details-body">${body}</div>
  </details>`

/** The landing page: where the MCP endpoint is and how to add it to an assistant. */
export function connectionPage({ mcpUrl, openGymUrl }) {
  return layout({
    title: 'Connect an assistant · openGym MCP',
    body: html`
    <section class="hero">
      <h1>Connect your AI assistant to openGym</h1>
      <p class="lead">Let Claude, ChatGPT or another assistant read your training history and, if you allow it, log workouts and edit routines for you.</p>
    </section>

    <ol class="steps">
      <li class="step card">
        <h2>Copy the server address</h2>
        ${copyable('mcp-url', mcpUrl, 'MCP server URL')}
        <p class="status" id="copy-status" role="status" aria-live="polite"></p>
      </li>

      <li class="step card">
        <h2>Add it to your assistant</h2>
        <p class="muted">Choose OAuth if you are asked how to sign in. You never need to create a client ID or secret.</p>
        <div class="accordion">
          ${assistant('Claude', html`
            <ol>
              <li>Open <strong>Settings → Connectors</strong>.</li>
              <li>Choose <strong>Add custom connector</strong>.</li>
              <li>Name it <strong>openGym</strong> and paste the server address.</li>
              <li>Leave the advanced OAuth client ID and secret fields empty, add the connector, then choose <strong>Connect</strong>.</li>
            </ol>
            <p class="muted">Works in claude.ai, Claude Desktop and Cowork. No terminal commands needed.</p>`, true)}
          ${assistant('ChatGPT', html`
            <ol>
              <li>Open <strong>Plugins</strong> and choose <strong>+ → Add custom MCP server</strong>.</li>
              <li>Name it <strong>openGym</strong>, paste the server address and choose <strong>OAuth</strong>.</li>
              <li>If asked how to register, choose client metadata (CIMD) or dynamic registration and leave static credentials empty.</li>
              <li>Create it, connect, and enable it in the chat where you want to use it.</li>
            </ol>`)}
          ${assistant('Claude Code', html`
            <p>Run this once, then type <code>/mcp</code> in Claude Code and choose openGym to sign in.</p>
            ${copyable('cmd-claude-code', `claude mcp add --transport http --scope user opengym ${mcpUrl}`, 'Claude Code command')}`)}
          ${assistant('Codex', html`
            <p>Add the server, then sign in.</p>
            ${copyable('cmd-codex-add', `codex mcp add opengym --url ${mcpUrl}`, 'Codex add command')}
            ${copyable('cmd-codex-login', 'codex mcp login opengym --scopes opengym:read,opengym:write', 'Codex login command')}`)}
          ${assistant('Cursor, VS Code and others', html`
            <p>Add a remote <strong>HTTP</strong> (Streamable HTTP) MCP server with the address above, then use the assistant's Connect or Sign in action.</p>
            <p class="muted">Any client that supports remote MCP with OAuth and PKCE works. Configuration snippets for each client are in the project documentation.</p>`)}
        </div>
      </li>

      <li class="step card">
        <h2>Pair your profile</h2>
        <p>Your assistant opens a sign-in page here and asks for a one-time code. To get one:</p>
        <ol>
          <li>${openGymLink(openGymUrl)} and sign in to the profile you want to share.</li>
          <li>Go to <strong>${PAIRING_PATH}</strong> and confirm it is you.</li>
          <li>Type the code into the sign-in page and choose what the assistant may do.</li>
        </ol>
        <p class="muted">openGym calls this “Pair the mobile app”, but the same code links an assistant. Each code works once and expires after five minutes.</p>
      </li>
    </ol>

    <footer class="fineprint">
      <p>An assistant only sees the profile you pair, and never your passkey or password. To disconnect, remove the connector in your assistant. “Sign out everywhere” in openGym ends every paired session at once, phones included.</p>
    </footer>`
  })
}

/** Who is asking for access, so a person can tell a real request from a lookalike. */
function clientIdentity(flow) {
  const callback = new URL(flow.params.redirectUri)
  let identity = 'Registered application'
  try { identity = new URL(flow.client.client_id).hostname } catch { /* a registered client has an opaque ID */ }
  const isLocal = LOOPBACK_HOSTS.includes(callback.hostname)
  return html`
    <dl class="identity">
      <div><dt>Application</dt><dd>${identity}</dd></div>
      <div><dt>Returns to</dt><dd>${callback.host || callback.protocol}</dd></div>
    </dl>
    ${isLocal && html`<p class="muted">This is a local agent on your device. Continue only if you started this connection.</p>`}`
}

/** The sign-in page an assistant opens: pair a profile and choose its permissions. */
export function consentPage({ flow, openGymUrl, error = '' }) {
  const clientName = flow.client.client_name || 'your assistant'
  const mayRequestWrite = flow.scopes.includes(WRITE)
  return layout({
    title: `Connect ${clientName} · openGym MCP`,
    narrow: true,
    body: html`
    <section class="hero">
      <h1>Connect ${clientName}</h1>
      <p class="lead">Share one openGym profile with this assistant.</p>
    </section>

    <section class="card">${clientIdentity(flow)}</section>

    <form class="card" method="post" action="/consent">
      <h2>Enter a pairing code</h2>
      <ol>
        <li>${openGymLink(openGymUrl)} and sign in to the profile to share.</li>
        <li>Go to <strong>${PAIRING_PATH}</strong> and confirm it is you.</li>
        <li>Type the code it shows below. It expires after five minutes.</li>
      </ol>
      ${error && html`<p class="alert" role="alert">${error}</p>`}
      <label class="field-label" for="pair-code">One-time pairing code</label>
      <input class="code-input" id="pair-code" type="text" name="code" required autofocus
        autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false"
        maxlength="20" aria-describedby="pair-code-help">
      <p class="muted" id="pair-code-help">Only the code from openGym. Never your password or passkey.</p>

      <h2>Access</h2>
      <ul class="permissions">
        <li class="permission">
          <span class="tick" aria-hidden="true">✓</span>
          <span><strong>Read your training data</strong><br><span class="muted">Workouts, routines, exercises and bodyweight.</span></span>
        </li>
        ${mayRequestWrite && html`
        <li>
          <label class="permission">
            <input type="checkbox" name="allow_write" value="yes" ${flow.allowWrite === false ? '' : raw('checked')}>
            <span><strong>Also allow changes</strong><br><span class="muted">Log, edit and delete workouts, routines, custom exercises and bodyweight.</span></span>
          </label>
        </li>`}
      </ul>

      <input type="hidden" name="ticket" value="${flow.ticket}">
      <div class="actions">
        <button class="btn primary" name="decision" value="allow">Connect openGym</button>
        <button class="btn plain" name="decision" value="deny" formnovalidate>Cancel</button>
      </div>
    </form>

    <footer class="fineprint">
      <p>Only the paired profile is shared. You can end access at any time from your assistant, or with “Sign out everywhere” in openGym.</p>
    </footer>`
  })
}

/** A short full-page message with a way forward, for sign-in attempts that cannot continue. */
export function noticePage({ title, message, steps = [] }) {
  return layout({
    title: `${title} · openGym MCP`,
    narrow: true,
    body: html`
    <section class="hero">
      <h1>${title}</h1>
      <p class="lead">${message}</p>
    </section>
    ${steps.length > 0 && html`<section class="card"><ol>${steps.map(step => html`<li>${step}</li>`)}</ol></section>`}
    <p><a class="btn" href="/">Open the connection guide</a></p>`
  })
}

export const authorizationErrorPage = () => noticePage({
  title: 'Start again from your assistant',
  message: 'The sign-in request was incomplete, or the assistant could not be identified.',
  steps: [
    'Close this tab.',
    html`In your assistant, choose <strong>Connect</strong> for openGym again. In Claude that is <strong>Settings → Connectors → openGym → Connect</strong>.`,
    'If the same message returns, remove the openGym connector and add it again. Leave the OAuth client ID and secret fields empty.'
  ]
})

export const expiredAuthorizationPage = () => noticePage({
  title: 'This sign-in has expired',
  message: 'Sign-in pages stay valid for ten minutes and can be used once. Choose Connect in your assistant to open a fresh one.'
})

export const tooManyAttemptsPage = () => noticePage({
  title: 'Too many attempts',
  message: 'Several pairing codes were not accepted. Choose Connect in your assistant to start again with a new code.'
})
