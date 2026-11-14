---
name: hub
description: Share one plans history across your machines through a self hosted hub that stores only ciphertext. Install it with ./install.sh --with hub, which writes HUB_URL and HUB_NETWORK and walks you through joining or starting a hub.
disable-model-invocation: true
optional: true
---

# Hub

The hub carries plans events, revisions and leases between the operator's enrolled machines. It holds ciphertext, public keys and signatures, never a key, so everything an agent reads still comes from the local store, and every plans verb works offline as it always has. `HUB_URL` and `HUB_NETWORK` come from the environment first, then skills.conf. With no URL, no verb touches the network.

## Verbs an agent runs

- `skills hub status` prints the hub, this device, the chain and the queues, or `no hub configured` with exit 1, or `not enrolled`. Its `offline:` and `fork detected` lines are what to report when sync looks stale.
- `skills hub sync` pushes and pulls now, with a longer budget than the sync every write verb already runs. Exit 75 with a `left` line is progress: run it again until it exits 0, and quote the `left` line to the operator if it stops shrinking between runs. A `held <n> blobs` line waits on the operator to upgrade the hub, while a sync that names an event, blob or chunk too slow to send exits 1 and needs a rerun from a faster network: report either one and move on. A `quarantined` line waits on the operator: never pass `--publish-quarantine` yourself.
- `skills hub devices` lists the enrolled and revoked devices.
- `skills hub join <url> <invite>` enrolls this machine with the line `skills hub invite` printed on another one. Run it only with a line the operator gave you in this task.

## Verbs that ask the operator

`skills hub init`, `skills hub invite`, `skills hub revoke`, `skills hub recover`, `skills hub recovery rotate` and `plans lease break` change who can read the vault or who holds a plan. They carry no allow rule. Never run one on your own initiative: name the command and what it changes, and let the operator run it. `init` and `recovery rotate` print a recovery code once, and that code is full vault authority, so never copy it into a reply, a file or a log.

## Setting it up

`./install.sh --with hub` at a terminal asks whether to join an existing hub or start a new one, the network mode and the URL. Joining asks for the invite line and runs the join. Starting one prints the `docker compose` command for the mode, from the files in `apps/hub/`, and the `skills hub init` step that follows it. Without a terminal, `--hub-url <url>` and `--hub-network public|tailscale|local` write the two keys and print the enrollment step. `./install.sh --without hub` removes both keys.
