# Token structures

The box uses three token families. All money is integer minor units; all
timestamps are integer seconds; all signed payloads use canonical JSON
(`canon()` in `core/gates.js`: keys sorted recursively).

## (a) Identity — pluggable (default: open)

The box never hard-requires one identity system. The merchant picks an
adapter in `settings.identity`:

- `open` (default): any agent may call; the agent asserts its own id.
- `es256-jwt`: generic ES256 JWT credentials. The merchant supplies the
  verification key and maps its own claim names (`claimNames`) and trust
  vocabulary (`trustMap`).

Default claims: `{ agent_id, iss, iat, exp, trust, scopes, jti }` where
`trust` is one of `open` | `verified` | `elevated`. A vendor system such as
Rider JWTs (`agent_id` / `clearance` L0–L4) is one optional configuration —
see `RIDER_PRESET` in `core/identity.js`:

```
{
  "adapter": "es256-jwt",
  "publicJwk": "<issuer public JWK>",
  "issuer": "rider",
  "claimNames": { "agentId": "agent_id", "trust": "clearance", "scopes": "scopes" },
  "trustMap": { "L0": "open", "L1": "open", "L2": "verified", "L3": "verified", "L4": "elevated" }
}
```

Verification (`verifyAgentJwt` in `core/tokens.js`):
1. three segments, valid JSON
2. `alg` must be exactly `ES256` — anything else is refused (no `none`, no RS256 confusion)
3. ES256 signature against the merchant's configured public key (JWK)
4. `exp` in the future (60s skew allowed), `iat` not in the future
5. agent id claim present, trust level known (after `trustMap` if given)
6. optional `iss` pin

Per-tool minimum trust (`settings.toolTrust`, defaults all `open`):

| tool | min trust (default) |
|---|---|
| browse_catalog | open |
| read_checkout | open |
| amend_checkout | open |
| seal_order | open |

## (b) Payment — x402

Follows the x402 wire shapes for the payment rail.

**402 response** (header `PAYMENT-REQUIRED` carries the same JSON):
```json
{
  "x402Version": 1,
  "error": "payment required",
  "accepts": [ { "x402Version": 1, "scheme": "exact", "network": "base",
                 "payTo": "0x...", "maxAmountRequired": "100000",
                 "asset": "0x833589fCD6eDb6E08f4c7c32D4f71b54bdA02913",
                 "resource": "/agentill/tools/invoke:seal_order",
                 "description": "agentill tool call: seal_order",
                 "mimeType": "application/json",
                 "outputSchema": { "..." },
                 "maxTimeoutSeconds": 300 } ]
}
```

**X-PAYMENT** (request header or body field):
```json
{
  "x402Version": 1, "scheme": "exact", "network": "base",
  "payload": {
    "signature": "0x...",
    "authorization": {
      "from": "0xbuyer", "to": "0xpayee", "value": "100000",
      "validAfter": "1759100000", "validBefore": "1759100300", "nonce": "abc123"
    }
  }
}
```

Verification (`verifyX402Payment`) is structural: scheme/network match,
payee equals `payTo` (case-insensitive), `value >= maxAmountRequired`,
`validAfter <= now <= validBefore`. The chain-signature check is an
injectable async hook (`hooks.verifySignature`) — the box never claims an
unverified payment settled.

The box's toll layer converts a charged quote into these requirements via
`quoteToX402()` (`core/tolls.js`).

## (c) State — signed checkout snapshots

Binds every agent action to the shared checkout object:

```
snapshot: { state, agent_id, tool, seq, iat, stateHash }
sig:      HMAC-SHA256(serverSecret, canon(snapshot))
stateHash: sha256(canon(state))
```

Verification (`verifySnapshot`):
1. constant-time HMAC compare
2. `stateHash` recomputed over `state` must match (tamper-evident)
3. `iat` within `maxAgeSec` (default 600s)
4. `seq` strictly greater than the last seen seq (replay-safe)

Snapshots are emitted on the SDK's `snapshot` event and returned from
`/acb/tools/invoke`. The buyer UI can re-render from any snapshot; the
merchant can audit them later.

## Buyer-confirmation challenges

Not a bearer token: a challenge binds one approval to one action.

```
challenge = HMAC-SHA256(serverSecret,
              canon({ tool, stateHash, buyerSessionId, exp }))
```

The server issues it with `confirmation_required`; the buyer approves in
the SDK modal; the SDK returns `{ challenge, exp, stateHash,
buyerSessionId, approved: true }`; the server re-verifies before executing.
`iat` is deliberately excluded from the signed body so the challenge
verifies identically at issue and redemption time.
