# Security

Workroom is a single-user application bound to `127.0.0.1`. Run it on your own authenticated work machine. Remote hosting, shared accounts and multi-user access are outside the supported deployment model.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/rvben/workroom/security/advisories/new). Do not post credentials, service records, raw transcripts or local databases in a public issue. If private reporting is unavailable, contact the maintainer through their public GitHub profile without including sensitive material in the initial message. There is no guaranteed response time for this preview project.

The latest preview is the supported line. Security fixes may require upgrading; older snapshots are not maintained separately.

## Local data and permissions

Backend credentials stay in each CLI's own storage. Workroom caches source records, notes and activity in its data directory. It also stores a local agent API credential and private terminal reporting bindings. Protect and back up that directory as authenticated application state. Database contents are not encrypted by Workroom.

Browser-only review endpoints reject agent bearer credentials. Loopback host and origin checks reduce cross-site access. These controls do not isolate other processes running as the same OS user: those processes can read files, use the CLIs and obtain local API access.

Remote text is displayed as text. Commands use fixed argument arrays. Human review and stale-state checks precede supported external writes; uncertain outcomes are not automatically retried. Agent-reported events describe cooperative observations, not cryptographic proof that work happened. Keep your coding agent's own tool approval policies enabled.

## Before sharing diagnostics

Use synthetic examples. Redact tokens, account identifiers, internal domains, repository paths, message contents and personal details. Never attach the private data directory or a terminal transcript by default. Automated secret checks supplement this review; they do not prove the absence of sensitive information.
