# Agent instructions

Before editing this plugin, read `skills/creating-plugins/SKILL.md` completely. Codex discovers the same directory through `.agents/skills`; Claude discovers it through `.claude/skills` and reads these instructions through `.claude/CLAUDE.md`.
Keep `emdash-plugin.jsonc` aligned with the runtime implementation, declare every capability and host the plugin uses, and run the generated validation, typecheck, test, and build scripts after changes.

Project notes:
- Target EmDash 1.3.1 (`emdash`, `@emdash-cms/blocks`, `@emdash-cms/plugin-test` pinned to the matching versions). Check API changes against the installed types, not memory.
- `allowedHosts` in the manifest and `ENDPOINTS` in `src/indexnow.ts` must list the same hosts.
- Pure logic lives in `src/urls.ts` and `src/indexnow.ts` (unit tests in `tests/urls.test.ts`); host behaviour is tested through `createPluginRuntimeTestHost` in `tests/plugin.test.ts`. EmDash runs after-hooks as deferred tasks: tests call `settle()` after content actions.
- Bump `version` in package.json for every release, and always when capabilities, allowedHosts, storage or public routes change.
