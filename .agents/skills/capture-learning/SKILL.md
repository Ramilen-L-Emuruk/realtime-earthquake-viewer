---
name: capture-learning
description: Extract a reusable, non-obvious lesson from completed work into a focused repository or personal Codex skill.
---

# Capture Learning

Use this skill after resolving a non-trivial, repeatable problem. Do not use it for a typo, a one-off outage, or generic advice.

1. Identify the durable lesson: the trigger, root cause or decision context, the reliable approach, and boundaries where it should not apply.
2. Decide scope. Put team or repository knowledge in `.agents/skills/<skill-name>/SKILL.md`; use a personal skill location only for knowledge that should not be committed.
3. Draft a concise skill with `name` and a discriminating `description`. Include only facts that change future decisions; do not copy a session transcript.
4. Show the proposed name, scope, and content before creating or replacing a skill. Write it only after the user confirms.
5. Validate the frontmatter and ensure the new skill has no credentials, local paths, or accidental project secrets.
