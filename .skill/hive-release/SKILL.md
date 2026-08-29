---
name: hive-release
description: Commit, push, deploy, verify, or roll back the HIVE WDL Worker. Use only when the user explicitly authorizes an external release action.
---

# HIVE Release

## Release target

- Worker directory: `workers/hive`
- WDL namespace: `lf`
- Control plane: `https://admin-run.jinapp.net`
- Live URL: `https://lf.run.jinapp.net/hive/`
- Worker name: `hive`
- CLI package used for the verified release path: `@wdl-dev/cli@1.7.1`

## Credentials

`workers/hive/.key` holds only the raw `ADMIN_TOKEN`. It is Git-ignored.

Never read it into output, display it, include it in a command transcript, commit it, or send it in chat. Check only that it is non-empty:

```bash
test -s workers/hive/.key
```

For a zsh user who needs to create it, first `cd workers/hive`, then run:

```zsh
read -rs 'token?WDL ADMIN_TOKEN: '; printf '\n'; umask 077; printf '%s' "$token" > .key; unset token
```

The `?` prompt syntax above is zsh-specific. Do not use Bash’s `read -p` form in zsh.

## Preconditions

1. The user explicitly asked to commit/push/deploy or roll back.
2. Inspect `git status --short`; stop on unrelated changes.
3. Run `node --check workers/hive/public/hive.js` and `git diff --check` for source changes.
4. Verify `.key` exists without printing it.
5. Commit only files in scope; record the resulting SHA before deployment.

## Standard release

From `workers/hive`, use the token only for the process that deploys:

```bash
ADMIN_TOKEN="$(<.key)" CONTROL_URL="https://admin-run.jinapp.net" WDL_NS="lf" \
  pnpm dlx @wdl-dev/cli@1.7.1 deploy . --ns lf
```

The command bundles, uploads, and promotes an immutable WDL version. A deploy is complete only when the CLI confirms the promoted version. On an unknown outcome, do **not** retry blindly: inspect the active version first.

Then verify the public page without credentials leaking:

```bash
curl --head --fail --silent --show-error https://lf.run.jinapp.net/hive/
```

After a code release, report the Git SHA, promoted `vN`, live URL, and HTTP result. Do not invoke the dashboard’s data-refresh endpoint unless the user specifically asks; it is an independent, authenticated side effect.

## Inspecting state

Use the same ephemeral environment pattern and run the CLI from `workers/hive`:

```bash
ADMIN_TOKEN="$(<.key)" CONTROL_URL="https://admin-run.jinapp.net" WDL_NS="lf" \
  pnpm dlx @wdl-dev/cli@1.7.1 workers --ns lf --json
```

Use this before a retry after timeout/transport failure and before a rollback. The installed CLI exposes `workers` for active/retained version inspection; it does not expose a guessed `promote` or `rollback` subcommand.

## Rollback

Rollback is an external production action and needs explicit user authorization.

1. Identify the last known-good Git SHA and inspect WDL state with `workers --json`.
2. Create a temporary detached worktree for that SHA. Do not reset, checkout, or overwrite the current working tree.
3. From the old worktree’s `workers/hive`, redeploy that source using the same ephemeral `.key` environment pattern.
4. Verify the live URL returns HTTP 200 and report the new promoted WDL version.
5. Remove only the temporary worktree after verification; never delete retained WDL versions as part of a rollback.

The WDL CLI documents immutable versions and promotion but this installed CLI has no direct version-promotion command. Re-deploying the exact known-good Git revision is the reproducible rollback path. Never invent an unverified control-plane API call.

## Do not do this

- Do not run `wrangler deploy`; it targets the wrong deployment surface.
- Do not use `npm` or `yarn` for this worker’s release setup; use `pnpm`.
- Do not put `ADMIN_TOKEN` into tracked files, shell history, logs, PR text, or user-visible responses.
- Do not delete a WDL worker/version, KV data, or secret to “roll back.”
