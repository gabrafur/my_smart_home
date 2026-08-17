# Recommended GitHub repository settings

[Português](GITHUB_REPOSITORY_SETTINGS.md) · [English](GITHUB_REPOSITORY_SETTINGS.en.md)

This is an operational checklist, not settings as code. The current state was
read through the GitHub API during P3; no remote option was changed. Recheck it
in the UI before applying recommendations.

## Observed and recommended state

| Area | Observed | Recommended | Why |
| --- | --- | --- | --- |
| Template repository | off | **enable** | makes “Use this template” the path to a separate installation |
| `main` protection/ruleset | no protection or ruleset | create an active ruleset for `main` | blocks accidental force-push and deletion |
| Required pull request | not required | require for contributors; preserve an explicit owner bypass only if the direct personal workflow remains | external work is reviewed without silently changing owner practice |
| Required check | none | require **Canonical public validation** after confirming its displayed PR name | aligns merges with `make validate-public` |
| Linear history | not required | require | simplifies audit and commit-based recovery |
| Force-push/deletion | possible without a rule | block | protects history and the default branch |
| Merge strategies | merge commit, squash, and rebase on | keep **squash**; turn merge commits off; rebase optional | reduces combinations and keeps history focused |
| Delete branch on merge | off | enable | removes merged contribution branches |
| Private vulnerability reporting | off | enable | provides the private channel named by `SECURITY.md` |
| Actions | on; all actions allowed; SHA pinning not required | allow GitHub/verified actions or a minimal allowlist; require SHA pinning if supported | reduces supply-chain exposure |
| Default workflow permission | read; workflows cannot approve PRs | keep | least privilege |
| Dependabot alerts/security updates | off | enable graph, alerts, and security updates; consider weekly version updates | finds vulnerabilities in lockfiles |
| Secret scanning/push protection | off | enable features available to a public repository | complements local scanners |
| Topics | 9 relevant topics | keep; consider `self-hosted`, `observability`, `disaster-recovery` | improves discovery without fabricated claims |
| Description | present and accurate | keep | accurately identifies the stack and event-driven design |
| Homepage | empty | optional: a real published documentation site | do not invent a site |
| Social preview | not exposed by the checked API | upload `docs/assets/github-social-preview.png` | synthetic, legible identity |
| Releases | no documented policy | reserve for restorable snapshots or meaningful changes | avoids artificial cadence |
| Wiki | on | turn off | versioned `docs/` is authoritative |
| Projects | on | turn off while unused publicly | removes an empty surface |
| Discussions | off | keep off until a moderated community exists | avoids an unattended channel |
| Issues | on | keep | sanitized forms guide reports |

## Suggested `main` ruleset

1. Target the default branch and set enforcement to **Active**.
2. Block deletion and force-push; require linear history.
3. Require pull requests for external participants and one approval whenever
   another reviewer is available.
4. Require resolved conversations and an up-to-date branch before merge.
5. Require `Canonical public validation` and reject stale status.
6. If direct owner pushes remain, give bypass to that owner only—not generic
   GitHub Apps or all administrators.

The bypass is an explicit operational decision; it is not a claim of complete
branch protection. CI still runs on every push.

## Template versus fork

- **Use this template** starts an independent smart-home repository. Replace
  bindings, modules, and private state without preserving a contribution link.
- **Fork** is for changes proposed back to this project. Keep examples
  synthetic, work on a branch, and follow [CONTRIBUTING](../CONTRIBUTING.md).

After enabling the template setting, test it with no real data:

```bash
git clone NEW_REPOSITORY_URL smart-home
cd smart-home
make bootstrap-test
make validate-public
make demo-test
```

`make bootstrap` is a separate deliberate step: it creates missing private
templates only and cannot reproduce the original household.

## Manual UI checklist

- [ ] Settings → General → enable **Template repository**.
- [ ] Settings → Rules → create and activate the ruleset above.
- [ ] Settings → General → adjust merge methods and automatic branch deletion.
- [ ] Settings → Security → enable private vulnerability reporting, Dependabot
  alerts/security updates, and available scanners.
- [ ] Settings → Actions → General → restrict actions and keep workflow default
  permissions read-only.
- [ ] About → upload the social preview; review topics, description, homepage.
- [ ] Turn Wiki/Projects off if they remain unused; keep Discussions off.

Do not require a check until it has appeared on a pull request. A mistyped
context can block every merge.
