# Contributing to Vantage

Thanks for taking the time. Bug reports, reproductions and small fixes help the
most at this stage.

## How this repository works

Vantage is developed in an internal repository at Systaro, and this GitHub
repository is published from it. Each public commit is a snapshot and lists
the internal changes it contains. That has two consequences for contributions:

- **Issues and discussions happen here.** Please open issues on GitHub.
- **Pull requests are welcome, but are not merged with the GitHub button.**
  A maintainer reviews the PR here, applies the change internally with you as
  co-author, and closes the PR with a link to the snapshot that contains it.

For anything bigger than a bug fix, open an issue first so we can agree on the
approach before you spend time on it.

## Running it locally

You need [Bun](https://bun.sh) and Docker with the compose plugin. The quick
start in the [README](README.md#quick-start) brings up Postgres,
Elasticsearch and Mailpit, migrates both databases and seeds a fictional demo
world.

## Rules the code follows

- **Every hub read of environment data goes through row-level security**
  (`rls(c, tx => …)` in `src/hub/db.ts`). A new table that holds environment
  data gets `environment_id`, RLS and a policy on `vantage_env_ids(level)`;
  machine writes go through `SECURITY DEFINER` functions. See
  `docs/design.md`, section 3.
- An environment the user may not see answers 404, never 403.
- Server-rendered `hono/jsx` with htmx. No inline `<script>`, no `style=`
  attributes (the CSP forbids both), no native `alert` / `confirm` / `prompt`.
- The UI is German with real umlauts; code, comments and docs are English.
- Schema changes are new files in `src/hub/migrations` (or `src/ops/migrations`)
  with the next free number. A migration that has run somewhere is never edited.

## Pull request checklist

- The change does one thing, and the description says why.
- `bun run typecheck` and `bun test` pass.
- UI changes come with a screenshot, in light and dark mode if colours changed.
- No secrets, customer data or real personal data in code, tests or
  screenshots. Tests and seeds use fictional organisations such as
  `nordwind.example` and `bergbau.example`.

## Security issues

Please do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

Vantage is source-available under the [Business Source License 1.1](LICENSE).
By contributing you agree that your contribution is licensed under the same
terms.
