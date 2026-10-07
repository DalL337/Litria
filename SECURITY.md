# Security Policy

## Supported Versions

Only the **latest release** gets security fixes. Litria is in public beta, and
fixes ship as a new release rather than as patches to older versions.

| Version | Supported |
| --- | --- |
| [Latest release](https://github.com/DalL337/Litria/releases/latest) | ✅ |
| Anything older | ❌ |

Before reporting, check that the problem still happens on the latest release.

## Scope

This policy covers the **Litria desktop app**: the source in this repository
and the builds published on its Releases page. Examples of what counts:

- Opening a project or file makes Litria run code the user didn't ask it to run.
- Litria reads, writes, or deletes files outside what the user asked for.
- Something Litria downloads, such as a language server or runtime, could be
  swapped or tampered with.

Not covered:

- **The litria.dev website.**
- **Known vulnerabilities in third-party dependencies**, unless you can show
  they are exploitable through Litria. Report those to the dependency's
  maintainers.

## Reporting a Vulnerability

**Don't open a public issue, discussion, or pull request for a security
problem.** Report it privately instead:

1. Go to this repository's **Security** tab.
2. Click **[Report a vulnerability](https://github.com/DalL337/Litria/security/advisories/new)**.

Only you and the maintainer can see the report. Please include:

- your Litria version and operating system;
- steps to reproduce;
- what an attacker could do with it;
- a proof of concept, if you have one.

## What to Expect

- **Review within 72 hours.** Every report gets a first reply within 72 hours.
- **Updates stay in the report.** Discussion, fix progress, and questions all
  happen in the private advisory.
- **The fix ships in a new release.** The advisory is published once that
  release is out. If you want credit in it, say so.
- **Please keep it private until then.**

Litria has one maintainer and no bug bounty. Thank you for reporting
responsibly.
