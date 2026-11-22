# RayTrace skills

Two agent skills for [RayTrace](https://www.raytracer.si). Each skill is a folder with a `SKILL.md`. Copy the folder into the skills directory your agent reads. Keep the folder name, and keep `SKILL.md` at the top of that folder.

| Skill | When an agent should use it |
|---|---|
| `verify-agent-run` | Before risky or unattended work: run it in a RayTrace sandbox, then compare what the agent claims with what the sandbox recorded. |
| `audit-agent-trace` | A RayTrace trace or run already exists, and you want a short audit of suspicious activity. |

## Install

Copy each skill folder, not only the markdown file.

- **Claude Code:** `~/.claude/skills/` for every project, or `.claude/skills/` for one project.
- **Cursor:** `~/.cursor/skills/` or `.cursor/skills/`.
- **Codex:** `~/.codex/skills/`.

```sh
mkdir -p ~/.claude/skills ~/.cursor/skills ~/.codex/skills
cp -R skills/verify-agent-run skills/audit-agent-trace ~/.claude/skills/
cp -R skills/verify-agent-run skills/audit-agent-trace ~/.cursor/skills/
cp -R skills/verify-agent-run skills/audit-agent-trace ~/.codex/skills/
```

Restart the client if the new skill does not appear. The skills tell the agent how to use the RayTrace CLI and, when it is connected, the MCP server. Adding that server is separate: [docs/mcp.md](../docs/mcp.md).

Local sandboxes need no RayTrace account and upload nothing. Cloud sandboxes and hosted records are at [app.raytracer.si](https://app.raytracer.si). A tour of that dashboard is at <https://www.raytracer.si/dashboard-tour.html>.
