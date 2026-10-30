# hyperbeam-gateway

The public entry point to the three protocol processes on HyperBEAM: operator-registry, relay-rewards and staking-rewards. The HyperBEAM node itself is reachable only inside the cluster. The gateway accepts a fixed set of requests, checks each one, and makes its own request to the node for it. It never forwards a client's path, query string or headers, and it holds no keys.

The routes are the node's own paths, so a client written against the gateway also works against a node directly, and the reverse. A request the gateway refuses is answered with an HTTP error and a JSON body `{ "error": "<reason>" }`; a request it accepts is answered with the node's status, body, `content-type` and `slot` header.

## Routes

| Method | Path | Answer |
| ------ | ---- | ------ |
| `GET` | `/<process>~process@1.0/as/<view>` | a view listed under [Views](#views), with only that view's parameters |
| `POST` | `/<process>~process@1.0/push` | a signed message listed under [Messages](#messages) |
| `GET` | `/<process>~process@1.0/compute&slot=<slot>/results/output/data` | the result of a message this gateway sent; other slots answer `404` |
| `GET` | `/healthz` | health report |

`<process>` is one of the three configured process ids. Every other path answers `404`. Responses allow any origin and expose the `slot` header, so the dashboard can call the gateway from the browser.

## Views

Successful view answers are cached for `VIEW_CACHE_TTL`. Errors are not cached.

| Process | Views and parameters |
| ------- | -------------------- |
| operator-registry | `operator?address`, `operators`, `scoring`, `fingerprints?ids`, `status` |
| relay-rewards | `rewards?address&fingerprint`, `claimed?address`, `delegate?address`, `last_round`, `last_round_details?address&fingerprint`, `last_snapshot?redirect`, `status` |
| staking-rewards | `rewards?address`, `claimed?address`, `shares?address`, `last_round`, `last_round_data?address`, `last_snapshot`, `status` |
| all three | `roles`, `version` |

`address` is a 0x address, `fingerprint` a relay fingerprint (40 uppercase hex characters), `ids` up to 100 comma-separated fingerprints and `redirect` one of `true`, `false`, `1`, `0`. An unknown parameter, a repeated parameter or an invalid value answers `400`. `dump` is not served.

## Messages

A message is a raw ANS-104 data item sent with `content-type: application/ans104`, the format `@anyone-protocol/ao-client` produces. The gateway checks it in this order and stops at the first failure:

1. The body is at most `MAX_BODY_BYTES` and parses as an ANS-104 data item with an Ethereum signature (type 3).
2. The signature verifies, is in low-s form, and was made by the item's owner. The signer is the owner's checksummed address.
3. The item targets the process named in the path.
4. The `action` tag names an action listed below for that process. Every other action answers `403`, including `Add-Scores`, `Complete-Round`, `Claim-Rewards` and `Eval`.
5. The tags are exactly `type=Message`, `data-protocol=ao`, `variant=ao.N.1`, `action`, the action's own tags, and optionally `require-codec=application/json` and `ui-cache-key`. Tag names match in any case and may not repeat. The data has the shape the action takes.
6. A message whose id the gateway has already sent and the node accepted is answered with the recorded answer and not sent again. See [Message record](#message-record).
7. A signer may send `WRITES_PER_SIGNER_PER_MINUTE` messages a minute.
8. The signer is allowed to send the action, see below.

Then the gateway posts the item's original bytes to the node with only the `content-type` and `codec-device` headers.

### Operator actions

Always available. The gateway reads the signer's entry from operator-registry's `operator` view and applies the same rule the contract does, so a message the contract would reject never takes a slot.

| Process | Action | Tags | Data | Signer must |
| ------- | ------ | ---- | ---- | ----------- |
| operator-registry | `Submit-Fingerprint-Certificate` | `fingerprint-certificate` | none | have that fingerprint claimable |
| operator-registry | `Renounce-Fingerprint-Certificate` | `fingerprint` | none | have that fingerprint verified |
| relay-rewards | `Set-Delegate` | optional `address`, `share` (0 to 1) | none | be an operator |
| staking-rewards | `Set-Share` | none | `{ "Share": <number> }` | be an operator |

An operator is an address with at least one claimable or verified fingerprint. The contract still makes its own checks, for example a blocked address or a missing registration credit.

### Admin actions

Available only when listed in `ADMIN_ACTIONS`, as `<process>:<action>`, and only from a signer listed in `ADMIN_SIGNERS` who also holds the `admin` role or the role named after the action in that process's `roles` view. The `owner` is not accepted through the gateway.

| Process | Action | Tags | Data |
| ------- | ------ | ---- | ---- |
| operator-registry | `Admin-Submit-Operator-Certificates` | none | JSON array of `{ "f": <fingerprint>, "a": <address>, "hw"?: <boolean> }` |
| operator-registry | `Remove-Fingerprint-Certificate` | `fingerprint` | none |
| operator-registry | `Block-Operator-Address`, `Unblock-Operator-Address` | `address` | none |
| operator-registry | `Add-Registration-Credit`, `Remove-Registration-Credit` | `address`, `fingerprint` | none |
| operator-registry | `Add-Verified-Hardware`, `Remove-Verified-Hardware` | none | up to 1000 comma-separated fingerprints |
| relay-rewards | `Update-Configuration` | none | JSON object |
| relay-rewards, staking-rewards | `Cancel-Round` | `round-timestamp` | none |
| staking-rewards | `Update-Configuration`, `Update-Shares-Configuration` | none | JSON object |
| staking-rewards | `Toggle-Feature-Shares` | none | `{ "Enabled": <boolean> }` |
| all three | `Update-Roles` | none | `{ "Grant"?: { <address>: [<role>] }, "Revoke"?: { <address>: [<role>] } }`, addresses checksummed |

## Message record

The gateway records every message the node accepted in a SQLite file at `MESSAGE_STORE_PATH`: id, process, action, signer, slot and the node's answer. A message takes effect once: sending the same message again is answered from the record and does not reach the node. Because signing is deterministic, a client that retries a message gets the same id and the original answer.

The record must survive restarts and moves of the service. Messages accepted before a lost record are no longer recognised as repeats.

## Running locally

```sh
HB_URL=http://<node host:port> \
OPERATOR_REGISTRY_PROCESS_ID=<process id> \
RELAY_REWARDS_PROCESS_ID=<process id> \
STAKING_REWARDS_PROCESS_ID=<process id> \
bun run --filter hyperbeam-gateway dev
```

## Configuration

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `HB_URL` | required | the HyperBEAM node, reached inside the cluster |
| `OPERATOR_REGISTRY_PROCESS_ID`, `RELAY_REWARDS_PROCESS_ID`, `STAKING_REWARDS_PROCESS_ID` | required | the three process ids |
| `ADMIN_ACTIONS` | none | comma-separated `<process>:<action>` admin actions to accept |
| `ADMIN_SIGNERS` | none | comma-separated checksummed addresses allowed to send them; required when `ADMIN_ACTIONS` is set |
| `MESSAGE_STORE_PATH` | `data/messages.sqlite` | the message record |
| `VIEW_CACHE_TTL` | `30s` | how long a successful view answer is reused |
| `ROLES_CACHE_TTL` | `30s` | how long a process's roles are reused for admin checks |
| `NODE_READ_TIMEOUT` | `30s` | time allowed for a read from the node |
| `NODE_WRITE_TIMEOUT` | `60s` | time allowed for the node to accept a message |
| `MAX_BODY_BYTES` | `1048576` | largest message accepted |
| `WRITES_PER_SIGNER_PER_MINUTE` | `20` | messages a signer may send per minute |

Plus `PORT` and `LOG_LEVEL`, as for every service in this repository.
