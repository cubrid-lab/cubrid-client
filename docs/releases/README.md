# Curated release notes

Each `vX.Y.Z.md` describes the **code in the immutable version tag**, not features merged afterwards. Use single-line Markdown bullets, verified `by @username` credits, and a Full Changelog link. Start with a short prose summary of user impact (at most 900 characters, no lists) before the first section; curate generated output (no raw `* ` bullets, conventional-commit prefixes such as `fix:` or exact duplicate entries).

| Version | GitHub Release status | Source |
| --- | --- | --- |
| v0.1.0 | Existing published Release | [v0.1.0.md](v0.1.0.md) |
| v0.2.0 | Tag exists; no published GitHub Release page | [v0.2.0.md](v0.2.0.md) |
| v1.0.0 | Existing published Release | [v1.0.0.md](v1.0.0.md) |
| v1.1.0 | Existing published Release | [v1.1.0.md](v1.1.0.md) |
| v1.2.0 | Existing published Release | [v1.2.0.md](v1.2.0.md) |
| v1.3.0 | Existing published Release | [v1.3.0.md](v1.3.0.md) |
| v1.4.0 | Existing published Release | [v1.4.0.md](v1.4.0.md) |
| v1.5.0 | Existing published Release | [v1.5.0.md](v1.5.0.md) |
| v1.6.0 | Existing published Release | [v1.6.0.md](v1.6.0.md) |

A source change does not update the public body. Each existing GitHub Release description is updated separately, body only, with a backup, a concurrency check and a fresh readback; this never changes tags, creates a missing GitHub Release, or republishes npm packages. The one-time synchronization workflow was removed by [#235](https://github.com/cubrid-lab/cubrid-client/pull/235) (issue [#226](https://github.com/cubrid-lab/cubrid-client/issues/226)). The [release notes audit](../RELEASE_NOTES_AUDIT.md) records the version-by-version check of the published bodies and which ones await a body-only sync.
