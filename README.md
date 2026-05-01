# pi-manage-dirs

Add external directories to your Pi workspace with **interactive path autocompletion**.

Type a path, press **Tab**, and navigate with breadcrumb-style suggestions — including `~/` home expansion.

## Install

From GitHub:

```bash
pi install git:github.com/localredhead/pi-manage-dirs
```

Or from npm (coming soon):

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

### Manage added directories

```
/add-dir ls         — list all added directories
/add-dir rm 0       — remove directory by index
```

## Why This Over Other Solutions?

- **Breadcrumb autocomplete** — type `~/` and Tab through subdirs without guessing full paths
- **Home expansion** — `~` works in both completions and the add handler
- **Zero overhead** — no filesystem scanning until you actually add a directory
- **Session persistence** — directories survive `/resume` and restarts

## License

MIT
