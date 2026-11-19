# Command reference

Setup and everyday use are in the [README](../README.md). `raytrace help`
shows these commands in the terminal.

| Command | What it does |
|---|---|
| `raytrace mcp` | the MCP server for your editor; see [Set up in your editor](mcp.md) |
| `raytrace sandbox create [--local] [--name <name>]` | copy this Git repository into a new sandbox, in the cloud or (`--local`) on this machine |
| `raytrace connect [id or name] [--claude \| --codex]` | open a terminal in a sandbox, optionally with an agent running in it |
| `raytrace sandbox list [--local]` | your sandboxes |
| `raytrace sandbox start\|stop <id or name>` | start or stop one; stopping keeps its files |
| `raytrace sandbox destroy <id or name>` | delete one. Cloud: `--keep-traces` (paid plans). Local: `--delete-logs` or `--keep-logs` |
| `raytrace setup [--yes] [--no-claude-code] [--no-start] [--openrouter-key <key>]` | first-time settings: adds the Claude Code hook (`--no-claude-code`: don't), saves your settings, then starts RayTrace (`--no-start`: don't; `--yes`: no prompts; `--openrouter-key` turns on local summaries) |
| `raytrace start` / `stop` / `status` | the local proxy and dashboard process: start it, stop it, or show whether it is running |
| `raytrace open` | open the local dashboard at `http://127.0.0.1:8797` and sign the browser in |
| `raytrace auth login\|status\|logout` | your RayTrace sign-in, for cloud sandboxes |
| `raytrace upload logs [--sandbox <name>]` | send a local sandbox's recorded logs to the cloud dashboard; `raytrace upload status` shows your storage |
| `raytrace share <trace-id> [--fork]` | a time-limited link to one recorded prompt; `--list`, `--revoke <share-id>` |
| `raytrace report <trace-id> [--pr <number>]` | a pull-request comment for one run: commands and exit codes, files changed, cost. Prints it, or posts it with `gh`; `--sandbox <rtp-id>` for a cloud run, `--link`, `--dry-run` |
| `raytrace export <trace-id> [--format json\|markdown] [--output <file>]` | export a recorded prompt to the terminal or a file, even with RayTrace stopped |
| `raytrace --code <code>` | redeem a beta invite code |
| `raytrace key [openrouter\|typesafe] [--remove]` | your keys for the dashboard's AI features |
| `raytrace doctor` | what this machine has and lacks |
| `raytrace uninstall [--purge] [--yes]` | stop RayTrace and remove the Claude Code hook; `--purge` also deletes the local sandbox VM and `~/.raytrace`; `--yes`: no prompts |
| `raytrace --version` (or `-v`) | print the installed version |
