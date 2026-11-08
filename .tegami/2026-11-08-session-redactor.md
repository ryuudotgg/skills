---
packages:
  skills-cli: patch
---

### 🧰 Redact secrets from session transcripts

`packages/cli/src/sessions/redact.ts` replaces secrets in transcript text with `[redacted:<rule>]`, using the gitleaks v8.30.1 rule set vendored under `third-party/gitleaks/`, values from `.env` files, and an entropy check after key like names. Nothing calls it yet: the session sync and digest plans build on it.
