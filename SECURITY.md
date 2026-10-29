# Security

## Reporting

Use GitHub's private vulnerability reporting on this repository (Security →
Report a vulnerability). If that is unavailable to you, mail
mark@afrotoss.com. Either way you get an acknowledgement within a week. There
is no further SLA: this is one operator's research project, not a product with
a response team.

## What is in scope

The stack's two security surfaces:

- **The module's control surface** (`module/`): the HTTP/WebSocket bridge it
  opens inside the worldserver. It is the only door into the game server, so
  what it serves, who may call it, and what a caller can reach that it should
  not are all in scope. `module/PROTOCOL.md` ("Authentication") is the
  authority on that surface and its two credential classes: the operator's port
  secret, and per-session lease secrets that reach one session and nothing else.
- **The snippet sandbox** (`mcp/src/sandbox/`): agent-written code runs in a
  child process with an allowlisted environment and a Linux Landlock ruleset
  that limits what it can read, which ports it can reach and what it can
  execute. The child's header (`mcp/src/sandbox/child.ts`) and
  `mcp/src/sandbox/confine.ts` say what a snippet may reach. Anything that lets
  a snippet read a credential, a file or a process it should not, or reach the
  network beyond the module's port, is a finding.

Also worth a report even though it is not a memory-safety bug: anything that
lets an agent observe or act beyond `docs/CONTRACTS.md`.

## What is not

AzerothCore and WoW 3.3.5a themselves; take those upstream. The stack is meant
to run against a private server whose game and module ports are never exposed
to a network anyone else is on.
