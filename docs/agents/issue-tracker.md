# GitHub issues

Track issues and PRDs in GitHub Issues. Run `gh` from the repository clone so it selects the repository from the Git remote.

Read an issue's body, comments, and labels before acting. When a skill asks to publish to the issue tracker, create an issue. When it asks to fetch a ticket, use `gh issue view <number> --comments` and include its labels.

## Pull requests

**PRs as a request surface: no.**

Triage issues. Review pull requests as proposed code changes. Issues and pull requests share a number space: resolve a bare `#42` with `gh pr view 42`, falling back to `gh issue view 42`.

## Wayfinding

For `/wayfinder`, use one map issue with child issues as tickets.

- Map: create an issue labelled `wayfinder:map` with Notes, Decisions-so-far, and Fog sections. Use `gh issue create --label wayfinder:map`.
- Child ticket: link the issue as a GitHub sub-issue through `gh api`. If sub-issues are unavailable, add it to a task list in the map and put `Part of #<map>` at the top of its body. Apply `wayfinder:<type>` with `research`, `prototype`, `grilling`, or `task`. Assign claimed tickets to the developer doing the work.
- Blocking: use GitHub issue dependencies. Add a blocker with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`. Obtain the numeric database ID with `gh api repos/<owner>/<repo>/issues/<n> --jq .id`; the issue number and `node_id` are different identifiers. `issue_dependencies_summary.blocked_by` counts open blockers. If dependencies are unavailable, put `Blocked by: #<n>, #<n>` at the top of the child body. A ticket is unblocked when every blocker is closed.
- Frontier query: list the map's open children with `gh issue list --state open`, scoped to its sub-issues or task list. Exclude assigned tickets and tickets with open blockers. Select the first remaining ticket in map order.
- Claim: make `gh issue edit <n> --add-assignee @me` the session's first write.
- Resolve: run `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`. Add the answer's gist and issue link to the map's Decisions-so-far section.
