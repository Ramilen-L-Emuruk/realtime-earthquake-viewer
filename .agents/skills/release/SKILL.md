---
name: release
description: Coordinate an explicitly requested release, merge to the default branch, version update, tag, or push with safe preflight checks.
---

# Release

Use this skill only when the user explicitly requests a release, merge, tag, or push. Finishing implementation is not authorization to release.

1. Read the target repository's release commands, default branch, versioning convention, deployment behavior, and required validation. Stop for clarification if they are not defined.
2. Verify the current branch, a clean working tree, the remote tracking state, intended release candidates, and the latest remote default branch before changing Git state.
3. Present the planned merge, validation, version update, tag, and push steps when the request does not make those operations unambiguous. Obtain confirmation before actions that alter shared history, publish artifacts, or deploy.
4. Merge without rewriting history, run the required integration validation, then perform versioning and tagging only if validation passes.
5. Fetch again immediately before push. If push or CI fails, do not force-push, recreate version tags, or discard the resulting state. Report the exact state and await direction.
6. Remove only confirmed, merged worktrees or branches. Never use forced branch deletion or recursive removal against an unverified path.

Use `release-manager` for release preflight and coordination. Preserve any project-specific release lock only when its mechanism is documented and usable in Codex.
