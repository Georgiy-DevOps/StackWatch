# Working on Pulsewatch

## User's standing instructions

- Communicate with the user in Russian.
- Record every completed change to this application in Git. Use a focused commit for each coherent change, after relevant checks pass.
- Push completed commits to the configured remote branch when available, unless the user asks to keep them local. If authentication or network access prevents a push, retain the local commit and report that clearly.
- Before editing, inspect Git status and preserve unrelated user changes. Never include unrelated changes in a commit.
- Do not force-push, rewrite committed history, or delete remote branches without explicit user instruction.

## Project

Pulsewatch is a self-hosted Node.js 24+ service. It uses built-in SQLite and has no npm dependencies. The browser dashboard is in `public/`, checks and persistence are in `lib/`, and deployment tools are in `deploy/`.

- Run `node --test test/*.test.mjs` for monitoring, persistence, authentication, or notification changes. For documentation and style changes use a proportional check.
- Keep `data/`, runtime `.env` files, tokens, SSH credentials, private keys, backup archives, and actual server addresses out of commits and distributable source archives. Example environment files may be committed.
- Preserve existing databases during updates. Test migration and restoration with copies.
- Linux SSH onboarding requires the user's interactive authentication. Do not request passwords or private keys in chat.
- Domain publishing and remote installation are distinct from preparing deployment files; report accurately what has actually run.
