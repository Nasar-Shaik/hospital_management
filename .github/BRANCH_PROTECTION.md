# Branch protection for `main`

What Doc 09 §16 ("no direct pushes to `main`") and RELEASE_MANAGEMENT §1 ("branch protection —
reviews + green CI required") mean in concrete settings, and the order to apply them in.

Nothing here has been applied. `main` is currently **unprotected** (`"protected": false`, no
required status checks), and that is the correct state today — see step 1.

---

## The sequence matters more than the settings

### 1. Now — protection OFF, deliberately

GitHub Actions **cannot run on this account**: every job is rejected before its first step with
_"The job was not started because your account is locked due to a billing issue."_

Requiring a status check that can never report would make `main` **permanently unmergeable** — a
worse position than no protection, and one that is confusing to diagnose from the merge button. So:
do not enable protection until a run has actually gone green.

### 2. After the first green run — protection ON

Apply the settings below. Confirm the required check's name first (§ "The check is called `ci`").

### 3. When there is more than one maintainer — add review

Add `required_approving_review_count: 1` and set `enforce_admins: true`. **Not before** — see the
warning in that section, which is the trap that quietly bricks a solo repository.

---

## The check is called `ci`

The workflow is `name: CI` and its single job is `ci:` with no `name:` of its own, so the status
check GitHub reports is the **job** id — `ci`, lowercase. Required-check names are matched as exact
strings; `CI` will silently never match and the branch will wait forever.

Confirm it from the first green run rather than trusting this paragraph:

```bash
gh api repos/Nasar-Shaik/hospital_management/commits/main/check-runs --jq '.check_runs[].name'
```

## Settings to apply (step 2)

```bash
gh api -X PUT repos/Nasar-Shaik/hospital_management/branches/main/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["ci"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
```

| Setting                            | Why                                                                                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `required_status_checks.contexts`  | The release gate. Without this the rest is etiquette.                                                                                                                                                                     |
| `strict: true`                     | The branch must be up to date with `main` before merging — otherwise two PRs that are each green can break `main` together.                                                                                               |
| `enforce_admins: false`            | **Deliberate while solo.** `true` would stop the only maintainer landing a sev-1 hotfix (RELEASE_MANAGEMENT §5). Flip it to `true` in step 3.                                                                             |
| `required_pull_request_reviews`    | `null` **deliberately while solo** — see the warning below.                                                                                                                                                               |
| `required_linear_history`          | Matches the documented squash-merge flow; keeps `git log main` readable.                                                                                                                                                  |
| `allow_force_pushes: false`        | `main` has already been reset once — PR #1 was merged on 2026-07-17 and its merge commit is unreachable from any ref today. This is the setting that prevents a repeat, and the reason it is not merely theoretical here. |
| `required_conversation_resolution` | A review comment that is merged unanswered was not a review.                                                                                                                                                              |

### ⚠️ Do not require reviews on a single-maintainer repository

GitHub does not let you approve your own pull request. With
`required_approving_review_count: 1` and one maintainer, **nothing can ever be merged** — the PR
sits waiting for an approval no one is able to give, and the only escape is to turn the setting back
off. Add it in step 3, together with the second maintainer, not before.

## Repository-level settings that pair with this

Branch protection does not cover these; they live under repository settings.

```bash
gh api -X PATCH repos/Nasar-Shaik/hospital_management \
  -F allow_squash_merge=true \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true \
  -f squash_merge_commit_title=PR_TITLE \
  -f squash_merge_commit_message=PR_BODY
```

`squash_merge_commit_title=PR_TITLE` is the one that is easy to miss and load-bearing: CI lints the
**pull request title** with commitlint precisely because a squash-merge turns that title into the
commit message on `main`. Under GitHub's other option, `COMMIT_OR_PR_TITLE`, a single-commit PR uses
the _commit_ message instead — and then the thing CI validated is not the thing that lands, so the
conventional-commit history that release notes are assembled from (RELEASE_MANAGEMENT §3) quietly
stops being guaranteed.

## Verifying afterwards

```bash
gh api repos/Nasar-Shaik/hospital_management/branches/main --jq '.protected'
gh api repos/Nasar-Shaik/hospital_management/branches/main/protection \
  --jq '{checks: .required_status_checks.contexts, strict: .required_status_checks.strict,
         linear: .required_linear_history.enabled, force: .allow_force_pushes.enabled}'
```

Then falsify it, because a protection rule you have not seen refuse anything is a rule you are
guessing about:

```bash
git push origin main --force-with-lease   # must be REFUSED
```
