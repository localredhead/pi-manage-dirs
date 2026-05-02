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

### Unified `/manage-dirs` command

Everything lives under one command with subcommand routing and Tab completion:

```
/manage-dirs                  ← interactive suggestions
/manage-dirs ~/org            ← add a directory (Tab to navigate)
/manage-dirs ls               ← list added directories
/manage-dirs rm 0             ← remove by index
/manage-dirs rm org           ← remove by label
/manage-dirs suggest          ← scored project-aware suggestions
/manage-dirs help             ← show all subcommands
```

### Tab completion

When typing a path after `/manage-dirs`, press **Tab** to navigate directory trees:

```
/manage-dirs ~/          Tab → browse home dirs
/manage-dirs ~/Doc       Tab → ~/Documents/
```

## How It Works

When you add a directory, pi-manage-dirs scans it for:

| File | Locations checked |
|------|-----------------|
| `AGENTS.md` | `<dir>/AGENTS.md`, `<dir>/.pi/AGENTS.md` |
| `CLAUDE.md` | `<dir>/CLAUDE.md`, `<dir>/.pi/CLAUDE.md` |
| Skills | `<dir>/.pi/skills/*/SKILL.md`, `<dir>/.agents/skills/*/SKILL.md`, `<dir>/.claude/skills/*/SKILL.md` |

Context files are injected into the system prompt on every turn (cached). Skills are registered natively via `resources_discover`.

## Smart Suggestions

Run `~` or `/manage-dirs suggest` to get project-aware recommendations:

- Sibling projects in the same git repo
- Local dependencies (`file:`, `link:`, `portal:` in package.json, `path:` in Cargo.toml, etc.)
- Workspace members (npm, pnpm, Cargo, Go, uv)
- Directories with AGENTS.md/CLAUDE.md or skills

## Features

- **Breadcrumb autocomplete** with `~/` home expansion
- **Smart suggestions** from project structure analysis
- **AGENTS.md / CLAUDE.md** context injection
- **Skill registration** from external directories
- **Status widget** showing active directories
- **LLM tools**: `add_directory`, `search_external_files`
- **Session persistence** across `/resume` and restarts
- **Zero overhead** when no directories are added

## License

MIT
