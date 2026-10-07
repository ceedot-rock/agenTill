# Security Policy

agenTill sits between AI agents and real money movement. A bug that lets
an agent spend money without buyer approval, double-spend an order,
replay a sealed snapshot, or tamper a receipt is a security issue,
not a normal bug.

## Reporting a vulnerability

Please do not open a public issue for security problems.

- Use GitHub's private vulnerability reporting on this repository
  (Security tab, "Report a vulnerability")
- Or email corey@slidphilabs.com with the subject line `agenTill security`

Include the affected file, steps or inputs to reproduce, and what you
expected versus what happened.

You can expect an acknowledgement within 3 business days. We will keep
you updated while we investigate and credit you in the changelog unless
you prefer to stay anonymous.

## In scope

- Buyer-approval bypass: any path where a money-moving action seals
  without explicit buyer confirmation
- Gate/scope bypass: an agent acting outside its granted scopes
- Snapshot or receipt tampering, replay of a sealed snapshot
- Pre-flight bypass: the box activating against a flow that failed checks
- The `agentill` npm package, the box middleware, and the demo server

## Out of scope

- Operator deployments we do not run (including the hosted demo store)
- Social engineering, spam, or denial-of-service against hosted demos
