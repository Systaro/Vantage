# Uploading Playwright runs to Vantage

A CI job runs Playwright and uploads the result to the hub: the JSON report (required) and the
zipped HTML report (optional). Vantage stores the run summary and every test case, shows them on the
environment's **Tests** tab, emits a `tests` event when a suite turns red or green again (design §5),
and serves the HTML report from the separate reports origin (design §6.5).

## 1. Set up a suite and a token

1. An admin opens the environment → **Einstellungen** → **Testsuiten & Upload-Tokens** and creates a
   suite (name, slug, optional description).
2. **+ Upload-Token erzeugen** creates an ingest token (`vti_…`) for that suite, optionally with a last
   valid day. The token is shown once; only its SHA-256 is stored. It can write runs of this one
   suite and read nothing. Revoking it stops uploads immediately.
3. In the GitLab project, add the token as a **masked** CI/CD variable `VANTAGE_TOKEN`. (Do not mark it
   protected unless only protected branches should upload: protected variables are missing in
   merge-request pipelines.)

## 2. Configure Playwright

Both reporters write files; the HTML reporter must not try to open a browser:

```ts
// playwright.config.ts
reporter: [["list"], ["json", { outputFile: "results.json" }], ["html", { open: "never" }]],
```

The HTML report lands in `playwright-report/` (Playwright's default).

## 3. Upload from GitLab CI

The settings page shows the same snippet with the hub URL filled in (`ciSnippet()` in
`src/hub/modules/tests/settings.tsx` is the single source).

```yaml
e2e:
  stage: test
  image: mcr.microsoft.com/playwright:v1.50.0-noble   # same version as @playwright/test
  script:
    - npm ci
    - npx playwright test
  after_script:
    - command -v zip >/dev/null || (apt-get update -qq && apt-get install -y -qq zip >/dev/null)
    - (cd playwright-report && zip -qr ../report.zip .)
    - >-
      curl --fail-with-body -sS
      -H "Authorization: Bearer $VANTAGE_TOKEN"
      -F report=@results.json
      -F html=@report.zip
      --form-string "commit=$CI_COMMIT_SHA"
      --form-string "branch=$CI_COMMIT_REF_NAME"
      --form-string "pipeline_url=$CI_PIPELINE_URL"
      --form-string "job_url=$CI_JOB_URL"
      https://<hub>/api/v1/test-runs
```

Notes:

- `after_script` runs even when the tests failed, which is when the upload matters most. A failing
  `after_script` does not fail the job, so a broken upload shows up only in the job log.
- `--fail-with-body` makes curl exit non-zero on 4xx/5xx and still print the hub's error message.
- `--form-string` sends the text fields literally (with `-F`, a value starting with `@` or `<` would
  be read as a file).
- Zip the *contents* of `playwright-report/` so that `index.html` is at the top of the archive. A zip
  of the folder itself (`playwright-report/index.html`) is accepted too.
- Without the HTML report, drop the two zip lines and `-F html=@report.zip`.

## 4. API reference

`POST /api/v1/test-runs`, `multipart/form-data`, `Authorization: Bearer vti_…`. The session cookie is
never read on this route.

| Field | Required | Content |
|---|---|---|
| `report` | yes | Playwright JSON reporter output, ≤ 50 MB |
| `html` | no | zipped Playwright HTML report, ≤ 150 MB |
| `commit` | no | commit SHA (letters, digits, `._-`, ≤ 64 chars) |
| `branch` | no | branch or tag, ≤ 200 chars |
| `pipeline_url`, `job_url` | no | `http(s)` URLs, ≤ 1000 chars; GitLab URLs also give the commit link |

Responses (JSON):

| Status | When |
|---|---|
| `201 {"id", "url", "status", "total", "failed"}` | stored; `url` is the run page in the hub |
| `400 {"error"}` | not multipart, `report` missing / not JSON / not a Playwright report, bad field, unacceptable zip |
| `401 {"error"}` | token missing, unknown, revoked or expired |
| `413 {"error"}` | a part exceeds its size limit, or more than 50 000 tests |

The token is checked before the body is read and again inside `ingest_test_run()` (the only way the
hub's database role can write runs), so a token revoked during an upload cannot write.

### HTML report limits

The zip is validated from its central directory before anything is written and extracted with a
running byte count, so a lying size header stops at the limit. Rejected: more than 20 000 files, more
than 500 MB uncompressed, absolute paths, `..` or `.` path segments, backslashes or control characters
in names, symbolic links and other non-regular entries, encrypted entries, compression other than
stored/deflate, ZIP64 and multi-part archives, archives without a top-level `index.html`.

### How a run is classified

Per test (one row per spec × project): the final status of the last attempt; `flaky` when it passed
only on a retry; the duration of the last attempt; the error of the most recent failed attempt,
without ANSI colour codes, capped at 60 lines / 4000 characters. Titles are the `describe` path plus
the test title joined with ` › `; the file is stored separately.

Per run: `failed` when any test failed unexpectedly, else `flaky` when any test was flaky, else
`interrupted` when a test was interrupted, the report has no results or it carries run-level errors
(e.g. a failed global setup), else `passed`. A run flipping a suite to `failed` emits a `firing` event
(“Tests rot: …”); the next non-failed run resolves it.

## 5. Viewing reports

The run page's **HTML-Report öffnen** goes through `/runs/:id/report`, which checks access under RLS
and redirects to a freshly signed link on the reports origin
(`REPORTS_URL/r/<run>/<expires>/<hmac>/index.html`). A link is valid for 15 minutes; while it is being
used (any file of the report requested within 15 minutes of the previous one) it stays valid, up to
two hours after it was issued. That extension is held in memory per hub process.

The reports origin sets no cookies, sends `Cache-Control: private, max-age=300`, `nosniff`,
`Referrer-Policy: no-referrer` and a CSP that allows the report's inline scripts and `data:`/`blob:`
media but no outside connections (`connect-src 'self'`), no framing and no form posts. Everything
outside `/r/…` on that host is 404.

HTML reports are deleted after 90 days (`purgeReports()`, run hourly by the worker); runs and test
cases are kept. Deleting a suite deletes its runs and report directories.

## 6. Scheduled runs

Scheduled test runs (e.g. a nightly smoke test against production) are triggered by **ops**, not by
the hub: ops holds the GitLab trigger tokens and calls the pipeline trigger API
(`POST /api/v4/projects/:id/trigger/pipeline` with `token`, `ref` and optional variables) on its cron
schedule (design §6.6). The triggered pipeline runs the same job as above and uploads like any other
run, so nothing in the hub distinguishes a scheduled run except the branch, pipeline and job links.

To run only the end-to-end job in triggered pipelines, add a rule to the jobs that should not run:

```yaml
rules:
  - if: $CI_PIPELINE_SOURCE == "trigger"
    when: never
  - when: on_success
```
