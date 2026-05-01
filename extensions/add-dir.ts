/**
 * pi-manage-dirs — Add external directories to your Pi workspace context.
 *
 * Features:
 *   - Interactive Tab path completion with ~/ expansion
 *   - AGENTS.md / CLAUDE.md scanning and injection
 *   - Skill discovery and registration via resources_discover
 *   - Status widget showing active directories
 *   - LLM tool add_directory for agent-requested directory adds
 *   - Session persistence across /resume and restarts
 *
 * Commands:
 *   /add-dir <path>     — add a directory (with Tab completion)
 *   /add-dir ls         — list added directories
 *   /add-dir rm <index> — remove directory by index
 *   /dirs               — list all external directories with context details
 *   /remove-dir [path]  — remove a directory (interactive picker if no path, tab-completion supported)
 */
import type { ExtensionAPI, AutocompleteItem, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { readdir } from "node:fs/promises";
import { readFileSync, statSync, readdirSync } from "node:fs";
import { resolve, dirname, join, isAbsolute, basename } from "node:path";

// ——— Types ———

interface AddedDir {
  absolutePath: string;
  label: string;
  addedAt: number;
}

interface DirContext {
  dir: string;
  agentsMd: string | null;
  claudeMd: string | null;
  skills: Map<string, string>;
}

// ——— Constants ———

const CONTEXT_PATHS = [
  (d: string) => d,
  (d: string) => join(d, ".pi"),
] as const;

const SKILL_DIRS = [
  ".pi/skills",
  ".agents/skills",
  ".claude/skills",
] as const;

// ——— Helpers ———

function expandTilde(p: string): string {
  const home = process.env.HOME ?? "";
  if (p === "~") return home;
  if (p.startsWith("~/")) return home + p.slice(1);
  return p;
}

function dirExists(dir: string): boolean {
  try { return statSync(dir).isDirectory(); }
  catch { return false; }
}

function readFileSafe(filePath: string): string | null {
  try { return readFileSync(filePath, "utf-8"); }
  catch { return null; }
}

function resolveDir(input: string, cwd: string): string {
  const resolved = isAbsolute(input) ? input : resolve(cwd, input);
  try { return resolve(resolved); }
  catch { return resolved; }
}

/** Scan a directory for context files and skills. */
function scanDirContext(dir: string): DirContext {
  const ctx: DirContext = { dir, agentsMd: null, claudeMd: null, skills: new Map() };

  for (const baseFn of CONTEXT_PATHS) {
    const baseDir = baseFn(dir);
    const agents = readFileSafe(join(baseDir, "AGENTS.md"));
    const claude = readFileSafe(join(baseDir, "CLAUDE.md"));
    if (agents) ctx.agentsMd = ctx.agentsMd ? ctx.agentsMd + "\n\n" + agents : agents;
    if (claude) ctx.claudeMd = ctx.claudeMd ? ctx.claudeMd + "\n\n" + claude : claude;
  }

  for (const skillBase of SKILL_DIRS) {
    const full = join(dir, skillBase);
    if (!dirExists(full)) continue;
    try {
      for (const entry of readdirSync(full, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillPath = join(full, entry.name, "SKILL.md");
        const content = readFileSafe(skillPath);
        if (content) ctx.skills.set(entry.name, content);
      }
    } catch { /* skip */ }
  }

  return ctx;
}

/** Collect all SKILL.md file paths from added directories (for resources_discover). */
function collectSkillPaths(dirs: AddedDir[]): string[] {
  const paths: string[] = [];
  for (const dir of dirs) {
    for (const skillBase of SKILL_DIRS) {
      const full = join(dir.absolutePath, skillBase);
      if (!dirExists(full)) continue;
      try {
        for (const entry of readdirSync(full, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const skillPath = join(full, entry.name, "SKILL.md");
          if (readFileSafe(skillPath) !== null) paths.push(skillPath);
        }
      } catch { /* skip */ }
    }
  }
  return paths;
}

// ——— Context injection cache ———

let contextCache: { dirs: string; injection: string } | null = null;

function invalidateContextCache(): void { contextCache = null; }

function buildContextInjection(dirs: AddedDir[]): string {
  if (dirs.length === 0) return "";

  const cacheKey = dirs.map(d => d.absolutePath).sort().join("\0");
  if (contextCache && contextCache.dirs === cacheKey) return contextCache.injection;

  const sections: string[] = [];
  sections.push("\n\n## External Directories (added via pi-manage-dirs)");
  sections.push(
    `\nThe following ${dirs.length} external director${dirs.length === 1 ? "y is" : "ies are"} ` +
    `included in this session. You can read, edit, and write files using absolute paths.\n`
  );

  for (const dir of dirs) {
    const ctx = scanDirContext(dir.absolutePath);
    sections.push(`### ${dir.label} — \`${dir.absolutePath}\``);

    if (ctx.agentsMd) sections.push(`\n#### AGENTS.md\n${ctx.agentsMd}`);
    if (ctx.claudeMd) sections.push(`\n#### CLAUDE.md\n${ctx.claudeMd}`);

    if (ctx.skills.size > 0) {
      sections.push(`\n#### Skills (registered as /skill:name commands):`);
      for (const [name, content] of ctx.skills) {
        const desc = content.match(/^---\n[\s\S]*?description:\s*>?\s*\n?\s*(.*?)(?:\n---|\n\w)/m)?.[1]?.trim() ?? "No description";
        sections.push(`- **${name}**: ${desc} — use \`/skill:${name}\``);
      }
    }

    try {
      const top = readdirSync(dir.absolutePath, { withFileTypes: true })
        .filter(e => !e.name.startsWith(".") || e.name === ".pi" || e.name === ".agents")
        .slice(0, 20)
        .map(e => `${e.isDirectory() ? "📂" : "📄"} ${e.name}`);
      if (top.length) sections.push(`\n<details><summary>Directory contents</summary>\n\n${top.join("\n")}\n</details>`);
    } catch { /* skip */ }
  }

  const injection = sections.join("\n");
  contextCache = { dirs: cacheKey, injection };
  return injection;
}

// ——— Widget ———

function updateWidget(ctx: ExtensionContext, dirs: AddedDir[]) {
  if (!ctx.hasUI || dirs.length === 0) { ctx.ui.setWidget("add-dir", undefined); return; }

  ctx.ui.setWidget("add-dir", (_tui, theme) => ({
    dispose() {},
    invalidate() {},
    render(width: number): string[] {
      const prefix = theme.fg("accent", "📂");
      const count = theme.fg("muted", ` ${dirs.length} dir${dirs.length > 1 ? "s" : ""}`);
      const sep = theme.fg("dim", " │ ");
      const suffix = theme.fg("dim", "  (/dirs to manage)");
      const labels = dirs.map(d => theme.fg("text", d.label)).join(theme.fg("dim", ", "));
      const full = ` ${prefix}${count}${sep}${labels}${suffix}`;
      if (full.length <= width) return [full];

      const overhead = ` ${prefix}${count}${sep}`.length + suffix.length;
      const avail = width - overhead;
      if (avail > 5) return [` ${prefix}${count}${sep}${labels.slice(0, avail)}…${suffix}`];
      return [` ${prefix}${count}`];
    },
  }));
}

// ——— Autocompletion ———

async function listDirectory(
  dirPath: string,
  filter = "",
  rebasePrefix = ""
): Promise<AutocompleteItem[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const items: AutocompleteItem[] = [];
    for (const entry of entries) {
      if (filter && !entry.name.toLowerCase().startsWith(filter.toLowerCase())) continue;
      const isDir = entry.isDirectory();
      let value = join(dirPath, entry.name) + (isDir ? "/" : "");
      if (rebasePrefix && dirPath.startsWith("/")) {
        value = rebasePrefix + value.slice(dirPath.length);
      }
      items.push({ value, label: `${isDir ? "📁" : "📄"} ${entry.name}` });
    }
    items.sort((a, b) => {
      const aD = a.value.endsWith("/"), bD = b.value.endsWith("/");
      if (aD !== bD) return aD ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    return items;
  } catch { return []; }
}

function getCompletions(prefix: string, cwd: string): Promise<AutocompleteItem[]> {
  const t = prefix.trim();
  if (!t) return listDirectory(cwd);
  const expanded = expandTilde(t);
  const full = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  const hasSlash = t.endsWith("/") || t.endsWith("\\");
  const basePath = hasSlash ? full : dirname(full);
  const filter = hasSlash ? "" : (full.split(/[/\\]/).pop() || "");
  const tildePrefix = expanded !== t ? t.slice(0, t.indexOf("/") + 1) : "";
  return listDirectory(basePath, filter, tildePrefix);
}

// ——— Extension ———

export default function addDirExtension(pi: ExtensionAPI) {
  let addedDirs: AddedDir[] = [];
  let currentCwd = "";

  // ——— State persistence ———

  function reconstructState(ctx: ExtensionContext) {
    addedDirs = [];
    currentCwd = ctx.cwd;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "add-dir:state") {
        const data = (entry as { data?: { dirs: AddedDir[] } }).data;
        if (data?.dirs) addedDirs = data.dirs;
      }
    }
    invalidateContextCache();
    updateWidget(ctx, addedDirs);
  }

  function persistState() {
    pi.appendEntry("add-dir:state", { dirs: addedDirs });
  }

  pi.on("session_start", async (_e, ctx) => {
    reconstructState(ctx);
    if (addedDirs.length > 0) {
      ctx.ui.notify(`Loaded ${addedDirs.length} context director${addedDirs.length === 1 ? "y" : "ies"}`, "info");
    }
  });

  // ——— Resources discovery (skills from added dirs) ———

  pi.on("resources_discover", (event, _ctx) => {
    if (addedDirs.length === 0) return;
    const skillPaths = collectSkillPaths(addedDirs);
    if (skillPaths.length === 0) return;
    return { skillPaths };
  });

  // ——— Auto-reload tracker ———

  let dirsChanged = false;

  function markDirsChanged() { dirsChanged = true; }

  pi.on("turn_start", async (_e, ctx) => {
    if (dirsChanged && addedDirs.length > 0) {
      const hasSkills = addedDirs.some(d => scanDirContext(d.absolutePath).skills.size > 0);
      if (hasSkills) {
        dirsChanged = false; // prevent double reload
        ctx.ui.notify("Reloading to register skills from external directories…", "info");
        setTimeout(() => pi.sendUserMessage("/reload", { deliverAs: "followUp" }), 100);
      }
    }
  });

  // —── Commands ———

  pi.registerCommand("add-dir", {
    description: "Add a directory to Pi's context with path Tab completion",
    getArgumentCompletions: async (prefix) => {
      const t = prefix.trim();
      const cwd = pi.cwd || process.cwd();

      if (!t.includes("/") && !t.includes(".") && !t.startsWith("-")) {
        return [
          { value: "ls", label: "📋 list — Show added directories" },
          { value: "rm", label: "🗑 remove — Remove a directory" },
        ].filter(s => s.value.startsWith(t));
      }

      const rmMatch = t.match(/^(rm |--remove )/);
      if (rmMatch) {
        const numPart = t.slice(rmMatch[0].length).trim();
        return addedDirs
          .map((_d, i) => i)
          .filter(n => String(n).startsWith(numPart))
          .map(n => ({
            value: `${n} ${addedDirs[n].absolutePath}`,
            label: `${n}: ${addedDirs[n].label} (${addedDirs[n].absolutePath})`,
          }));
      }

      return getCompletions(prefix, cwd);
    },
    handler: async (args, ctx) => {
      const t = args.trim();

      // LIST
      if (t === "ls" || t === "--list" || t === "-l") {
        if (!addedDirs.length) { ctx.ui.notify("No directories added", "info"); return; }
        const lines = addedDirs.map((d, i) => {
          const c = scanDirContext(d.absolutePath);
          const badges: string[] = [];
          if (c.agentsMd) badges.push("AGENTS.md");
          if (c.claudeMd) badges.push("CLAUDE.md");
          if (c.skills.size) badges.push(`${c.skills.size} skill(s)`);
          return `  ${i}: ${d.absolutePath}${badges.length ? ` [${badges.join(", ")}]` : ""}`;
        });
        ctx.ui.notify(`Allowed directories:\n${lines.join("\n")}`, "info");
        return;
      }

      // REMOVE
      const rmMatch = t.match(/^(rm |--remove )/);
      if (rmMatch) {
        const numStr = t.slice(rmMatch[0].length).trim();
        const idx = parseInt(numStr, 10);
        if (isNaN(idx) || idx < 0 || idx >= addedDirs.length) {
          ctx.ui.notify("Invalid index. Use: /add-dir rm <index>", "error"); return;
        }
        const removed = addedDirs.splice(idx, 1)[0];
        invalidateContextCache(); persistState(); updateWidget(ctx, addedDirs); markDirsChanged();
        ctx.ui.notify(`Removed: ${removed.absolutePath}`, "success");
        return;
      }

      // USAGE
      if (!t) {
        ctx.ui.notify("Usage: /add-dir <path>\n       /add-dir ls\n       /add-dir rm <index>", "info");
        return;
      }

      // ADD
      const resolved = resolveDir(t, ctx.cwd);
      if (!dirExists(resolved)) { ctx.ui.notify(`Path not found: ${t}`, "error"); return; }
      if (resolved === resolveDir(ctx.cwd, ctx.cwd)) { ctx.ui.notify("That's the current working directory — already in scope.", "info"); return; }
      if (addedDirs.some(d => d.absolutePath === resolved)) { ctx.ui.notify(`Already added: ${resolved}`, "info"); return; }

      const label = basename(resolved);
      addedDirs.push({ absolutePath: resolved, label, addedAt: Date.now() });
      invalidateContextCache(); persistState(); updateWidget(ctx, addedDirs); markDirsChanged();

      const dirCtx = scanDirContext(resolved);
      const found: string[] = [];
      if (dirCtx.agentsMd) found.push("AGENTS.md");
      if (dirCtx.claudeMd) found.push("CLAUDE.md");
      if (dirCtx.skills.size) found.push(`${dirCtx.skills.size} skill(s)`);
      let msg = `Added ${label} (${resolved}).`;
      msg += found.length ? ` Found: ${found.join(", ")}.` : " No context files found.";
      ctx.ui.notify(msg, "success");
    },
  });

  pi.registerCommand("dirs", {
    description: "List all external directories added to this session",
    handler: async (_args, ctx) => {
      if (!addedDirs.length) { ctx.ui.notify("No external directories added. Use /add-dir <path> to add one.", "info"); return; }
      const lines: string[] = [`External directories (${addedDirs.length}):\n`];
      for (const dir of addedDirs) {
        const c = scanDirContext(dir.absolutePath);
        const badges: string[] = [];
        if (c.agentsMd) badges.push("AGENTS.md");
        if (c.claudeMd) badges.push("CLAUDE.md");
        if (c.skills.size) badges.push(`${c.skills.size} skill(s)`);
        lines.push(`  📂 ${dir.label}`, `     ${dir.absolutePath}`);
        if (badges.length) lines.push(`     Found: ${badges.join(", ")}`);
        if (c.skills.size) lines.push(`     Skills: ${[...c.skills.keys()].map(s => `/skill:${s}`).join(", ")}`);
        lines.push("");
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("remove-dir", {
    description: "Remove an external directory from this session",
    getArgumentCompletions(prefix: string) {
      if (!addedDirs.length) return null;
      const lower = prefix.toLowerCase();
      return addedDirs.filter(d => d.label.toLowerCase().startsWith(lower) || d.absolutePath.toLowerCase().startsWith(lower))
        .map(d => ({ label: d.label, value: d.absolutePath, description: d.absolutePath }));
    },
    handler: async (args, ctx) => {
      if (!addedDirs.length) { ctx.ui.notify("No external directories added.", "info"); return; }
      let absPath: string | undefined;
      if (args?.trim()) {
        const input = args.trim();
        const byLabel = addedDirs.find(d => d.label === input);
        absPath = byLabel ? byLabel.absolutePath : resolveDir(input, ctx.cwd);
      } else {
        const choices = addedDirs.map(d => `${d.label} — ${d.absolutePath}`);
        const sel = await ctx.ui.select("Remove which directory?", choices);
        if (sel === undefined) return;
        const idx = choices.indexOf(sel);
        if (idx >= 0 && addedDirs[idx]) absPath = addedDirs[idx].absolutePath;
      }
      if (!absPath) return;
      const idx = addedDirs.findIndex(d => d.absolutePath === absPath);
      if (idx === -1) { ctx.ui.notify(`Not found: ${absPath}`, "error"); return; }
      const removed = addedDirs.splice(idx, 1)[0];
      invalidateContextCache(); persistState(); updateWidget(ctx, addedDirs); markDirsChanged();
      ctx.ui.notify(`Removed ${removed.label} (${removed.absolutePath}).`, "success");
    },
  });

  // ——— System prompt injection ———

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!addedDirs.length) return;
    const injection = buildContextInjection(addedDirs);
    if (!injection) return;
    return { systemPrompt: event.systemPrompt + injection };
  });

  // ——— LLM tool: add_directory ———

  pi.registerTool({
    name: "add_directory",
    label: "Add Directory",
    description:
      "Add an external directory to this session so its AGENTS.md, CLAUDE.md, and skills are loaded into context. " +
      "Use when you need to reference or work with code in a directory outside cwd. " +
      "The directory's context files are injected into the system prompt automatically. " +
      "After adding, you can read/edit/write files in that directory using absolute paths.",
    promptSnippet: "Add an external directory to this session (loads its AGENTS.md, skills, etc.)",
    promptGuidelines: [
      "Use add_directory when you need context from another project or directory outside cwd.",
      "The directory's AGENTS.md and CLAUDE.md are injected into the system prompt automatically.",
      "After adding, you can read/edit/write files in the directory using absolute paths.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Absolute or relative path to the directory to add" }),
      reason: Type.Optional(Type.String({ description: "Why this directory is being added (shown to user)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const dirPath = resolveDir(params.path.replace(/^@/, ""), ctx.cwd);
      if (!dirExists(dirPath)) throw new Error(`Directory does not exist: ${dirPath}`);
      if (addedDirs.some(d => d.absolutePath === dirPath)) {
        return { content: [{ type: "text", text: `Already added: ${dirPath}` }], details: { directory: dirPath } };
      }
      const label = basename(dirPath);
      addedDirs.push({ absolutePath: dirPath, label, addedAt: Date.now() });
      invalidateContextCache(); persistState(); updateWidget(ctx, addedDirs); markDirsChanged();

      const dc = scanDirContext(dirPath);
      const resp: string[] = [`Added ${label} (${dirPath}).`];
      if (dc.agentsMd) resp.push("AGENTS.md content has been injected into system context.");
      if (dc.claudeMd) resp.push("CLAUDE.md content has been injected into system context.");
      if (dc.skills.size) {
        resp.push(`\nDiscovered skills: ${[...dc.skills.keys()].join(", ")}`);
        resp.push("Skills will be registered after the turn completes.");
      }
      resp.push(`\nYou can now access files at: ${dirPath}`);

      return {
        content: [{ type: "text", text: resp.join("\n") }],
        details: { directory: dirPath, hasAgentsMd: !!dc.agentsMd, hasClaudeMd: !!dc.claudeMd, skillCount: dc.skills.size, skillNames: [...dc.skills.keys()] },
      };
    },
    renderCall(args, theme) {
      let txt = theme.fg("toolTitle", theme.bold("add_directory "));
      txt += theme.fg("accent", (args.path ?? "").replace(/^@/, ""));
      if (args.reason) txt += theme.fg("dim", ` — ${args.reason}`);
      return new Text(txt, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const d = result.details as { directory?: string; hasAgentsMd?: boolean; hasClaudeMd?: boolean; skillCount?: number; skillNames?: string[] } | undefined;
      if (!d) return new Text(theme.fg("success", `✓ ${result.content?.[0] ?? "Done"}`), 0, 0);
      const parts = [theme.fg("success", `✓ Added ${basename(d.directory ?? "")}`)];
      const badges: string[] = [];
      if (d.hasAgentsMd) badges.push(theme.fg("accent", "AGENTS.md"));
      if (d.hasClaudeMd) badges.push(theme.fg("accent", "CLAUDE.md"));
      if (d.skillCount && d.skillCount > 0) badges.push(theme.fg("warning", `${d.skillCount} skills`));
      if (badges.length) parts.push(theme.fg("dim", " │ ") + badges.join(theme.fg("dim", ", ")));
      if (expanded && d.skillNames?.length) {
        parts.push("\n" + theme.fg("muted", "  Skills: ") + d.skillNames.map(s => theme.fg("text", s)).join(", "));
      }
      return new Text(parts.join(""), 0, 0);
    },
  });
}
