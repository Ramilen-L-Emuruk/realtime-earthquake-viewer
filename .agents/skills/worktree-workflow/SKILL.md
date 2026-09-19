---
name: worktree-workflow
description: Create, use, and clean up Git worktrees for isolated repository changes without losing uncommitted work.
---

# Worktree Workflow

Use this skill when work needs an isolated checkout or when coordinating independent changes. Do not create a worktree merely for a small, single-file edit.

1. Inspect the current Git root, branch, existing worktrees, and working-tree state before creating anything.
2. Create a clearly named branch and worktree with Git. Keep project-local worktrees under `.codex/worktrees/` only when the target repository's `.gitignore` includes that path; otherwise use the repository's documented location. Do not rely on Claude-specific worktree commands or undocumented tool names.
3. Run commands in the intended worktree and report its path and branch when they matter to later steps.
4. Before cleanup, verify the exact worktree-to-branch mapping with `git worktree list`. Remove only the named, clean, merged worktree after confirmation when cleanup affects user work.
5. Never use forced removal or branch deletion to bypass uncommitted changes or unmerged commits.
