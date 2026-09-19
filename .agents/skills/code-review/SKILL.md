---
name: code-review
description: Review a change or branch for real correctness, security, test, and documentation risks without editing the code.
---

# Code Review

Use this skill when the user requests a review, or before accepting a consequential implementation change.

1. Establish the comparison point and inspect the complete relevant diff, not only the final commit message.
2. Trace affected behavior through callers, data boundaries, error paths, configuration, and tests. Before accepting a removal or simplification claim, verify that the relevant entry points and user-facing paths are covered. Prefer evidence from the implementation over stale documentation.
3. Focus on correctness, security, recovery from failure, concurrency, compatibility, validation, and meaningful test gaps. Include documentation or UI text only when it changes or misrepresents behavior.
4. Report findings first, ordered by severity. Each finding needs a specific file reference, the failure scenario, and a practical correction.
5. Do not turn style preferences into defects or create an unbounded review cycle. If no actionable issue remains, say so and name residual verification limits.

Use `code-reviewer` for the main pass. Add `adversarial-reviewer`, `documentation-reviewer`, or `java-reviewer` only for independent, relevant coverage. Reviewers do not edit or commit.
