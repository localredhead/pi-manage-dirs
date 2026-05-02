/**
 * pi-manage-dirs — Add external directories to your Pi workspace context.
 *
 * Features:
 *   - Interactive Tab path completion with ~/ expansion
 *   - Smart directory suggestions based on project structure
 *   - AGENTS.md / CLAUDE.md scanning and injection
 *   - Skill discovery and registration via resources_discover
 *   - Status widget showing active directories
 *   - LLM tools: add_directory, search_external_files
 *   - Session persistence across /resume and restarts
 *
 * Commands:
 *   /manage-dirs                    — interactive suggestions
 *   /manage-dirs ~/path             — add a directory (with Tab completion)
 *   /manage-dirs ls                 — list added directories
 *   /manage-dirs rm <index>         — remove by index
 *   /manage-dirs rm <path>          — remove by path or label
 *   /manage-dirs suggest            — scored suggestions from project structure
 *   /manage-dirs help               — show all subcommands
 */
import type { ExtensionAPI, AutocompleteItem, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import path, { resolve, dirname, join, isAbsolute, basename } from "node:path";

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

interface Suggestion {
  absolutePath: string;
  label: string;
  score: number;
  reasons: string[];
}

// ——— Constants ———

const CONTEXT_PATHS = [
  (d: string) => d,
  (d: string) => join(d, ".pi"),
] as const;

const SKILL_DIRS = [".pi/skills", ".agents/skills", ".claude/skills"] as const;

const PROJECT_MARKERS = [
  "package.json", ".git", "Cargo.toml", "go.mod",
  "pyproject.toml", "Gemfile", "Rakefile", "pom.xml",
  "build.gradle", "build.gradle.kts", "mix.exs", "Makefile",
  "CMakeLists.txt", "setup.py", "setup.cfg", "deno.json",
  "project.json", "composer.json", "Package.swift", "pubspec.yaml",
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
  const expanded = expandTilde(input);
  const resolved = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  try { return resolve(resolved); }
  catch { return resolved; }
}

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
  if (!ctx.hasUI || dirs.length === 0) { ctx.ui.setWidget("manage-dirs", undefined); return; }
  ctx.ui.setWidget("manage-dirs", (_tui, theme) => ({
    dispose() {}, invalidate() {},
    render(width: number): string[] {
      const prefix = theme.fg("accent", "📂");
      const count = theme.fg("muted", ` ${dirs.length} dir${dirs.length > 1 ? "s" : ""}`);
      const sep = theme.fg("dim", " | ");
      const suffix = theme.fg("dim", "  (/manage-dirs to manage)");
      const labels = dirs.map(d => theme.fg("text", d.label)).join(theme.fg("dim", ", "));
      const full = ` ${prefix}${count}${sep}${labels}${suffix}`;
      const fullWidth = full.replace(/\x1b\[[0-9;]*m/g, "").length;
      if (fullWidth <= width) return [full];
      const base = ` ${prefix}${count}${sep}`;
      const baseW = base.replace(/\x1b\[[0-9;]*m/g, "").length;
      const suW = suffix.replace(/\x1b\[[0-9;]*m/g, "").length;
      const avail = width - baseW - suW;
      if (avail > 5) return [`${base}${truncateToWidth(labels, avail, "...")}${suffix}`];
      return [` ${prefix}${count}`];
    },
  }));
}

// ——— Autocompletion ———

async function listDirectory(
  dirPath: string, filter = "", rebasePrefix = ""
): Promise<AutocompleteItem[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const items: AutocompleteItem[] = [];
    for (const entry of entries) {
      if (filter && !entry.name.toLowerCase().startsWith(filter.toLowerCase())) continue;
      const isDir = entry.isDirectory();
      let value = join(dirPath, entry.name) + (isDir ? "/" : "");
      if (rebasePrefix) {
        value = rebasePrefix + entry.name + (isDir ? "/" : "");
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
  const tildePrefix = expanded !== t
    ? (t.endsWith("/") || t.endsWith("\\")
      ? t
      : t.slice(0, t.lastIndexOf("/") + 1)) : "";
  return listDirectory(basePath, filter, tildePrefix);
}

// ——— Smart Suggestions Engine ———

interface Candidate { dir: string; reasons: string[]; weight: number }

function findGitRoot(cwd: string): string | null {
  let current = cwd;
  for (let i = 0; i < 10; i++) {
    if (dirExists(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function findWorkspaceRoot(cwd: string): string | null {
  let current = cwd;
  for (let i = 0; i < 10; i++) {
    let files: Set<string>;
    try { files = new Set(readdirSync(current)); }
    catch { current = dirname(current); continue; }
    if (files.has("pnpm-workspace.yaml") || files.has("go.work")) return current;
    if (files.has("package.json")) {
      try { const pkg = JSON.parse(readFileSafe(join(current, "package.json"))!); if (pkg.workspaces) return current; } catch {}
    }
    if (files.has("Cargo.toml")) { const c = readFileSafe(join(current, "Cargo.toml")); if (c?.includes("[workspace]")) return current; }
    if (files.has("pyproject.toml")) { const p = readFileSafe(join(current, "pyproject.toml")); if (p?.includes("[tool.uv.workspace]")) return current; }
    if ([...files].some(f => f.endsWith(".sln"))) return current;
    if (files.has("settings.gradle") || files.has("settings.gradle.kts")) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function isProject(dir: string): boolean {
  return PROJECT_MARKERS.some(m => existsSync(join(dir, m)));
}

function collectPathsFromFile(cwd: string, file: string, rx: RegExp, reason: string, weight: number): Candidate[] {
  const content = readFileSafe(join(cwd, file));
  if (!content) return [];
  const out: Candidate[] = [];
  let m: RegExpExecArray | null;
  while ((m = rx.exec(content))) {
    const rel = m[1]; if (!rel) continue;
    const abs = path.resolve(cwd, rel);
    if (dirExists(abs)) out.push({ dir: abs, reasons: [reason], weight });
  }
  return out;
}

function collectNpmDeps(cwd: string): Candidate[] {
  const pkg = readFileSafe(join(cwd, "package.json"));
  if (!pkg) return [];
  const out: Candidate[] = [];
  try {
    const parsed = JSON.parse(pkg);
    const all = { ...parsed.dependencies, ...parsed.devDependencies };
    for (const [name, ver] of Object.entries(all)) {
      if (typeof ver !== "string") continue;
      for (const proto of ["file:", "link:", "portal:"]) {
        if (ver.startsWith(proto)) {
          const abs = path.resolve(cwd, ver.slice(proto.length));
          if (dirExists(abs)) out.push({ dir: abs, reasons: [`${proto} dep (${name})`], weight: 0.6 });
        }
      }
    }
  } catch {}
  return out;
}

function collectSiblings(cwd: string): Candidate[] {
  const parent = dirname(cwd);
  if (parent === cwd) return [];
  const cwdRoot = findGitRoot(cwd);
  const out: Candidate[] = [];
  try {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const full = join(parent, entry.name);
      if (full === cwd || !isProject(full)) continue;
      const sibRoot = findGitRoot(full);
      const same = cwdRoot && sibRoot && cwdRoot === sibRoot;
      const hasCtx = CONTEXT_PATHS.some(fn => {
        const base = fn(full);
        return existsSync(join(base, "AGENTS.md")) || existsSync(join(base, "CLAUDE.md"));
      });
      if (same) out.push({ dir: full, reasons: ["sibling (same repo)"], weight: 0.35 });
      else if (hasCtx) out.push({ dir: full, reasons: ["sibling (context files)"], weight: 0.25 });
      else out.push({ dir: full, reasons: ["sibling project"], weight: 0.2 });
    }
  } catch {}
  return out;
}

function collectWorkspaceMembers(cwd: string): Candidate[] {
  const root = findWorkspaceRoot(cwd);
  if (!root) return [];
  const out: Candidate[] = [];
  try {
    const pkg = JSON.parse(readFileSafe(join(root, "package.json"))!);
    const patterns: string[] = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? [];
    for (const pat of patterns) {
      if (pat.endsWith("/*")) {
        const base = join(root, pat.slice(0, -2));
        if (dirExists(base)) {
          for (const e of readdirSync(base, { withFileTypes: true })) {
            if (!e.isDirectory() || e.name.startsWith(".")) continue;
            const full = join(base, e.name);
            if (full !== cwd && isProject(full)) out.push({ dir: full, reasons: ["workspace member"], weight: 0.5 });
          }
        }
      } else {
        const abs = path.resolve(root, pat);
        if (abs !== cwd && dirExists(abs) && isProject(abs)) out.push({ dir: abs, reasons: ["workspace member"], weight: 0.5 });
      }
    }
  } catch {}
  return out;
}

function gatherSuggestions(cwd: string, alreadyAdded: string[]): Suggestion[] {
  const candidates: Candidate[] = [
    ...collectSiblings(cwd),
    ...collectNpmDeps(cwd),
    ...collectPathsFromFile(cwd, "Cargo.toml", /path\s*=\s*"([^"]+)"/g, "Cargo path dep", 0.6),
    ...collectPathsFromFile(cwd, "tsconfig.json", /"path"\s*:\s*"([^"]+)"/g, "TS project ref", 0.55),
    ...collectPathsFromFile(cwd, "mix.exs", /\{:\w+\s*,\s*path:\s*"([^"]+)"/g, "Elixir mix.exs", 0.6),
    ...collectPathsFromFile(cwd, "pubspec.yaml", /path:\s*['"]?(\.\.\/[^'"\s]+|\.\/.+)['"]?/g, "pubspec path", 0.6),
    ...collectWorkspaceMembers(cwd),
  ];

  const byPath = new Map<string, { reasons: string[]; weight: number }>();
  for (const c of candidates) {
    const ex = byPath.get(c.dir);
    if (ex) { ex.reasons.push(...c.reasons); ex.weight += c.weight; }
    else byPath.set(c.dir, { reasons: [...c.reasons], weight: c.weight });
  }

  const resolvedCwd = path.resolve(cwd);
  const excluded = new Set([resolvedCwd, ...alreadyAdded]);

  const suggestions: Suggestion[] = [];
  for (const [dir, data] of byPath) {
    if (excluded.has(dir) || resolvedCwd.startsWith(dir + path.sep)) continue;
    let score = Math.min(data.weight, 1.0);
    const hasCtx = CONTEXT_PATHS.some(fn => {
      const b = fn(dir);
      return existsSync(join(b, "AGENTS.md")) || existsSync(join(b, "CLAUDE.md"));
    });
    if (hasCtx) { score = Math.min(score + 0.25, 1.0); data.reasons.push("has context files"); }
    suggestions.push({ absolutePath: dir, label: basename(dir), score: Math.round(score * 100) / 100, reasons: [...new Set(data.reasons)] });
  }
  suggestions.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return suggestions.slice(0, 10);
}

// ——— Extension ———

export default function addDirExtension(pi: ExtensionAPI) {
  let addedDirs: AddedDir[] = [];
  let currentCwd = "";

  function reconstructState(ctx: ExtensionContext) {
    addedDirs = []; currentCwd = ctx.cwd;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "manage-dirs:state") {
        const data = (entry as { data?: { dirs: AddedDir[] } }).data;
        if (data?.dirs) addedDirs = data.dirs;
      }
    }
    invalidateContextCache(); updateWidget(ctx, addedDirs);
  }

  function persistState() { pi.appendEntry("manage-dirs:state", { dirs: addedDirs }); }

  pi.on("session_start", async (_e, ctx) => {
    reconstructState(ctx);
    if (addedDirs.length > 0) ctx.ui.notify(`Loaded ${addedDirs.length} context director${addedDirs.length === 1 ? "y" : "ies"}`, "info");
  });

  pi.on("resources_discover", (event, _ctx) => {
    if (!addedDirs.length) return;
    const skillPaths = collectSkillPaths(addedDirs);
    if (!skillPaths.length) return;
    return { skillPaths };
  });

  let dirsChanged = false;
  function markChanged() { dirsChanged = true; }

  pi.on("turn_start", async (_e, ctx) => {
    if (dirsChanged && addedDirs.length > 0) {
      const hasSkills = addedDirs.some(d => scanDirContext(d.absolutePath).skills.size > 0);
      if (hasSkills) {
        dirsChanged = false;
        setTimeout(() => pi.sendUserMessage("/reload", { deliverAs: "followUp" }), 100);
      }
    }
  });

  // ——— Command helpers ———

  async function addResolvedDir(input: string, cwd: string, ctx: ExtensionContext) {
    const resolved = resolveDir(input, cwd);
    if (!dirExists(resolved)) { ctx.ui.notify(`Path not found: ${input}`, "error"); return; }
    if (resolved === resolveDir(cwd, cwd)) { ctx.ui.notify("That's the current working directory — already in scope.", "info"); return; }
    if (addedDirs.some(d => d.absolutePath === resolved)) { ctx.ui.notify(`Already added: ${resolved}`, "info"); return; }
    const label = basename(resolved);
    addedDirs.push({ absolutePath: resolved, label, addedAt: Date.now() });
    invalidateContextCache(); persistState(); updateWidget(ctx, addedDirs); markChanged();
    const dc = scanDirContext(resolved);
    const found: string[] = [];
    if (dc.agentsMd) found.push("AGENTS.md");
    if (dc.claudeMd) found.push("CLAUDE.md");
    if (dc.skills.size) found.push(`${dc.skills.size} skill(s)`);
    let msg = `Added ${label} (${resolved}).`;
    msg += found.length ? ` Found: ${found.join(", ")}.` : " No context files found.";
    ctx.ui.notify(msg, "success");
  }

  async function handleAdd(args: string, cwd: string, ctx: ExtensionContext) {
    const t = args.trim();
    if (!t) {
      const sugs = gatherSuggestions(cwd, addedDirs.map(d => d.absolutePath));
      if (sugs.length > 0) {
        const choices = sugs.map(s => `${s.label} — ${s.absolutePath} (${s.reasons.slice(0, 2).join(", ")})`);
        choices.push("📝 Enter a custom path...");
        const sel = await ctx.ui.select("Suggested directories:", choices);
        if (sel === undefined) return;
        const idx = choices.indexOf(sel);
        if (idx === -1 || idx === choices.length - 1) {
          const custom = await ctx.ui.input("Directory path:", "");
          if (custom) addResolvedDir(custom, cwd, ctx);
          return;
        }
        if (sugs[idx]) addResolvedDir(sugs[idx].absolutePath, cwd, ctx);
        return;
      }
      const custom = await ctx.ui.input("Directory path (no suggestions found):", "");
      if (custom) addResolvedDir(custom, cwd, ctx);
      return;
    }
    addResolvedDir(t, cwd, ctx);
  }

  async function handleRemove(args: string, cwd: string, ctx: ExtensionContext) {
    if (!addedDirs.length) { ctx.ui.notify("No external directories added.", "info"); return; }
    let absPath: string | undefined;
    if (args.trim()) {
      const input = args.trim();
      const byLabel = addedDirs.find(d => d.label === input);
      absPath = byLabel ? byLabel.absolutePath : resolveDir(input, cwd);
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
    addedDirs.splice(idx, 1); invalidateContextCache(); persistState(); updateWidget(ctx, addedDirs); markChanged();
    ctx.ui.notify("Removed.", "success");
  }

  async function handleSuggest(cwd: string, ctx: ExtensionContext) {
    const sugs = gatherSuggestions(cwd, addedDirs.map(d => d.absolutePath));
    if (!sugs.length) { ctx.ui.notify("No suggestions found. Try /manage-dirs <path> to add manually.", "info"); return; }
    const choices = sugs.map(s => `${s.label} (${Math.round(s.score * 100)}%) — ${s.reasons.slice(0, 2).join(", ")}`);
    const sel = await ctx.ui.select("Suggested directories — pick to add:", choices);
    if (sel === undefined) return;
    const idx = choices.indexOf(sel);
    if (idx === -1 || !sugs[idx]) return;
    addResolvedDir(sugs[idx].absolutePath, cwd, ctx);
  }

  // ——— Unified /manage-dirs command ———

  pi.registerCommand("manage-dirs", {
    description: "Manage external directories in your Pi workspace context",
    getArgumentCompletions: async (prefix) => {
      const t = prefix.trim();
      const cwd = pi.cwd || process.cwd();
      // Path → breadcrumb autocomplete
      if (t.includes("/") || t.startsWith("~")) return getCompletions(prefix, cwd);
      // subcommand completions
      if (t.startsWith("rm") || t.startsWith("remove")) {
        const remPrefix = t.replace(/^(remove\s*)?/, "");
        return addedDirs
          .map((d, i) => `${i} ${d.label} (${d.absolutePath})`)
          .filter(s => s.toLowerCase().startsWith(remPrefix.toLowerCase()))
          .map(s => ({ value: s, label: "🗑 " + s }));
      }
      return [
        { value: "ls", label: "📋 list — Show added directories" },
        { value: "rm", label: "🗑 remove — Remove by index, path, or label" },
        { value: "suggest", label: "💡 suggest — Smart directory suggestions" },
        { value: "help", label: "❓ help — Show all subcommands" },
      ].filter(s => s.value.startsWith(t));
    },
    handler: async (args, ctx) => {
      const t = args.trim();
      const parts = t.split(/\s+/);
      const subcmd = parts[0] || "";
      const rest = parts.slice(1).join(" ");

      // LIST
      if (subcmd === "ls" || subcmd === "list") {
        if (!addedDirs.length) { ctx.ui.notify("No directories added", "info"); return; }
        const lines = addedDirs.map((d, i) => {
          const c = scanDirContext(d.absolutePath);
          const badges: string[] = [];
          if (c.agentsMd) badges.push("AGENTS.md");
          if (c.claudeMd) badges.push("CLAUDE.md");
          if (c.skills.size) badges.push(`${c.skills.size} skill(s)`);
          return `  ${i}: ${d.absolutePath}${badges.length ? ` [${badges.join(", ")}]` : ""}`;
        });
        ctx.ui.notify(`External directories:\n${lines.join("\n")}`, "info");
        return;
      }

      // REMOVE
      if (subcmd === "rm" || subcmd === "remove") {
        if (/^\d+$/.test(rest.trim())) {
          const idx = parseInt(rest.trim(), 10);
          if (isNaN(idx) || idx < 0 || idx >= addedDirs.length) {
            ctx.ui.notify("Invalid index. Use: /manage-dirs rm <index>", "error"); return;
          }
          addedDirs.splice(idx, 1); invalidateContextCache(); persistState(); updateWidget(ctx, addedDirs); markChanged();
          ctx.ui.notify("Removed.", "success"); return;
        }
        await handleRemove(rest, ctx.cwd, ctx); return;
      }

      // SUGGEST
      if (subcmd === "suggest" || subcmd === "suggestions") {
        await handleSuggest(ctx.cwd, ctx); return;
      }

      // HELP
      if (subcmd === "help") {
        ctx.ui.notify(
          "/manage-dirs — manage external directories\n\n" +
          "  /manage-dirs               — interactive suggestions\n" +
          "  /manage-dirs ~/path        — add a directory (Tab to complete)\n" +
          "  /manage-dirs ls            — list added directories\n" +
          "  /manage-dirs rm <index>    — remove by index\n" +
          "  /manage-dirs rm <path>     — remove by path or label\n" +
          "  /manage-dirs suggest        — scored project suggestions\n" +
          "  /manage-dirs help           — show this help",
          "info"
        );
        return;
      }

      // Default: treat as path to add
      await handleAdd(t, ctx.cwd, ctx);
    },
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!addedDirs.length) return;
    const injection = buildContextInjection(addedDirs);
    if (!injection) return;
    return { systemPrompt: event.systemPrompt + injection };
  });

  // ——— LLM tool: add_directory ——

  pi.registerTool({
    name: "add_directory",
    label: "Add Directory",
    description: "Add an external directory to this session so its AGENTS.md, CLAUDE.md, and skills are loaded into context. Use when you need to reference code in a directory outside cwd. After adding, you can read/edit/write using absolute paths.",
    promptSnippet: "Add an external directory to this session",
    promptGuidelines: [
      "Use when you need context from a directory outside cwd.",
      "The directory's AGENTS.md/CLAUDE.md are injected into the system prompt.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Absolute or relative path to the directory to add" }),
      reason: Type.Optional(Type.String({ description: "Why this directory is being added (shown to user)" })),
    }),
    async execute(_toolId, params, _signal, _onUpdate, ctx) {
      const dirPath = resolveDir(params.path.replace(/^@/, ""), ctx.cwd);
      if (!dirExists(dirPath)) throw new Error(`Directory does not exist: ${dirPath}`);
      if (addedDirs.some(d => d.absolutePath === dirPath)) {
        return { content: [{ type: "text", text: `Already added: ${dirPath}` }], details: { directory: dirPath } };
      }
      const label = basename(dirPath);
      addedDirs.push({ absolutePath: dirPath, label, addedAt: Date.now() });
      invalidateContextCache(); persistState(); updateWidget(ctx, addedDirs); markChanged();
      const dc = scanDirContext(dirPath);
      const resp: string[] = [`Added ${label} (${dirPath}).`];
      if (dc.agentsMd) resp.push("AGENTS.md injected.");
      if (dc.claudeMd) resp.push("CLAUDE.md injected.");
      if (dc.skills.size) resp.push(`Skills: ${[...dc.skills.keys()].join(", ")}.`);
      resp.push(`\nAccess files at: ${dirPath}`);
      return {
        content: [{ type: "text", text: resp.join("\n") }],
        details: { directory: dirPath, hasAgentsMd: !!dc.agentsMd, hasClaudeMd: !!dc.claudeMd, skillCount: dc.skills.size, skillNames: [...dc.skills.keys()] },
      };
    },
    renderCall(args, theme) {
      let t = theme.fg("toolTitle", theme.bold("add_directory "));
      t += theme.fg("accent", (args.path ?? "").replace(/^@/, ""));
      if (args.reason) t += theme.fg("dim", ` — ${args.reason}`);
      return new Text(t, 0, 0);
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
      if (expanded && d.skillNames?.length) parts.push("\n" + theme.fg("muted", "  Skills: ") + d.skillNames.map(s => theme.fg("text", s)).join(", "));
      return new Text(parts.join(""), 0, 0);
    },
  });

  // ——— LLM tool: search_external_files ——

  pi.registerTool({
    name: "search_external_files",
    label: "Search External Files",
    description: "Search for files across external directories added to this session. Use when you need to find a file in an external directory but don't know its exact path. Supports glob patterns like '*.ts', 'src/**', 'README.md'.",
    promptSnippet: "Search for files across all external directories by name/glob pattern",
    promptGuidelines: [
      "Use when you need to find a file in an external directory by pattern.",
      "Supports glob patterns like *.ts, config/**, README.md",
    ],
    parameters: Type.Object({
      pattern: Type.String({ description: "File name or glob pattern (e.g., '*.ts', 'config/**')" }),
      maxResults: Type.Optional(Type.Number({ description: "Max results (default: 50)" })),
    }),
    async execute(_toolId, params, signal, _onUpdate, _ctx) {
      if (!addedDirs.length) throw new Error("No external directories added. Use /manage-dirs or add_directory first.");
      const max = params.maxResults ?? 50;
      const pattern = params.pattern.replace(/^@/, "");
      const results: { dir: string; label: string; files: string[] }[] = [];
      let total = 0;
      for (const dir of addedDirs) {
        if (signal?.aborted) break; if (!dirExists(dir.absolutePath)) continue;
        const remaining = max - total; if (remaining <= 0) break;
        try {
          const hasSlash = pattern.includes("/");
          const result = spawnSync("find", [
            dir.absolutePath, "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*",
            hasSlash ? "-path" : "-name", pattern, "-type", "f",
          ], { encoding: "utf-8", timeout: 10_000 });
          const files = (result.stdout ?? "").trim().split("\n").filter(Boolean).slice(0, remaining);
          if (files.length > 0) { results.push({ dir: dir.absolutePath, label: dir.label, files }); total += files.length; }
        } catch { /* skip */ }
      }
      if (!total) return { content: [{ type: "text", text: `No files matching "${pattern}" found.` }], details: { totalFound: 0, pattern } };
      const lines: string[] = [`Found ${total} file(s) matching "${pattern}":\n`];
      for (const r of results) { lines.push(`📂 ${r.label} (${r.dir}):`); for (const f of r.files) lines.push(`  ${f}`); lines.push(""); }
      return { content: [{ type: "text", text: lines.join("\n") }], details: { totalFound: total, pattern, dirCount: results.length } };
    },
    renderCall(args, theme) {
      let t = theme.fg("toolTitle", theme.bold("search_external_files "));
      t += theme.fg("accent", `"${(args.pattern ?? "").replace(/^@/, "")}"`);
      t += theme.fg("dim", ` across ${addedDirs.length} dir(s)`);
      return new Text(t, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const d = result.details as { totalFound?: number; pattern?: string; dirCount?: number } | undefined;
      if (!d || !d.totalFound) { const t = result.content?.[0]; return new Text(theme.fg("muted", t && "text" in t ? t.text : "No results"), 0, 0); }
      let txt = theme.fg("success", `✓ ${d.totalFound} file(s)`);
      txt += theme.fg("dim", ` matching "${d.pattern}" in ${d.dirCount} dir(s)`);
      if (expanded) { const t = result.content?.[0]; if (t && "text" in t) txt += "\n" + theme.fg("muted", t.text); }
      return new Text(txt, 0, 0);
    },
  });
}
