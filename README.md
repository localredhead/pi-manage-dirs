# pi-manage-dirs

Add external directories to your Pi workspace with **interactive path autocompletion**, AGENTS.md/CLAUDE.md loading, and skill registration.

Type a path, press **Tab**, and navigate with breadcrumb-style directory suggestions — including `~/` home expansion.

## Install

```bash
pi install git:github.com/localredhead/pi-manage-dirs
```

Or from npm:

```bash
pi install npm:pi-manage-dirs
```

Then `/reload` in Pi.

## Usage

### Add directories with Tab completion

```
/add-dir ~/        ← press Tab to browse your home directory
/add-dir ~/Doc     ← press Tab to autocomplete to ~/Documents/
/add-dir /usr/local/
```

### Commands

| Command | Description |
|---------|-------------|
| `/add-dir <path>` | Add a directory with path Tab completion |
| `/add-dir ls` | List all added directories |
| `/add-dir rm <index>` | Remove directory by index |
| `/dirs` | List external directories with context details |
| `/remove-dir [path]` | Remove a directory (interactive picker or tab-completion) |

### LLM Tools

The agent can request adding directories on its own:

| Tool | Description |
|------|-------------|
| `add_directory` | Add an external directory (loads AGENTS.md, skills, etc.) |

## What You See When Adding a Directory

When you add a directory, pi-manage-dirs scans it for:

| File | Location checked |
|------|-----------------|
| `AGENTS.md` | `<dir>/AGENTS.md`, `<dir>/.pi/AGENTS.md` |
| `CLAUDE.md` | `<dir>/CLAUDE.md`, `<dir>/.pi/CLAUDE.md` |
| Skills | `<dir>/.pi/skills/*/SKILL.md`, `<dir>/.agents/skills/*/SKILL.md`, `<dir>/.claude/skills/*/SKILL.md` |

Context files are injected into the system prompt on every turn (cached — filesystem is only re-scanned when directories change).

Skills are registered natively with Pi via the `resources_discover` event.

## Features

- **Breadcrumb autocomplete** — type `~/` and Tab through subdirs without guessing full paths
- **Home expansion** — `~` works in both completions and the add handler
- **Context injection** — AGENTS.md and CLAUDE.md from added directories are loaded into the agent's system prompt
- **Skill registration** — skills discovered in added directories work as `/skill:name` commands
- **Status widget** — shows active external directories above the editor
- **LLM tool** — the agent can request adding directories on its own via `add_directory`
- **Session persistence** — directories survive `/resume` and restarts
- **Caching** — filesystem is only re-scanned when directories are added/removed, not on every turn

## Why This Over Other Solutions?

- **Breadcrumb autocomplete** — type `~/` and Tab through subdirs without guessing full paths
- **Zero-overhead** — no filesystem scanning until you actually add a directory
- **Full feature parity** — matches existing packages' AGENTS.md loading, skill registration, and LLM tools

## License

MIT
