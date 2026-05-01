# pi-manage-dirs

Add external directories to your Pi workspace with **interactive path autocompletion**, **smart suggestions**, AGENTS.md/CLAUDE.md loading, and skill registration.

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

### Smart suggestions

Run `/add-dir` with no arguments to see project-aware suggestions:

- Sibling projects in the same git repo
- Local dependencies (`file:`, `link:`, `portal:` in package.json, `path:` in Cargo.toml, etc.)
- Workspace members (npm, pnpm, Cargo, Go, uv, etc.)
- Directories with AGENTS.md/CLAUDE.md or skills

### Commands

| Command | Description |
|---------|-------------|
| `/add-dir <path>` | Add a directory with path Tab completion |
| `/add-dir` (no args) | Interactive mode with smart suggestions |
| `/add-dir ls` | List all added directories |
| `/add-dir rm <index>` | Remove directory by index |
| `/dirs` | List external directories with context details |
| `/remove-dir [path]` | Remove a directory (interactive picker or tab-completion) |
| `/suggest-dirs` | Show scored directory suggestions based on project structure |

### LLM Tools

| Tool | Description |
|------|-------------|
| `add_directory` | Add an external directory (loads AGENTS.md, skills, etc.) |
| `search_external_files` | Search for files across external directories by name pattern |

The agent can request adding directories on its own:
> "I need to reference the shared library — let me add it."

And search across external dirs:
> "Let me search for config files across the external directories."

## How It Works

When you add a directory, pi-manage-dirs scans it for:

| File | Locations checked |
|------|-----------------|
| `AGENTS.md` | `<dir>/AGENTS.md`, `<dir>/.pi/AGENTS.md` |
| `CLAUDE.md` | `<dir>/CLAUDE.md`, `<dir>/.pi/CLAUDE.md` |
| Skills | `<dir>/.pi/skills/*/SKILL.md`, `<dir>/.agents/skills/*/SKILL.md`, `<dir>/.claude/skills/*/SKILL.md` |

Context files are injected into the system prompt on every turn (cached — filesystem is only re-scanned when directories change).

Skills are registered natively with Pi via the `resources_discover` event, so they appear as `/skill:name` commands with full autocomplete support.

## Features

- **Breadcrumb autocomplete** — type `~/` and Tab through subdirs without guessing full paths
- **Smart suggestions** — project-aware recommendations based on dependencies, workspace structure, git repos, and context files
- **Context injection** — AGENTS.md and CLAUDE.md from added directories are loaded into the agent's system prompt
- **Skill registration** — skills discovered in added directories work as `/skill:name` commands
- **Status widget** — shows active external directories above the editor
- **LLM tools** — the agent can request adding directories (`add_directory`) and search files across them (`search_external_files`)
- **Session persistence** — directories survive `/resume` and restarts
- **Caching** — filesystem is only re-scanned when directories are added/removed, not on every turn
- **Zero overhead when empty** — hooks return early if no directories are added

## License

MIT
