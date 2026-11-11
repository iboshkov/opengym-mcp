# openGym MCP documentation

openGym MCP is a remote MCP server (Streamable HTTP with OAuth) that runs beside a self-hosted [openGym](https://github.com/DuarteSantos8/openGym) and lets AI assistants read and edit a paired profile. The project overview and a quick start are in the [top-level README](../README.md).

## Setting it up

| Document | Read it to |
| --- | --- |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Run it as a sidecar in openGym's Compose project or standalone, publish it over HTTPS, back up and restore its data, upgrade, and fix common problems. |
| [CONFIGURATION.md](CONFIGURATION.md) | Look up every environment variable, Compose setting and built-in limit. |
| [CLIENTS.md](CLIENTS.md) | Connect Claude, ChatGPT, Codex, Cursor, VS Code or another MCP client. |

## Understanding it

| Document | Read it to |
| --- | --- |
| [TOOLS.md](TOOLS.md) | See what assistants can do, and how writes, retries and deletions behave. |
| [SECURITY_MODEL.md](SECURITY_MODEL.md) | Understand how authorization works, what is stored, and the known limits. |

## Working on it

| Document | Read it to |
| --- | --- |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Set up a checkout, run the tests, find your way around the source, and update the vendored openGym code. |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Know what a change needs before you open a pull request. |
| [../SECURITY.md](../SECURITY.md) | Report a vulnerability privately. |
| [../vendor/UPSTREAM.md](../vendor/UPSTREAM.md) | See which upstream revision is vendored and what was adapted. |
