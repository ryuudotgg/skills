# Security Policy

If you find a security vulnerability in Ryuu's Skills, report it privately. Do not open a public issue, since that shows the problem to everyone before a fix exists.

## Reporting a Vulnerability

Report it in one of two ways:

- Open a private advisory on [GitHub](https://github.com/ryuudotgg/skills/security/advisories/new).
- Email [security@ryuu.gg](mailto:security@ryuu.gg).

## What to Include

A report we can act on says:

- What the vulnerability is and which part of the project it affects.
- The steps that reproduce it, with the version or commit you tested.
- What an attacker could do with it, and to whom.
- A fix, if you have one in mind.
- How to reach you, as a GitHub username or an email address, so we can follow up and credit you.

## Response Timeline

After you report, this is what happens:

1. You get an acknowledgment within 48 hours.
2. While we investigate and fix the issue, you get an update about every 5 days.
3. Once a fix is ready, we agree with you on when and how the vulnerability is disclosed.

## Scope

This policy covers everything this repository ships:

- The `skills` CLI and the hooks it installs into your agents.
- `install.sh`, the installer.
- The hub, and its image at `ghcr.io/ryuudotgg/skills-hub`. What the hub is trusted with, and what it is not, is set out in [Hub Security](https://skills.ryuu.gg/hub/security).
- The dashboard that `skills dash` serves.
- The documentation site at [skills.ryuu.gg](https://skills.ryuu.gg).

## Security Updates

Each fix is announced in a [GitHub security advisory](https://github.com/ryuudotgg/skills/security/advisories) on this repository and in the release notes of the version that ships it.

## Acknowledgments

With your permission, we credit you in the advisory and the release notes for the fix. Thank you for helping keep these skills and the people who use them safe.
