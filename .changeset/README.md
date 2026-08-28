# Changesets

Every user-visible change should include a changeset. Run `pnpm changeset`, select
the release type, and describe the change from a package user's perspective.

Changes that do not affect the published package can use `pnpm changeset --empty`.
The release workflow collects changesets into a version pull request and publishes
the package after that pull request is merged.
