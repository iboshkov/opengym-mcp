# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately. Use GitHub's private vulnerability reporting on this repository (the "Report a vulnerability" button under the Security tab). Do not open a public issue or pull request for a suspected vulnerability.

Include what you found, the steps or request that reproduce it, which version or image tag you tested, and what an attacker could gain. Do not include real tokens, pairing codes or workout data in a report. A synthetic reproduction is best.

You can expect an acknowledgement and a fix or a decision as soon as a maintainer is able to look at it. This is a small volunteer project, so no response time is guaranteed. Please allow time for a fix before disclosing publicly.

## Supported versions

Fixes land on `main` and in the next release. Run the latest release (or the `edge` image if you follow `main`) and upgrade promptly. Older releases are not patched separately.

## In scope

Problems in this project's code, packaging and documentation that weaken its documented guarantees ([docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md)), for example:

- Bypassing OAuth: PKCE, resource binding, consent, scope enforcement, or refresh token rotation and replay detection.
- Reading or changing another profile's data, or acting on a profile after its upstream session was revoked.
- Making the consent flow complete without the person's pairing code, or from another browser or origin.
- Server-side request forgery through client metadata fetching.
- Weaknesses in the Host or Origin checks, the encrypted store, or key handling.
- Leaking tokens, pairing codes or workout data through logs, errors or responses.
- Writes that bypass revision checks, deletion guards or write limits.
- Container or Compose settings that are less restrictive than documented.

## Out of scope

- Vulnerabilities in openGym itself. Report them to the [openGym project](https://github.com/DuarteSantos8/openGym).
- Vulnerabilities in the vendored upstream code that also exist upstream. Report them upstream, and tell us if this project needs a vendor update.
- Vulnerabilities in your reverse proxy, tunnel, Docker host, or the AI assistant you connect.
- An attacker who already has the whole data volume, its key, or root on the host. The documented limits already say this gives access to stored sessions. See [Known limitations](docs/SECURITY_MODEL.md#known-limitations).
- Behaviour of an assistant that misuses write access you granted it. Choose read-only access if that is a concern.
- Missing rate limits on denial of service that need a large volume of traffic, and findings that only apply to an unsupported setup, such as serving without HTTPS or without the Host header passed through.
- Reports from automated scanners without a demonstrated impact.
