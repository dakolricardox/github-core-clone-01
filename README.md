# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/dakolricardox/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/dakolricardox/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process, no dependencies:
git smart HTTP (upload-pack v2 + receive-pack v0), the GitHub REST v3 API, GraphQL v4
and a Model Context Protocol endpoint, all backed by one in-memory store with a
self-implemented git object and packfile layer (node:zlib / node:crypto only).

## Run it

```sh
node main.ts
```

The entry registers its ephemeral port with `$MAKEFUN_ENV_URL` and polls `/done`,
as the make.fun agent/v1 harness drives it (see `main.ts`). Tested end to end
against the competition kit's conformance suite: 120/120 checks pass.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
