# Security Policy

## Reporting a vulnerability

Please report vulnerabilities by email to **security@systaro.de**. Do not file
public issues for security problems.

We will acknowledge receipt within 2 business days and aim to provide a
remediation plan within 14 days for high-severity issues.

When reporting, please include:

- A clear description of the issue and its impact.
- Steps to reproduce (proof-of-concept code is welcome).
- The affected version (the release tag, or `git rev-parse HEAD`).
- Whether you've disclosed this to anyone else.

Findings that let one user read data of an environment they were not
granted, or read it at a higher level than granted, are the most serious kind
for Vantage: separation between customers rests on row-level security in
Postgres (see `docs/design.md`, section 3).

## Supported versions

We support the latest release on the `main` branch. There is no commitment to
backport fixes to older releases.

## Design choices that are not vulnerabilities

- **Uploaded test reports run their own JavaScript.** Playwright HTML reports
  are served as uploaded, from a separate origin on a registrable domain of
  its own (`REPORTS_URL`), never from the hub's origin. All reports share that
  origin, so one report can read another report's browser storage; see
  `docs/self-hosting.md`, "Reports origin".
- **There is no web setup endpoint.** The first administrator is created on the
  server with `scripts/create-admin.ts`, which prints a one-time invite link.
- **Admins see everything.** The `admin` group bypasses grants by design and is
  trusted with root-equivalent control of the installation.
- **The trade-offs listed in `docs/design.md`, section 8** (session idle
  timeout counting background refreshes, the window of a signed report link,
  per-process replay protection) are accepted and documented on purpose.

## Out of scope

- Issues that require an authenticated admin to exploit.
- Denial of service through expensive queries or large uploads beyond the
  documented quotas.
- Vulnerabilities in third-party dependencies that we have not yet upgraded,
  unless you have a working exploit against Vantage's use of the dependency.
