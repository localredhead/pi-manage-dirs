/**
 * /add-dir Extension for Pi
 *
 * Adds a slash command to expand Pi's contextual awareness
 * to additional directories with interactive path autocompletion.
 *
 * Usage:
 *   /add-dir <path>     — add a directory (with Tab completion)
 *   /add-dir ls         — list added directories
 *   /add-dir rm <index> — remove directory by index
 */
import type { ExtensionAPI, AutocompleteItem } from "@mariozechner/pi-coding-agent";
import { readdir } from "node:fs/promises";
import { resolve, dirname, join, isAbsolute } from "node:path";

// ——— helpers ———

/** Expand leading "~" (or "~/...") to the user's home directory. */
function expandTilde(p: string): string {
  const home = process.env.HOME ?? "";
  if (p === "~") return home;
  if (p.startsWith("~/")) return home + p.slice(1); // use concat, not join (join treats "/" as absolute)
  return p;
}

export default function (pi: ExtensionAPI) {
  // State: directories added to Pi's workspace
  let allowedDirs: string[] = [];

  // ——— Persistence ———

  pi.on("session_start", async (_event, ctx) => {
    allowedDirs = [];
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "add-dir-state") {
        const data = (entry as { data?: { dirs: string[] } }).data;
        if (data?.dirs) allowedDirs = [...new Set(data.dirs)];
      }
    }
    if (allowedDirs.length > 0) {
      ctx.ui.notify(
        `Loaded ${allowedDirs.length} context director${allowedDirs.length === 1 ? "y" : "ies"}`,
        "info"
      );
    }
  });

  const persistState = () => {
    pi.appendEntry("add-dir-state", { dirs: [...allowedDirs] });
  };

  // ——— Autocompletion ———

  async function listDirectory(
    dirPath: string,
    filter = "",
    /** Rebase absolute paths to this prefix (e.g. "~/" keeps completions in tilde form). */
    rebasePrefix = ""
  ): Promise<AutocompleteItem[]> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const items: AutocompleteItem[] = [];

      for (const entry of entries) {
        if (filter && !entry.name.toLowerCase().startsWith(filter.toLowerCase())) {
          continue;
        }
        const isDir = entry.isDirectory();
        let value = join(dirPath, entry.name) + (isDir ? "/" : "");
        // Rebase: if dirPath is absolute and user typed ~/..., swap back to ~/...
        if (rebasePrefix && dirPath.startsWith("/")) {
          value = rebasePrefix + value.slice(dirPath.length);
        }
        items.push({
          value,
          label: `${isDir ? "📁" : "📄"} ${entry.name}`,
        });
      }

      // Sort: directories first, then files, each alphabetically
      items.sort((a, b) => {
        const aIsDir = a.value.endsWith("/");
        const bIsDir = b.value.endsWith("/");
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
        return a.label.localeCompare(b.label);
      });

      return items;
    } catch {
      return [];
    }
  }

  function getCompletions(prefix: string, cwd: string): Promise<AutocompleteItem[]> {
    const trimmed = prefix.trim();
    if (!trimmed) return listDirectory(cwd);

    const expanded = expandTilde(trimmed);
    const fullPath = isAbsolute(expanded)
      ? expanded
      : resolve(cwd, expanded);

    const hasTrailingSlash = trimmed.endsWith("/") || trimmed.endsWith("\\");
    const basePath = hasTrailingSlash ? fullPath : dirname(fullPath);
    const filter = hasTrailingSlash
      ? ""
      : (fullPath.split(/[/\\]/).pop() || "");

    // Preserve the original ~ prefix so Pi's startsWith filter matches
    const tildePrefix = expanded !== trimmed ? trimmed.slice(0, trimmed.indexOf("/") + 1) : "";

    return listDirectory(basePath, filter, tildePrefix);
  }

  // ——— Command ———

  pi.registerCommand("add-dir", {
    description: "Add a directory to Pi's context with path autocompletion",
    getArgumentCompletions: async (prefix) => {
      const trimmed = prefix.trim();
      const cwd = pi.cwd || process.cwd();

      // If prefix doesn't look like a path, offer subcommand completions
      if (
        !trimmed.includes("/") &&
        !trimmed.includes(".") &&
        !trimmed.startsWith("-")
      ) {
        const subs: AutocompleteItem[] = [
          { value: "ls", label: "📋 list — Show added directories" },
          { value: "rm", label: "🗑 remove — Remove a directory" },
        ];
        return subs.filter((s) => s.value.startsWith(trimmed));
      }

      // rm with index completion
      const rmMatch = trimmed.match(/^(rm |--remove )/);
      if (rmMatch) {
        const numPart = trimmed.slice(rmMatch[0].length).trim();
        return allowedDirs
          .map((_d, i) => i)
          .filter((n) => String(n).startsWith(numPart))
          .map((n) => ({
            value: `${n} ${allowedDirs[n]}`,
            label: `${n}: ${allowedDirs[n]}`,
          }));
      }

      return getCompletions(prefix, cwd);
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      // LIST
      if (trimmed === "ls" || trimmed === "--list" || trimmed === "-l") {
        if (allowedDirs.length === 0) {
          ctx.ui.notify("No additional directories added", "info");
        } else {
          const lines = allowedDirs.map((d, i) => `  ${i}: ${d}`);
          ctx.ui.notify(`Allowed directories:\n${lines.join("\n")}`, "info");
        }
        return;
      }

      // REMOVE
      const rmMatch = trimmed.match(/^(rm |--remove )/);
      if (rmMatch) {
        const numStr = trimmed.slice(rmMatch[0].length).trim();
        const index = parseInt(numStr, 10);
        if (isNaN(index) || index < 0 || index >= allowedDirs.length) {
          ctx.ui.notify("Invalid index. Use: /add-dir rm <index>", "error");
          return;
        }
        const removed = allowedDirs.splice(index, 1)[0];
        persistState();
        ctx.ui.notify(`Removed: ${removed}`, "success");
        return;
      }

      // USAGE
      if (!trimmed) {
        ctx.ui.notify(
          "Usage: /add-dir <path>\n       /add-dir ls\n       /add-dir rm <index>",
          "info"
        );
        return;
      }

      // ADD
      const expanded = expandTilde(trimmed);
      const resolved = isAbsolute(expanded)
        ? expanded
        : resolve(ctx.cwd, expanded);

      try {
        const { stat } = await import("node:fs/promises");
        const s = await stat(resolved);
        if (!s.isDirectory()) {
          ctx.ui.notify(`Not a directory: ${trimmed}`, "error");
          return;
        }
      } catch {
        ctx.ui.notify(`Path not found: ${trimmed}`, "error");
        return;
      }

      if (allowedDirs.includes(resolved)) {
        ctx.ui.notify(`Already added: ${resolved}`, "info");
        return;
      }

      allowedDirs.push(resolved);
      persistState();
      ctx.ui.notify(
        `Added to context: ${resolved}\nTotal directories: ${allowedDirs.length}`,
        "success"
      );
    },
  });

  // ——— Context injection ———

  pi.on("before_agent_start", async (event, ctx) => {
    if (allowedDirs.length === 0) return; // zero overhead when empty

    const dirList = allowedDirs.map((d) => `- ${d}`).join("\n");
    const msg =
      `# Additional Context Directories\n\n` +
      `The following directories are in scope and available for file operations. ` +
      `You may read, write, edit, and create files in these directories using absolute paths.\n\n` +
      `${dirList}\n\n` +
      `When the user references files in these directories, use absolute paths or ` +
      `paths relative to / (the root). These directories are fully accessible — ` +
      `not read-only. Use standard tool calls (read, edit, write, bash) to operate on files here.\n`;

    return {
      message: {
        customType: "add-dir",
        content: msg,
        display: false,
      },
    };
  });
}
