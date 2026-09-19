---
name: development-workflow
description: Plan and implement a non-trivial repository change with evidence-based scoping, tests, review, and proportionate verification.
---

# Development Workflow

Use this skill for multi-step features, defects, refactors, or configuration changes. Do not use it for a one-line factual answer or a trivial isolated edit.

1. Inspect the repository before choosing an approach. Reuse established patterns, trace callers and configuration when removal or replacement is proposed, and verify library behavior from primary documentation when it matters.
2. For work with multiple phases or architectural impact, make a concise plan with affected files, risks, validation, and any decision that requires user input. Treat the confirmed scope and completion criteria as binding; explain the evidence and obtain confirmation before reducing them. Use `code-explorer`, `implementation-planner`, or `architect` when the work can be independently investigated.
3. Implement the smallest change that satisfies the confirmed requirement. Add or update tests that demonstrate the intended behavior and relevant failure cases.
4. Run the appropriate build, tests, lint, static checks, and focused reproduction. When user-visible runtime behavior changes, perform a safe behavior-level check as well. State what was run, what was not run, and why.
5. For consequential changes, request read-only review from `code-reviewer`; use `adversarial-reviewer`, `documentation-reviewer`, `java-reviewer`, or `verifier` only when their focus applies. Fix actionable findings, then revalidate the affected paths. Stop once the proportionate review is complete; report residual risks instead of starting an unbounded review loop. Parallelize only independent read-only work.
6. Update user-facing documentation, configuration references, and comments when behavior or usage changed.

Do not commit, push, merge, publish, add production dependencies, or make external changes unless the user has authorized that action.
