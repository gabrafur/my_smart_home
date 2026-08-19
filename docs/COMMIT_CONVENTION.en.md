# Commit message convention

[Português (primary)](CONVENCAO_COMMITS.md) · [English](COMMIT_CONVENTION.en.md)

This repository uses Conventional Commits in English. The convention keeps the
history readable, searchable, and suitable for changelogs and automation,
including commits created by Codex or repository-owned routines.

The canonical example is:

```text
fix: make Codex card loading deterministic
```

## Format

```text
<type>[(optional-scope)][!]: <imperative description>

[optional body]

[optional footers]
```

The subject, or first line:

- must be written in English;
- must start with an allowed type;
- may include a lowercase scope in parentheses;
- must use an imperative description beginning with a lowercase word;
- must be no longer than 72 characters;
- must not end with a period, exclamation mark, or question mark;
- must describe one coherent change.

Proper names and acronyms retain their spelling after the first word, such as
`Home Assistant`, `Codex`, `Node-RED`, `RTX`, and `SSH`.

## Types

| Type | Use it for | Example |
| --- | --- | --- |
| `feat` | a user-visible capability or integration | `feat: add vehicle door lock action` |
| `fix` | a behavior correction, regression, or failure | `fix: recover Node-RED services after network startup` |
| `docs` | documentation-only changes | `docs: explain the commit convention` |
| `test` | tests that do not change product behavior | `test: cover commit subject validation` |
| `refactor` | code organization without external behavior changes | `refactor(codex): move detailed workflows into skills` |
| `chore` | maintenance, backups, or internal work without a direct feature effect | `chore: create automated smart home backup` |
| `ci` | continuous-integration pipeline or configuration changes | `ci: validate commit subjects on every push` |
| `build` | build, packaging, or dependency changes | `build(nodered): update runtime dependencies` |
| `perf` | performance improvements that preserve the functional contract | `perf: reduce dashboard history queries` |
| `revert` | reverting an earlier change | `revert: remove vehicle lock action` |

Choose the type from the commit's primary effect, not merely from the files it
touches. A bug fix with tests remains `fix`; a feature with documentation
remains `feat`.

## Scope

The scope is optional. Use it only when naming the subsystem makes the subject
clearer without opening the diff. It must begin with a lowercase character and
may contain numbers, `.`, `_`, `/`, or `-`.

```text
fix(homeassistant): prevent DNS outage on container recreation
feat(nodered): add vehicle door lock action
docs(creta): document refresh and update runbook
```

Avoid generic scopes such as `app`, `code`, or `misc`. Omit the scope when a
change spans subsystems and has one clear primary effect.

## Breaking changes, body, and footers

Place `!` immediately before `:` when consumers must take action to adopt a
change. Explain the incompatibility and migration in a `BREAKING CHANGE:`
footer.

```text
feat(bindings)!: require logical roles in public configuration

Replace physical identifiers with the documented logical role names.

BREAKING CHANGE: existing private bindings must be migrated before startup.
```

Use the body for motivation, decisions, risks, and details that do not fit in
the subject. Separate the subject, body, and footers with a blank line. Do not
use the body to compensate for a vague subject.

## Automated commits and merges

Scripts that create commits follow the same contract. Git backup uses
`chore: create automated smart home backup`; the date, author, and hash already
exist in commit metadata and do not need to clutter the subject.

Platform-generated merge commits may retain their automatic message and are
skipped by the mechanical check. For a manually written merge message, prefer
a conventional form such as `chore: integrate storage maintenance`.

## Validation

Validate a subject before creating a commit:

```bash
node scripts/commit-message-check.mjs --subject \
  'fix: make Codex card loading deterministic'
```

Validate the current commit or a range:

```bash
make validate-commit-message
node scripts/commit-message-check.mjs origin/main..HEAD
```

`make validate-public` includes validation of `HEAD`, and CI runs that target
for pushes and pull requests. The checker enforces the structure, allowed
types, scope, length, and punctuation. English, imperative mood, and semantic
accuracy remain review requirements for humans and Codex because a regular
expression cannot determine them reliably.

## Quick checklist

Before committing, confirm that:

1. the type represents the primary effect;
2. the subject is in English and uses the imperative mood;
3. the description's first word starts in lowercase;
4. the subject is at most 72 characters and has no trailing punctuation;
5. the scope, when present, adds useful context;
6. breaking changes include `!`, an explanation, and migration guidance;
7. the body and footers preserve useful context without private data.
