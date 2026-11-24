# Archived root probes

These four Rumeng diagnostic scripts and the historical AgentRouter handoff were
moved out of the repository root while preserving their existing contents. They
are historical material, not current provider policy or startup entrypoints.

- The scripts are still invoked from the repository root, for example
  `node _sandbox/archived-root-probes/.owner-log-tmp.js`.
- Their existing emailnator imports now resolve relative to this directory.
- Invoking a probe can contact external providers or create accounts. They are
  NOT part of isolated acceptance and were not run during this cleanup.
- The AgentRouter handoff is historical; use the current project/wiki canons
  instead of treating it as active routing or credential instructions.
- Local-only JSON/config backups and other ignored root artifacts were moved to
  `backups/root-cleanup-20261124-005056/`, not deleted or added to Git. That folder
  contains the inventory with original locations, sizes and hashes.

No commit, push, production restart or owner-settings migration was performed.
