#!/usr/bin/env node

// src/index.ts
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

// src/acp/agent.ts
import {
  RequestError as RequestError4
} from "@agentclientprotocol/sdk";

// src/acp/auth.ts
var PI_SETUP_METHOD_ID = "pi_terminal_login";
function getAuthMethods(opts) {
  const supportsTerminalAuthMeta = opts?.supportsTerminalAuthMeta ?? true;
  const method = {
    id: PI_SETUP_METHOD_ID,
    name: "Launch pi in the terminal",
    description: "Start pi in an interactive terminal to configure API keys or login",
    // Registry-required fields
    type: "terminal",
    args: ["--terminal-login"],
    env: {}
  };
  if (supportsTerminalAuthMeta) {
    const launch = terminalAuthLaunchSpec();
    method._meta = {
      ...method._meta ?? {},
      "terminal-auth": {
        ...launch,
        label: "Launch pi"
      }
    };
  }
  return [method];
}
function terminalAuthLaunchSpec() {
  const argv0 = process.argv[0] || "node";
  const argv1 = process.argv[1];
  if (argv1 && argv0) {
    const isNode = argv0.includes("node");
    const isJs = argv1.endsWith(".js");
    if (isNode && isJs) {
      return { command: argv0, args: [argv1, "--terminal-login"] };
    }
  }
  return { command: "pi-acp", args: ["--terminal-login"] };
}

// src/acp/session.ts
import { RequestError as RequestError2 } from "@agentclientprotocol/sdk";
import { readFileSync as readFileSync5 } from "fs";
import { isAbsolute, resolve as resolvePath } from "path";

// src/pi-rpc/process.ts
import { spawn } from "child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import * as readline from "readline";
import { fileURLToPath } from "url";

// src/pi-rpc/command.ts
import { platform } from "os";
function defaultPiCommand() {
  return platform() === "win32" ? "pi.cmd" : "pi";
}
function getPiCommand(override) {
  return override ?? defaultPiCommand();
}
function shouldUseShellForPiCommand(cmd) {
  if (platform() !== "win32") return false;
  const normalized = cmd.trim().toLowerCase();
  return normalized.endsWith(".cmd") || normalized.endsWith(".bat");
}

// src/pi-rpc/process.ts
function resolveBundledMcpExtension() {
  let here;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
  const candidates = [
    join(here, "pi-extension-mcp.js"),
    join(here, "pi-extension-mcp.ts"),
    join(here, "..", "src", "pi-extension-mcp.ts")
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
var PiRpcSpawnError = class extends Error {
  /** Underlying spawn error code, e.g. ENOENT, EACCES */
  code;
  constructor(message, opts) {
    super(message);
    this.name = "PiRpcSpawnError";
    this.code = opts?.code;
    this.cause = opts?.cause;
  }
};
var ESC = String.fromCharCode(27);
var CSI = String.fromCharCode(155);
var ANSI_ESCAPE_REGEX = new RegExp(
  `[${ESC}${CSI}][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  "g"
);
function stripAnsi(s) {
  return s.replace(ANSI_ESCAPE_REGEX, "");
}
function buildWorkspaceRootsPrompt(cwd, dirs) {
  return [
    "<workspace_roots>",
    `Primary working directory: ${cwd}`,
    "Additional workspace roots (also part of the user's workspace):",
    ...dirs.map((dir) => `- ${dir}`),
    "</workspace_roots>",
    "The user's workspace spans the primary working directory and the additional workspace roots listed above. Treat files under the additional roots as part of the workspace: read, search, and edit them using absolute paths. Relative paths still resolve against the primary working directory."
  ].join("\n");
}
var DEFAULT_RPC_TIMEOUT_MS = 12e4;
var PiRpcProcess = class _PiRpcProcess {
  child;
  pending = /* @__PURE__ */ new Map();
  eventHandlers = [];
  exitHandlers = [];
  preludeLines = [];
  rpcTimeoutMs;
  constructor(child, rpcTimeoutMs) {
    this.child = child;
    this.rpcTimeoutMs = typeof rpcTimeoutMs === "number" && Number.isFinite(rpcTimeoutMs) && rpcTimeoutMs > 0 ? rpcTimeoutMs : DEFAULT_RPC_TIMEOUT_MS;
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        const cleaned = stripAnsi(String(line)).trimEnd();
        if (cleaned) this.preludeLines.push(cleaned);
        return;
      }
      if (msg?.type === "response") {
        const id = typeof msg.id === "string" ? msg.id : void 0;
        if (id) {
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            if (pending.timer) clearTimeout(pending.timer);
            pending.resolve(msg);
            return;
          }
        }
      }
      for (const h of this.eventHandlers) h(msg);
    });
    child.on("exit", (code, signal) => {
      const err = new Error(`pi process exited (code=${code}, signal=${signal})`);
      this.rejectAllPending(err);
      const handlers = this.exitHandlers.slice();
      for (const h of handlers) {
        try {
          h({ code: code ?? null, signal: signal ?? null });
        } catch {
        }
      }
    });
    child.on("error", (err) => {
      this.rejectAllPending(err);
    });
  }
  rejectAllPending(err) {
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
  static async spawn(params) {
    const cmd = getPiCommand(params.piCommand);
    const args = ["--mode", "rpc", "--no-themes"];
    if (params.sessionPath) args.push("--session", params.sessionPath);
    const env = { ...process.env, PI_ACP: "1" };
    if (params.mcpConfigPayload) {
      const extensionPath = resolveBundledMcpExtension();
      if (extensionPath) {
        env.PI_ACP_MCP_CONFIG = params.mcpConfigPayload;
        args.push("--extension", shouldUseShellForPiCommand(cmd) ? `"${extensionPath}"` : extensionPath);
      } else {
        process.stderr.write(
          "[pi-acp] bundled MCP bridge extension not found; ACP-provided MCP servers will not load\n"
        );
      }
    }
    let workspaceRootsDir = null;
    if (params.additionalDirectories && params.additionalDirectories.length > 0) {
      workspaceRootsDir = mkdtempSync(join(tmpdir(), "pi-acp-"));
      const promptFile = join(workspaceRootsDir, "workspace-roots.txt");
      writeFileSync(promptFile, buildWorkspaceRootsPrompt(params.cwd, params.additionalDirectories), "utf-8");
      args.push("--append-system-prompt", shouldUseShellForPiCommand(cmd) ? `"${promptFile}"` : promptFile);
    }
    const removeWorkspaceRootsDir = () => {
      if (!workspaceRootsDir) return;
      try {
        rmSync(workspaceRootsDir, { recursive: true, force: true });
      } catch {
      }
      workspaceRootsDir = null;
    };
    const child = spawn(cmd, args, {
      cwd: params.cwd,
      stdio: "pipe",
      // `PI_ACP=1` marks the spawned pi as running under the ACP adapter so the bundled pi extension
      // (subagent → plan bridge) activates here but stays inert in a normal terminal `pi`.
      // `PI_ACP_MCP_CONFIG` (when set) carries this session's ACP MCP servers.
      env,
      shell: shouldUseShellForPiCommand(cmd)
    });
    child.on("exit", removeWorkspaceRootsDir);
    child.on("error", removeWorkspaceRootsDir);
    try {
      await new Promise((resolve5, reject) => {
        const onSpawn = () => {
          cleanup();
          resolve5();
        };
        const onError = (err) => {
          cleanup();
          reject(err);
        };
        const cleanup = () => {
          child.off("spawn", onSpawn);
          child.off("error", onError);
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
    } catch (e) {
      removeWorkspaceRootsDir();
      const code = typeof e?.code === "string" ? e.code : void 0;
      if (code === "ENOENT") {
        throw new PiRpcSpawnError(
          `Could not start pi: executable not found (command: ${cmd}). Pi needs to be installed before it can run in ACP clients. Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH. Then try again.`,
          { code, cause: e }
        );
      }
      if (code === "EACCES") {
        throw new PiRpcSpawnError(`Could not start pi: permission denied (command: ${cmd}).`, { code, cause: e });
      }
      throw new PiRpcSpawnError(`Could not start pi (command: ${cmd}).`, { code, cause: e });
    }
    child.stderr.on("data", () => {
    });
    const proc = new _PiRpcProcess(child, params.rpcTimeoutMs);
    try {
      const state = await proc.getState();
      const sessionFile = typeof state?.sessionFile === "string" ? state.sessionFile : null;
      if (sessionFile) {
        const { mkdirSync: mkdirSync3 } = await import("fs");
        const { dirname: dirname5 } = await import("path");
        mkdirSync3(dirname5(sessionFile), { recursive: true });
      }
    } catch {
    }
    return proc;
  }
  onEvent(handler) {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
    };
  }
  /** Subscribe to pi process exit. Fires once when the subprocess exits (crash, kill, or normal). */
  onExit(handler) {
    this.exitHandlers.push(handler);
    return () => {
      this.exitHandlers = this.exitHandlers.filter((h) => h !== handler);
    };
  }
  dispose(signal = "SIGTERM") {
    if (this.child.killed) return;
    try {
      this.child.kill(signal);
    } catch {
    }
  }
  /**
   * Human-readable stdout lines emitted before RPC NDJSON begins (e.g. Context/Skills/Extensions info).
   * Themes are typically noisy/less useful for ACP, so callers can filter as needed.
   */
  consumePreludeLines() {
    const lines = this.preludeLines.splice(0, this.preludeLines.length);
    return lines;
  }
  async prompt(message, images = []) {
    const res = await this.request({ type: "prompt", message, images });
    if (!res.success) throw new Error(`pi prompt failed: ${res.error ?? JSON.stringify(res.data)}`);
  }
  async abort() {
    const res = await this.request({ type: "abort" });
    if (!res.success) throw new Error(`pi abort failed: ${res.error ?? JSON.stringify(res.data)}`);
  }
  async getState() {
    const res = await this.request({ type: "get_state" });
    if (!res.success) throw new Error(`pi get_state failed: ${res.error ?? JSON.stringify(res.data)}`);
    return res.data;
  }
  async getAvailableModels() {
    const res = await this.request({ type: "get_available_models" });
    if (!res.success) throw new Error(`pi get_available_models failed: ${res.error ?? JSON.stringify(res.data)}`);
    return res.data;
  }
  async setModel(provider, modelId) {
    const res = await this.request({ type: "set_model", provider, modelId });
    if (!res.success) throw new Error(`pi set_model failed: ${res.error ?? JSON.stringify(res.data)}`);
    return res.data;
  }
  async setThinkingLevel(level) {
    const res = await this.request({ type: "set_thinking_level", level });
    if (!res.success) throw new Error(`pi set_thinking_level failed: ${res.error ?? JSON.stringify(res.data)}`);
  }
  async setFollowUpMode(mode) {
    const res = await this.request({ type: "set_follow_up_mode", mode });
    if (!res.success) throw new Error(`pi set_follow_up_mode failed: ${res.error ?? JSON.stringify(res.data)}`);
  }
  async setSteeringMode(mode) {
    const res = await this.request({ type: "set_steering_mode", mode });
    if (!res.success) throw new Error(`pi set_steering_mode failed: ${res.error ?? JSON.stringify(res.data)}`);
  }
  async compact(customInstructions) {
    const res = await this.request({ type: "compact", customInstructions });
    if (!res.success) throw new Error(`pi compact failed: ${res.error ?? JSON.stringify(res.data)}`);
    return res.data;
  }
  async setAutoCompaction(enabled) {
    const res = await this.request({ type: "set_auto_compaction", enabled });
    if (!res.success) throw new Error(`pi set_auto_compaction failed: ${res.error ?? JSON.stringify(res.data)}`);
  }
  async getSessionStats() {
    const res = await this.request({ type: "get_session_stats" });
    if (!res.success) throw new Error(`pi get_session_stats failed: ${res.error ?? JSON.stringify(res.data)}`);
    return res.data;
  }
  async setSessionName(name) {
    const res = await this.request({ type: "set_session_name", name });
    if (!res.success) throw new Error(`pi set_session_name failed: ${res.error ?? JSON.stringify(res.data)}`);
  }
  async exportHtml(outputPath) {
    const res = await this.request({ type: "export_html", outputPath });
    if (!res.success) throw new Error(`pi export_html failed: ${res.error ?? JSON.stringify(res.data)}`);
    const data = res.data;
    return { path: String(data?.path ?? "") };
  }
  async switchSession(sessionPath) {
    const res = await this.request({ type: "switch_session", sessionPath });
    if (!res.success) throw new Error(`pi switch_session failed: ${res.error ?? JSON.stringify(res.data)}`);
  }
  async getMessages() {
    const res = await this.request({ type: "get_messages" });
    if (!res.success) throw new Error(`pi get_messages failed: ${res.error ?? JSON.stringify(res.data)}`);
    return res.data;
  }
  async getCommands() {
    const res = await this.request({ type: "get_commands" });
    if (!res.success) throw new Error(`pi get_commands failed: ${res.error ?? JSON.stringify(res.data)}`);
    return res.data;
  }
  async sendExtensionUiResponse(response) {
    await this.writeLine(`${JSON.stringify({ type: "extension_ui_response", ...response })}
`);
  }
  request(cmd) {
    const id = crypto.randomUUID();
    const withId = { ...cmd, id };
    const line = `${JSON.stringify(withId)}
`;
    return new Promise((resolve5, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`pi RPC request timed out after ${this.rpcTimeoutMs}ms (command: ${cmd.type})`));
        }
      }, this.rpcTimeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.pending.set(id, { resolve: resolve5, reject, timer });
      void this.writeLine(line).catch((error) => {
        const entry = this.pending.get(id);
        if (entry?.timer) clearTimeout(entry.timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }
  writeLine(line) {
    return new Promise((resolve5, reject) => {
      try {
        this.child.stdin.write(line, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve5();
        });
      } catch (error) {
        reject(error);
      }
    });
  }
};

// src/acp/auth-required.ts
import { RequestError } from "@agentclientprotocol/sdk";
function maybeAuthRequiredError(err) {
  const msg = String(err?.message ?? err ?? "");
  const s = msg.toLowerCase();
  const patterns = [
    "api key",
    "apikey",
    "missing key",
    "no key",
    "not configured",
    "unauthorized",
    "authentication",
    "permission denied",
    "forbidden",
    "401",
    "403"
  ];
  const hit = patterns.some((p) => s.includes(p));
  if (!hit) return null;
  return RequestError.authRequired(
    {
      authMethods: getAuthMethods()
    },
    "Configure an API key or log in with an OAuth provider."
  );
}

// src/acp/session-store.ts
import { mkdirSync as mkdirSync2, readFileSync as readFileSync3, renameSync, rmSync as rmSync2, writeFileSync as writeFileSync3 } from "fs";
import { dirname as dirname3 } from "path";

// src/acp/paths.ts
import { homedir as homedir2 } from "os";
import { join as join4, resolve as resolve2 } from "path";

// src/acp/pi-acp-settings.ts
import { existsSync as existsSync3, mkdirSync, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "fs";
import { dirname as dirname2, join as join3 } from "path";

// src/acp/pi-settings.ts
import { existsSync as existsSync2, readFileSync } from "fs";
import { homedir } from "os";
import { join as join2, resolve } from "path";
function isObject(x) {
  return Boolean(x) && typeof x === "object" && !Array.isArray(x);
}
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const av = out[k];
    if (isObject(av) && isObject(v)) out[k] = deepMerge(av, v);
    else out[k] = v;
  }
  return out;
}
function readJsonFile(path) {
  try {
    if (!existsSync2(path)) return {};
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw);
    return isObject(data) ? data : {};
  } catch {
    return {};
  }
}
function getMergedSettings(cwd) {
  const globalSettingsPath = join2(getAgentDir(), "settings.json");
  const projectSettingsPath = resolve(cwd, ".pi", "settings.json");
  const global = readJsonFile(globalSettingsPath);
  const project = readJsonFile(projectSettingsPath);
  return deepMerge(global, project);
}
function getAgentDir() {
  return process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join2(homedir(), ".pi", "agent");
}
function getEnableSkillCommands(cwd) {
  const merged = getMergedSettings(cwd);
  const direct = merged.enableSkillCommands;
  if (typeof direct === "boolean") return direct;
  const nested = isObject(merged.skills) ? merged.skills.enableSkillCommands : void 0;
  if (typeof nested === "boolean") return nested;
  return true;
}
function getQuietStartup(cwd) {
  const merged = getMergedSettings(cwd);
  const direct = merged.quietStartup;
  if (typeof direct === "boolean") return direct;
  const legacy = merged.quietStart;
  if (typeof legacy === "boolean") return legacy;
  return false;
}

// src/acp/pi-acp-settings.ts
var DEFAULT_PI_ACP_SETTINGS = {
  embeddedContext: true,
  rpcTimeoutMs: 12e4,
  debug: false
};
function getPiAcpSettingsPath() {
  return join3(getAgentDir(), "extensions", "pi-acp.json");
}
function getLegacyPiAcpSettingsPath() {
  return join3(getAgentDir(), "pi-acp.json");
}
function resolvePiAcpSettingsReadPath() {
  const current = getPiAcpSettingsPath();
  if (existsSync3(current)) return current;
  const legacy = getLegacyPiAcpSettingsPath();
  if (existsSync3(legacy)) return legacy;
  return current;
}
function isObject2(x) {
  return Boolean(x) && typeof x === "object" && !Array.isArray(x);
}
function readPiAcpSettings(path = resolvePiAcpSettingsReadPath()) {
  try {
    if (!existsSync3(path)) return { ...DEFAULT_PI_ACP_SETTINGS };
    const data = JSON.parse(readFileSync2(path, "utf-8"));
    if (!isObject2(data)) return { ...DEFAULT_PI_ACP_SETTINGS };
    const out = {
      embeddedContext: typeof data.embeddedContext === "boolean" ? data.embeddedContext : DEFAULT_PI_ACP_SETTINGS.embeddedContext,
      rpcTimeoutMs: typeof data.rpcTimeoutMs === "number" && Number.isFinite(data.rpcTimeoutMs) && data.rpcTimeoutMs > 0 ? data.rpcTimeoutMs : DEFAULT_PI_ACP_SETTINGS.rpcTimeoutMs,
      debug: typeof data.debug === "boolean" ? data.debug : DEFAULT_PI_ACP_SETTINGS.debug
    };
    if (typeof data.piCommand === "string" && data.piCommand.trim()) out.piCommand = data.piCommand;
    if (typeof data.dataDir === "string" && data.dataDir.trim()) out.dataDir = data.dataDir;
    return out;
  } catch {
    return { ...DEFAULT_PI_ACP_SETTINGS };
  }
}
function getEmbeddedContext() {
  return readPiAcpSettings().embeddedContext;
}
function getRpcTimeoutMs() {
  return readPiAcpSettings().rpcTimeoutMs;
}
function getPiAcpDebug() {
  return readPiAcpSettings().debug;
}
function getPiCommandOverride() {
  return readPiAcpSettings().piCommand;
}
function getPiAcpDataDir() {
  return readPiAcpSettings().dataDir;
}
function ensurePiAcpSettingsFile(path = getPiAcpSettingsPath()) {
  try {
    if (existsSync3(path)) return;
    if (existsSync3(getLegacyPiAcpSettingsPath())) return;
    mkdirSync(dirname2(path), { recursive: true });
    writeFileSync2(path, JSON.stringify(DEFAULT_PI_ACP_SETTINGS, null, 2) + "\n", { encoding: "utf-8" });
  } catch {
  }
}

// src/acp/paths.ts
function getPiAcpDir() {
  const configured = getPiAcpDataDir();
  return configured ? resolve2(configured) : join4(homedir2(), ".pi", "pi-acp");
}
function getPiAcpSessionMapPath() {
  return join4(getPiAcpDir(), "session-map.json");
}
function getPiAcpMcpPolicyPath() {
  return join4(getPiAcpDir(), "mcp-policy.json");
}

// src/acp/session-store.ts
function ensureParentDir(path) {
  mkdirSync2(dirname3(path), { recursive: true });
}
function loadFile(path) {
  try {
    const raw = readFileSync3(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || typeof parsed.sessions !== "object" || !parsed.sessions) {
      return { version: 1, sessions: {} };
    }
    return parsed;
  } catch {
    return { version: 1, sessions: {} };
  }
}
function saveFile(path, data) {
  ensureParentDir(path);
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync3(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync2(tmp, { force: true });
    } catch {
    }
    throw err;
  }
}
var SessionStore = class {
  path;
  constructor(path = getPiAcpSessionMapPath()) {
    this.path = path;
  }
  get(sessionId) {
    const db = loadFile(this.path);
    return db.sessions[sessionId] ?? null;
  }
  upsert(entry) {
    const db = loadFile(this.path);
    db.sessions[entry.sessionId] = {
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      sessionFile: entry.sessionFile,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    saveFile(this.path, db);
  }
  delete(sessionId) {
    const db = loadFile(this.path);
    if (!db.sessions[sessionId]) return;
    delete db.sessions[sessionId];
    saveFile(this.path, db);
  }
};

// src/acp/slash-commands.ts
import { existsSync as existsSync4, readdirSync, readFileSync as readFileSync4 } from "fs";
import { homedir as homedir3 } from "os";
import { join as join5, resolve as resolve3 } from "path";
function parseFrontmatter(content) {
  const frontmatter = {};
  if (!content.startsWith("---")) return { frontmatter, content };
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) return { frontmatter, content };
  const frontmatterBlock = content.slice(4, endIndex);
  const remaining = content.slice(endIndex + 4).trim();
  for (const line of frontmatterBlock.split("\n")) {
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (match) frontmatter[match[1]] = match[2].trim();
  }
  return { frontmatter, content: remaining };
}
function loadCommandsFromDir(dir, source, subdir = "") {
  const commands = [];
  if (!existsSync4(dir)) return commands;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join5(dir, entry.name);
      if (entry.isDirectory()) {
        const newSubdir = subdir ? `${subdir}:${entry.name}` : entry.name;
        commands.push(...loadCommandsFromDir(fullPath, source, newSubdir));
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      try {
        const rawContent = readFileSync4(fullPath, "utf-8");
        const { frontmatter, content } = parseFrontmatter(rawContent);
        const name = entry.name.slice(0, -3);
        const sourceStr = source === "user" ? subdir ? `(user:${subdir})` : "(user)" : subdir ? `(project:${subdir})` : "(project)";
        let description = frontmatter.description || "";
        if (!description) {
          const firstLine = content.split("\n").find((l) => l.trim());
          if (firstLine) {
            description = firstLine.slice(0, 60);
            if (firstLine.length > 60) description += "...";
          }
        }
        description = description ? `${description} ${sourceStr}` : sourceStr;
        commands.push({
          name,
          description,
          content,
          source: sourceStr
        });
      } catch {
      }
    }
  } catch {
  }
  return commands;
}
function loadSlashCommands(cwd) {
  const commands = [];
  const userDir = join5(homedir3(), ".pi", "agent", "prompts");
  const projectDir = resolve3(cwd, ".pi", "prompts");
  commands.push(...loadCommandsFromDir(userDir, "user"));
  commands.push(...loadCommandsFromDir(projectDir, "project"));
  return commands;
}
function toAvailableCommands(fileCommands) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const c of fileCommands) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({
      name: c.name,
      description: c.description
      // input: omitted for now (pi commands don't specify this)
    });
  }
  return out;
}
function parseCommandArgs(argsString) {
  const args = [];
  let current = "";
  let inQuote = null;
  for (let i = 0; i < argsString.length; i++) {
    const ch = argsString[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === " " || ch === "	") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}
function substituteArgs(content, args) {
  let result = content;
  result = result.replace(/\$@/g, args.join(" "));
  result = result.replace(/\$(\d+)/g, (_m, num) => {
    const idx = Number.parseInt(String(num), 10) - 1;
    return args[idx] ?? "";
  });
  return result;
}
function expandSlashCommand(text, fileCommands) {
  if (!text.startsWith("/")) return text;
  const spaceIndex = text.indexOf(" ");
  const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
  const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);
  const cmd = fileCommands.find((c) => c.name === commandName);
  if (!cmd) return text;
  const args = parseCommandArgs(argsString);
  return substituteArgs(cmd.content, args);
}

// src/acp/translate/bash.ts
function isBashTool(toolName) {
  return toolName.toLowerCase() === "bash";
}
function bashCommand(value) {
  const record = value;
  const command = record?.command ?? record?.cmd ?? record?.args?.command ?? record?.args?.cmd ?? record?.input?.command ?? record?.input?.cmd ?? record?.rawInput?.command ?? record?.rawInput?.cmd ?? record?.toolInput?.command ?? record?.toolInput?.cmd ?? record?.details?.command ?? record?.details?.cmd;
  return typeof command === "string" && command.trim() ? command : void 0;
}
function bashResultText(result) {
  const record = result;
  const content = record?.content;
  if (Array.isArray(content)) {
    const texts = content.map((c) => {
      const block = c;
      return block.type === "text" && typeof block.text === "string" ? block.text : "";
    }).filter(Boolean);
    if (texts.length) return texts.join("");
  }
  const details = record?.details;
  const stdout = (typeof details?.stdout === "string" ? details.stdout : void 0) ?? (typeof record?.stdout === "string" ? record.stdout : void 0) ?? (typeof details?.output === "string" ? details.output : void 0) ?? (typeof record?.output === "string" ? record.output : void 0);
  const stderr = (typeof details?.stderr === "string" ? details.stderr : void 0) ?? (typeof record?.stderr === "string" ? record.stderr : void 0);
  return [stdout, stderr].filter((part) => typeof part === "string" && part.length > 0).join("\n");
}
function bashExitCode(result, isError) {
  const record = result;
  const details = record?.details;
  const exitCode = details?.exitCode ?? record?.exitCode ?? details?.code ?? record?.code;
  return typeof exitCode === "number" ? exitCode : isError ? 1 : 0;
}
function bashOutputDelta(previous, next) {
  return next.startsWith(previous) ? next.slice(previous.length) : next;
}
function bashTerminalContent(toolCallId) {
  return [{ type: "terminal", terminalId: toolCallId }];
}
function bashTerminalInfoMeta(toolCallId, cwd) {
  return { terminal_info: { terminal_id: toolCallId, cwd } };
}
function bashTerminalOutputMeta(toolCallId, data) {
  return { terminal_output: { terminal_id: toolCallId, data } };
}
function bashTerminalExitMeta(toolCallId, exitCode) {
  return { terminal_exit: { terminal_id: toolCallId, exit_code: exitCode, signal: null } };
}

// src/acp/translate/pi-tools.ts
function toolResultToText(result) {
  if (!result) return "";
  const details = result?.details;
  const diff = details?.diff;
  if (typeof diff === "string" && diff.trim()) {
    return diff;
  }
  const content = result.content;
  if (Array.isArray(content)) {
    const texts = content.map((c) => c?.type === "text" && typeof c.text === "string" ? c.text : "").filter(Boolean);
    if (texts.length) return texts.join("");
  }
  const stdout = (typeof details?.stdout === "string" ? details.stdout : void 0) ?? (typeof result?.stdout === "string" ? result.stdout : void 0) ?? (typeof details?.output === "string" ? details.output : void 0) ?? (typeof result?.output === "string" ? result.output : void 0);
  const stderr = (typeof details?.stderr === "string" ? details.stderr : void 0) ?? (typeof result?.stderr === "string" ? result.stderr : void 0);
  const exitCode = (typeof details?.exitCode === "number" ? details.exitCode : void 0) ?? (typeof result?.exitCode === "number" ? result.exitCode : void 0) ?? (typeof details?.code === "number" ? details.code : void 0) ?? (typeof result?.code === "number" ? result.code : void 0);
  if (typeof stdout === "string" && stdout.trim() || typeof stderr === "string" && stderr.trim()) {
    const parts = [];
    if (typeof stdout === "string" && stdout.trim()) parts.push(stdout);
    if (typeof stderr === "string" && stderr.trim()) parts.push(`stderr:
${stderr}`);
    if (typeof exitCode === "number") parts.push(`exit code: ${exitCode}`);
    return parts.join("\n\n").trimEnd();
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

// src/acp/subagent-plan.ts
var SUBAGENT_PLAN_CUSTOM_TYPE = "acp:subagents";
var SUBAGENT_RECORD_CUSTOM_TYPE = "subagents:record";
var RESULT_PREVIEW_MAX = 2e3;
function parseSubagentEntry(data) {
  if (data == null || typeof data !== "object") return null;
  const rec = data;
  if (rec.clear === true) return { clear: true };
  if (typeof rec.id !== "string" || rec.id === "") return null;
  return {
    agent: {
      id: rec.id,
      type: typeof rec.type === "string" ? rec.type : void 0,
      description: typeof rec.description === "string" ? rec.description : void 0,
      status: typeof rec.status === "string" ? rec.status : void 0
    }
  };
}
function parseSubagentRecord(data) {
  if (data == null || typeof data !== "object") return null;
  const rec = data;
  if (typeof rec.id !== "string" || rec.id === "") return null;
  const started = typeof rec.startedAt === "number" ? rec.startedAt : void 0;
  const completed = typeof rec.completedAt === "number" ? rec.completedAt : void 0;
  const durationMs = started != null && completed != null && completed >= started ? completed - started : void 0;
  return {
    id: rec.id,
    type: typeof rec.type === "string" ? rec.type : void 0,
    description: typeof rec.description === "string" ? rec.description : void 0,
    status: typeof rec.status === "string" ? rec.status : void 0,
    result: typeof rec.result === "string" ? rec.result : void 0,
    error: typeof rec.error === "string" ? rec.error : void 0,
    durationMs
  };
}
var IN_PROGRESS_STATUSES = /* @__PURE__ */ new Set(["started", "running", "steered", "compacted"]);
var FAILED_STATUSES = /* @__PURE__ */ new Set(["failed", "stopped", "aborted", "error"]);
var TERMINAL_LABELS = {
  failed: "failed",
  error: "errored",
  stopped: "stopped",
  aborted: "aborted"
};
function statusRank(status) {
  const s = String(status ?? "").toLowerCase();
  if (s === "completed" || FAILED_STATUSES.has(s)) return 2;
  if (IN_PROGRESS_STATUSES.has(s)) return 1;
  return 0;
}
function mergeSubagent(prev, incoming) {
  const merged = { ...prev, ...incoming };
  if (prev?.type && !incoming.type) merged.type = prev.type;
  if (prev?.description && !incoming.description) merged.description = prev.description;
  if (prev) {
    const prevStatus = String(prev.status ?? "").toLowerCase();
    const incomingStatus = String(incoming.status ?? "").toLowerCase();
    const prevRank = statusRank(prevStatus);
    const incomingRank = statusRank(incomingStatus);
    if (prevRank > incomingRank) {
      merged.status = prev.status;
    } else if (prevRank === 2 && incomingRank === 2 && incomingStatus === "failed" && prevStatus !== "failed") {
      merged.status = prev.status;
    }
  }
  return merged;
}
function preview(text) {
  return text.length > RESULT_PREVIEW_MAX ? text.slice(0, RESULT_PREVIEW_MAX) + "\u2026" : text;
}
function toPlanEntry(agent2) {
  const label = agent2.description?.trim() || agent2.id;
  const content = agent2.type ? `[${agent2.type}] ${label}` : label;
  const status = String(agent2.status ?? "").toLowerCase();
  let planStatus2;
  let suffix = "";
  if (FAILED_STATUSES.has(status)) {
    planStatus2 = "completed";
    suffix = ` (${TERMINAL_LABELS[status] ?? "failed"})`;
  } else if (status === "completed") {
    planStatus2 = "completed";
  } else if (IN_PROGRESS_STATUSES.has(status)) {
    planStatus2 = "in_progress";
  } else {
    planStatus2 = "pending";
  }
  const entry = { content: content + suffix, priority: "medium", status: planStatus2 };
  const piAcp = { section: "agents" };
  const subagent = {};
  if (agent2.result) subagent.result = preview(agent2.result);
  if (agent2.error) subagent.error = preview(agent2.error);
  if (agent2.durationMs != null) subagent.durationMs = agent2.durationMs;
  if (Object.keys(subagent).length) piAcp.subagent = subagent;
  entry._meta = { piAcp };
  return entry;
}
function toPlanEntries(agents) {
  return Array.from(agents, toPlanEntry);
}

// src/acp/plan-bridge.ts
var PLAN_CUSTOM_TYPE = "acp:plan";
function newPlanState() {
  return { byNs: /* @__PURE__ */ new Map(), lastSeq: /* @__PURE__ */ new Map() };
}
function str(v) {
  return typeof v === "string" && v !== "" ? v : void 0;
}
function toItem(v) {
  if (v == null || typeof v !== "object") return null;
  const r = v;
  const id = str(r.id);
  if (!id) return null;
  const title = str(r.title) ?? str(r.name) ?? id;
  const deps = Array.isArray(r.deps) ? r.deps.filter((d) => typeof d === "string") : void 0;
  return {
    id,
    title,
    status: str(r.status),
    deps: deps && deps.length ? deps : void 0,
    kind: str(r.kind),
    tainted: typeof r.tainted === "boolean" ? r.tainted : void 0
  };
}
function parsePlanEntry(data) {
  if (data == null || typeof data !== "object") return null;
  const r = data;
  const op = str(r.op);
  if (op === "clear") return { op: "clear" };
  const ns = str(r.ns) ?? "default";
  const seq = typeof r.seq === "number" ? r.seq : void 0;
  if (op === "snapshot") {
    const items = Array.isArray(r.items) ? r.items.map(toItem).filter(Boolean) : [];
    return { op: "snapshot", ns, seq, items };
  }
  if (op === "update") {
    const upsert = Array.isArray(r.upsert) ? r.upsert.map(toItem).filter(Boolean) : void 0;
    const remove = Array.isArray(r.remove) ? r.remove.filter((d) => typeof d === "string") : void 0;
    return { op: "update", ns, seq, upsert, remove };
  }
  return null;
}
function applyPlanEntry(state, op) {
  if (op.op === "clear") {
    if (state.byNs.size === 0) return false;
    state.byNs.clear();
    state.lastSeq.clear();
    return true;
  }
  if (op.seq != null) {
    const last = state.lastSeq.get(op.ns);
    if (last != null && op.seq <= last) return false;
    state.lastSeq.set(op.ns, op.seq);
  }
  if (op.op === "snapshot") {
    const next = /* @__PURE__ */ new Map();
    for (const it of op.items) next.set(it.id, it);
    state.byNs.set(op.ns, next);
    return true;
  }
  const map = state.byNs.get(op.ns) ?? /* @__PURE__ */ new Map();
  let changed = false;
  for (const it of op.upsert ?? []) {
    map.set(it.id, it);
    changed = true;
  }
  for (const id of op.remove ?? []) {
    changed = map.delete(id) || changed;
  }
  if (changed) state.byNs.set(op.ns, map);
  return changed;
}
var DONE_STATUSES = /* @__PURE__ */ new Set(["done", "completed", "complete"]);
var IN_PROGRESS_STATUSES2 = /* @__PURE__ */ new Set(["in-progress", "in_progress", "active", "running", "started"]);
function planStatus(item) {
  const s = String(item.status ?? "").toLowerCase();
  if (DONE_STATUSES.has(s)) return "completed";
  if (IN_PROGRESS_STATUSES2.has(s)) return "in_progress";
  return "pending";
}
function toPlanEntry2(item) {
  const kindPrefix = item.kind && item.kind !== "plan" ? `(${item.kind}) ` : "";
  const taintSuffix = item.tainted ? " (tainted)" : "";
  return {
    content: `${kindPrefix}${item.title}${taintSuffix}`,
    priority: "medium",
    status: planStatus(item),
    // Tag the section so a client can group the cribsheet plan apart from the subagent fleet
    // (ACP plans are a flat list with no native sections).
    _meta: { piAcp: { section: "plan" } }
  };
}
function toPlanEntries2(state) {
  const entries = [];
  for (const map of state.byNs.values()) {
    for (const item of map.values()) entries.push(toPlanEntry2(item));
  }
  return entries;
}

// src/acp/session.ts
var CONFIRM_PERMISSION_OPTIONS = [
  { optionId: "yes", name: "Yes", kind: "allow_once" },
  { optionId: "no", name: "No", kind: "reject_once" }
];
var EXTENSION_UI_RAW_INPUT_KEYS = ["title", "message", "options", "placeholder", "prefill"];
var CHOICE_OPTION_PREFIX = "choice-";
function findUniqueLineNumber(text, needle) {
  if (!needle) return void 0;
  const first = text.indexOf(needle);
  if (first < 0) return void 0;
  const second = text.indexOf(needle, first + needle.length);
  if (second >= 0) return void 0;
  let line = 1;
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}
function getToolPath(args) {
  const record = args;
  if (typeof record?.path === "string") return record.path;
  if (typeof record?.file_path === "string") return record.file_path;
  return void 0;
}
function getParsedEdits(args) {
  const record = args;
  const parsed = [];
  if (typeof record?.oldText === "string" && typeof record?.newText === "string") {
    parsed.push({ oldText: record.oldText, newText: record.newText });
  }
  let edits = record?.edits;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      edits = void 0;
    }
  }
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const item = edit;
      if (typeof item?.oldText === "string" && typeof item?.newText === "string") {
        parsed.push({ oldText: item.oldText, newText: item.newText });
      }
    }
  }
  return parsed;
}
function getEditOldTexts(args) {
  const record = args;
  const oldTexts = getParsedEdits(args).map((edit) => edit.oldText);
  if (typeof record?.oldText === "string" && !oldTexts.includes(record.oldText)) oldTexts.push(record.oldText);
  let edits = record?.edits;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      edits = void 0;
    }
  }
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const oldText = edit?.oldText;
      if (typeof oldText === "string" && !oldTexts.includes(oldText)) oldTexts.push(oldText);
    }
  }
  return oldTexts;
}
function toToolCallLocations(args, cwd, line) {
  const path = getToolPath(args);
  if (!path) return void 0;
  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path);
  return [{ path: resolvedPath, ...typeof line === "number" ? { line } : {} }];
}
var SessionManager = class {
  sessions = /* @__PURE__ */ new Map();
  store = new SessionStore();
  /** Dispose all sessions and their underlying pi subprocesses. */
  disposeAll() {
    for (const [id] of this.sessions) this.close(id);
  }
  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId) {
    return this.sessions.get(sessionId);
  }
  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  close(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    try {
      s.proc.dispose?.();
    } catch {
    }
    this.sessions.delete(sessionId);
  }
  /** Snapshot of currently-registered session ids (used to make close-others concurrency-safe). */
  sessionIds() {
    return [...this.sessions.keys()];
  }
  /**
   * Close all sessions except `keepSessionId`. Pass `among` (a snapshot of ids taken before this
   * operation began) to close only those, so a session created concurrently — e.g. a second
   * `newSession` still initializing — is never disposed out from under its own request.
   */
  closeAllExcept(keepSessionId, among) {
    const ids = among ?? [...this.sessions.keys()];
    for (const id of ids) {
      if (id === keepSessionId) continue;
      this.close(id);
    }
  }
  async create(params) {
    let proc;
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        piCommand: params.piCommand,
        additionalDirectories: params.additionalDirectories,
        mcpConfigPayload: params.mcpConfigPayload,
        rpcTimeoutMs: params.rpcTimeoutMs
      });
    } catch (e) {
      if (e instanceof PiRpcSpawnError) {
        throw RequestError2.internalError({ code: e.code }, e.message);
      }
      throw e;
    }
    let state = null;
    try {
      state = await proc.getState();
    } catch {
      state = null;
    }
    const sessionId = typeof state?.sessionId === "string" ? state.sessionId : crypto.randomUUID();
    const sessionFile = typeof state?.sessionFile === "string" ? state.sessionFile : null;
    if (sessionFile) {
      this.store.upsert({ sessionId, cwd: params.cwd, sessionFile });
    }
    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      additionalDirectories: params.additionalDirectories ?? [],
      clientCapabilities: params.clientCapabilities
    });
    this.sessions.set(sessionId, session);
    return session;
  }
  get(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) throw RequestError2.invalidParams(`Unknown sessionId: ${sessionId}`);
    return s;
  }
  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered.
   */
  getOrCreate(sessionId, params) {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      additionalDirectories: params.additionalDirectories ?? [],
      clientCapabilities: params.clientCapabilities
    });
    this.sessions.set(sessionId, session);
    return session;
  }
};
var PiAcpSession = class {
  sessionId;
  cwd;
  mcpServers;
  additionalDirectories;
  clientCapabilities;
  startupInfo = null;
  startupInfoSent = false;
  proc;
  conn;
  fileCommands;
  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  cancelRequested = false;
  // Current in-flight turn (if any). Additional prompts are queued.
  pendingTurn = null;
  turnQueue = [];
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  currentToolCalls = /* @__PURE__ */ new Map();
  // Accumulated pi-subagents fleet (from `acp:subagents` custom entries), keyed by agent id.
  subagentFleet = /* @__PURE__ */ new Map();
  planState = newPlanState();
  // For ACP diff support: capture file contents before edit/write mutations,
  // then emit ToolCallContent {type:"diff"}. Compatible structured edit/write
  // events may need to be implemented in pi in the future.
  fileSnapshots = /* @__PURE__ */ new Map();
  fileMutationToolCallIds = /* @__PURE__ */ new Set();
  bashToolCallIds = /* @__PURE__ */ new Set();
  bashOutputSnapshots = /* @__PURE__ */ new Map();
  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  lastEmit = Promise.resolve();
  constructor(opts) {
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd;
    this.mcpServers = opts.mcpServers;
    this.additionalDirectories = opts.additionalDirectories ?? [];
    this.proc = opts.proc;
    this.conn = opts.conn;
    this.fileCommands = opts.fileCommands ?? [];
    this.clientCapabilities = opts.clientCapabilities;
    this.proc.onEvent((ev) => this.handlePiEvent(ev));
    this.proc.onExit(() => this.handleProcExit());
  }
  /**
   * pi died (crash, kill, or shutdown). Any in-flight or queued turn will never receive
   * `agent_settled`, so settle them now instead of leaving the ACP `session/prompt` request hanging.
   */
  handleProcExit() {
    const reason = this.cancelRequested ? "cancelled" : "error";
    const pending = this.pendingTurn;
    const queued = this.turnQueue.splice(0, this.turnQueue.length);
    this.pendingTurn = null;
    if (!pending && queued.length === 0) return;
    void this.flushEmits().finally(() => {
      pending?.resolve(reason);
      for (const t of queued) t.resolve(reason);
    });
  }
  setStartupInfo(text) {
    this.startupInfo = text;
    this.startupInfoSent = false;
  }
  /**
   * Best-effort attempt to send startup info outside of a prompt turn.
   * Some clients (e.g. Zed) may only render agent messages once the UI is ready;
   * callers can invoke this shortly after session/new returns.
   */
  sendStartupInfoIfPending() {
    if (this.startupInfoSent || !this.startupInfo) return;
    this.startupInfoSent = true;
    this.emit({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: this.startupInfo }
    });
  }
  async prompt(message, images = []) {
    const expandedMessage = expandSlashCommand(message, this.fileCommands);
    const turnPromise = new Promise((resolve5, reject) => {
      const queued = { message: expandedMessage, images, resolve: resolve5, reject };
      if (this.pendingTurn) {
        this.turnQueue.push(queued);
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `Queued message (position ${this.turnQueue.length}).`
          }
        });
        this.emit({
          sessionUpdate: "session_info_update",
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
        });
        return;
      }
      this.startTurn(queued);
    });
    return turnPromise;
  }
  async cancel() {
    this.cancelRequested = true;
    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length);
      for (const t of queued) t.resolve("cancelled");
      this.emit({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Cleared queued prompts." }
      });
      this.emit({
        sessionUpdate: "session_info_update",
        _meta: { piAcp: { queueDepth: 0, running: Boolean(this.pendingTurn) } }
      });
    }
    await this.proc.abort();
  }
  wasCancelRequested() {
    return this.cancelRequested;
  }
  emit(update) {
    this.lastEmit = this.lastEmit.then(
      () => this.conn.sessionUpdate({
        sessionId: this.sessionId,
        update
      })
    ).catch(() => {
    });
  }
  async flushEmits() {
    await this.lastEmit;
  }
  /**
   * Whether this client can render ACP terminals. Bash tool calls use the terminal `_meta`
   * channel (terminal_output/terminal_exit) only when true; otherwise output is folded into a
   * plain `content` text block so terminal-less clients (e.g. CodeCompanion) still render bash
   * results instead of an empty shell.
   */
  clientSupportsTerminal() {
    return this.clientCapabilities?.terminal === true;
  }
  emitBashToolCall(params) {
    this.bashToolCallIds.add(params.toolCallId);
    const useTerminal = params.includeTerminal && this.clientSupportsTerminal();
    this.emit({
      sessionUpdate: params.sessionUpdate,
      toolCallId: params.toolCallId,
      title: bashCommand(params.args) ?? params.toolName,
      kind: "execute",
      status: params.status,
      locations: params.locations,
      // Terminal-capable clients render the embedded terminal; terminal-less clients get the raw
      // command as structured input so it renders as a proper tool call, not loose text.
      ...useTerminal ? {
        content: bashTerminalContent(params.toolCallId),
        _meta: bashTerminalInfoMeta(params.toolCallId, this.cwd)
      } : { rawInput: params.args }
    });
  }
  emitBashOutputUpdate(params) {
    const text = bashResultText(params.result);
    const previous = this.bashOutputSnapshots.get(params.toolCallId) ?? "";
    const delta = bashOutputDelta(previous, text);
    this.bashOutputSnapshots.set(params.toolCallId, text);
    const isDone = params.status === "completed" || params.status === "failed";
    if (!this.clientSupportsTerminal()) {
      const exitCode = bashExitCode(params.result, Boolean(params.isError));
      const body = isDone && exitCode !== 0 ? `${text}

exit code: ${exitCode}` : text;
      this.emit({
        sessionUpdate: "tool_call_update",
        toolCallId: params.toolCallId,
        status: params.status,
        content: body ? [{ type: "content", content: { type: "text", text: body } }] : void 0,
        rawOutput: params.result
      });
      return;
    }
    this.emit({
      sessionUpdate: "tool_call_update",
      toolCallId: params.toolCallId,
      status: params.status,
      _meta: {
        ...delta ? bashTerminalOutputMeta(params.toolCallId, delta) : {},
        ...isDone ? bashTerminalExitMeta(params.toolCallId, bashExitCode(params.result, Boolean(params.isError))) : {}
      }
    });
  }
  cleanupToolCall(toolCallId) {
    this.currentToolCalls.delete(toolCallId);
    this.fileSnapshots.delete(toolCallId);
    this.fileMutationToolCallIds.delete(toolCallId);
    this.bashToolCallIds.delete(toolCallId);
    this.bashOutputSnapshots.delete(toolCallId);
  }
  startTurn(t) {
    this.cancelRequested = false;
    this.pendingTurn = { resolve: t.resolve, reject: t.reject };
    this.emit({
      sessionUpdate: "session_info_update",
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
    });
    this.proc.prompt(t.message, t.images).catch((err) => {
      void this.flushEmits().finally(() => {
        const authErr = maybeAuthRequiredError(err);
        if (authErr) {
          this.pendingTurn?.reject(authErr);
        } else {
          const reason = this.cancelRequested ? "cancelled" : "error";
          this.pendingTurn?.resolve(reason);
        }
        this.pendingTurn = null;
        this.emit({
          sessionUpdate: "session_info_update",
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: false } }
        });
      });
      void err;
    });
  }
  handlePiEvent(ev) {
    const type = String(ev.type ?? "");
    switch (type) {
      case "message_update": {
        const ame = ev.assistantMessageEvent;
        if (ame?.type === "text_delta" && typeof ame.delta === "string") {
          this.emit({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: ame.delta }
          });
          break;
        }
        if (ame?.type === "thinking_delta" && typeof ame.delta === "string") {
          this.emit({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: ame.delta }
          });
          break;
        }
        if (ame?.type === "toolcall_start" || ame?.type === "toolcall_delta" || ame?.type === "toolcall_end") {
          const toolCall = (
            // pi sometimes includes the tool call directly on the event
            ame?.toolCall ?? // ...and always includes it in the partial assistant message at contentIndex
            ame?.partial?.content?.[ame?.contentIndex ?? 0]
          );
          const toolCallId = String(toolCall?.id ?? "");
          const toolName = String(toolCall?.name ?? "tool");
          if (toolCallId) {
            const rawInput = toolCall?.arguments && typeof toolCall.arguments === "object" ? toolCall.arguments : (() => {
              const s = String(toolCall?.partialArgs ?? "");
              if (!s) return void 0;
              try {
                return JSON.parse(s);
              } catch {
                return { partialArgs: s };
              }
            })();
            const locations = toToolCallLocations(rawInput, this.cwd);
            const existingStatus = this.currentToolCalls.get(toolCallId);
            const status = existingStatus ?? "pending";
            if (isBashTool(toolName)) {
              if (!existingStatus) this.currentToolCalls.set(toolCallId, "pending");
              this.emitBashToolCall({
                sessionUpdate: existingStatus ? "tool_call_update" : "tool_call",
                toolCallId,
                toolName,
                args: rawInput,
                status,
                locations,
                includeTerminal: !existingStatus
              });
            } else if (!existingStatus) {
              this.currentToolCalls.set(toolCallId, "pending");
              this.emit({
                sessionUpdate: "tool_call",
                toolCallId,
                title: toolName,
                kind: toToolKind(toolName),
                status,
                locations,
                rawInput
              });
            } else {
              this.emit({
                sessionUpdate: "tool_call_update",
                toolCallId,
                status,
                locations,
                rawInput
              });
            }
          }
          break;
        }
        break;
      }
      case "tool_execution_start": {
        const toolCallId = String(ev.toolCallId ?? crypto.randomUUID());
        const toolName = String(ev.toolName ?? "tool");
        const args = ev.args;
        let line;
        if (isBashTool(toolName)) {
          const locations2 = toToolCallLocations(args, this.cwd);
          const existingStatus = this.currentToolCalls.get(toolCallId);
          this.currentToolCalls.set(toolCallId, "in_progress");
          this.emitBashToolCall({
            sessionUpdate: existingStatus ? "tool_call_update" : "tool_call",
            toolCallId,
            toolName,
            args,
            status: "in_progress",
            locations: locations2,
            includeTerminal: !existingStatus
          });
          break;
        }
        const isFileMutation = toolName === "edit" || toolName === "write";
        let snapshotOldText;
        if (isFileMutation) {
          this.fileMutationToolCallIds.add(toolCallId);
          const p = getToolPath(args);
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p);
              snapshotOldText = readFileSync5(abs, "utf8");
              this.fileSnapshots.set(toolCallId, { path: p, oldText: snapshotOldText });
              if (toolName === "edit") {
                for (const needle of getEditOldTexts(args)) {
                  line = findUniqueLineNumber(snapshotOldText, needle);
                  if (typeof line === "number") break;
                }
              }
            } catch {
              snapshotOldText = null;
              this.fileSnapshots.set(toolCallId, { path: p, oldText: null });
            }
          }
        }
        const locations = toToolCallLocations(args, this.cwd, line);
        if (!this.currentToolCalls.has(toolCallId)) {
          this.currentToolCalls.set(toolCallId, "in_progress");
          this.emit({
            sessionUpdate: "tool_call",
            toolCallId,
            title: toolName,
            kind: toToolKind(toolName),
            status: "in_progress",
            locations,
            rawInput: args
          });
        } else {
          this.currentToolCalls.set(toolCallId, "in_progress");
          this.emit({
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
            locations,
            rawInput: args
          });
        }
        break;
      }
      case "tool_execution_update": {
        const toolCallId = String(ev.toolCallId ?? "");
        if (!toolCallId) break;
        const partial = ev.partialResult;
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({ toolCallId, status: "in_progress", result: partial });
          break;
        }
        const text = this.fileMutationToolCallIds.has(toolCallId) ? "" : toolResultToText(partial);
        this.emit({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "in_progress",
          content: text ? [{ type: "content", content: { type: "text", text } }] : void 0,
          ...this.fileMutationToolCallIds.has(toolCallId) ? {} : { rawOutput: partial }
        });
        break;
      }
      case "tool_execution_end": {
        const toolCallId = String(ev.toolCallId ?? "");
        if (!toolCallId) break;
        const result = ev.result;
        const isError = Boolean(ev.isError);
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({
            toolCallId,
            status: isError ? "failed" : "completed",
            result,
            isError
          });
          this.cleanupToolCall(toolCallId);
          break;
        }
        const text = toolResultToText(result);
        const snapshot = this.fileSnapshots.get(toolCallId);
        let content;
        let hasStructuredDiff = false;
        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path);
            const newText = readFileSync5(abs, "utf8");
            if (snapshot.oldText === null || newText !== snapshot.oldText) {
              hasStructuredDiff = true;
              content = [
                {
                  type: "diff",
                  path: snapshot.path,
                  oldText: snapshot.oldText,
                  newText
                }
              ];
            }
          } catch {
          }
        }
        if (!content && !hasStructuredDiff && text) {
          content = [{ type: "content", content: { type: "text", text } }];
        }
        this.emit({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: isError ? "failed" : "completed",
          content,
          ...hasStructuredDiff ? {} : { rawOutput: result }
        });
        this.cleanupToolCall(toolCallId);
        break;
      }
      case "extension_ui_request": {
        void this.handleExtensionUiRequest(ev).catch(() => {
          const id = stringProp(ev, "id");
          if (!id) {
            return;
          }
          void this.proc.sendExtensionUiResponse({ id, cancelled: true }).catch(() => {
          });
        });
        break;
      }
      case "auto_retry_start": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: formatAutoRetryMessage(ev) }
        });
        break;
      }
      case "auto_retry_end": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Retry finished, resuming." }
        });
        break;
      }
      case "auto_compaction_start": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Context nearing limit, running automatic compaction..."
          }
        });
        break;
      }
      case "auto_compaction_end": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Automatic compaction finished; context was summarized to continue the session."
          }
        });
        break;
      }
      case "entry_appended": {
        this.handleSubagentEntry(ev.entry);
        break;
      }
      case "agent_start": {
        break;
      }
      case "turn_end": {
        break;
      }
      case "agent_end": {
        break;
      }
      case "agent_settled": {
        void this.flushEmits().finally(() => {
          const reason = this.cancelRequested ? "cancelled" : "end_turn";
          this.pendingTurn?.resolve(reason);
          this.pendingTurn = null;
          const next = this.turnQueue.shift();
          if (next) {
            this.emit({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `Starting queued message. (${this.turnQueue.length} remaining)` }
            });
            this.startTurn(next);
          } else {
            this.emit({
              sessionUpdate: "session_info_update",
              _meta: { piAcp: { queueDepth: 0, running: false } }
            });
          }
        });
        break;
      }
      default:
        break;
    }
  }
  async handleExtensionUiRequest(ev) {
    const id = stringProp(ev, "id");
    const method = stringProp(ev, "method");
    if (!id) {
      return;
    }
    if (method === "select") {
      await this.handleExtensionSelect(ev, id);
      return;
    }
    if (method === "confirm") {
      await this.handleExtensionConfirm(ev, id);
      return;
    }
    if (method === "input" || method === "editor") {
      this.emit({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `Pi ${method} UI request is not supported in ACP yet; cancelling it.`
        }
      });
      await this.proc.sendExtensionUiResponse({ id, cancelled: true });
      return;
    }
    if (method === "notify") {
      this.emit({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: stringProp(ev, "message") ?? "Pi notification" },
        _meta: { piAcp: { notify: { level: stringProp(ev, "notifyType") ?? "info" } } }
      });
      await this.proc.sendExtensionUiResponse({ id, cancelled: true });
      return;
    }
    await this.proc.sendExtensionUiResponse({ id, cancelled: true });
  }
  /**
   * Accumulate plan + subagent state from custom entries forwarded over RPC as `entry_appended`,
   * and emit a single combined ACP `plan`. Three sources feed it:
   *  - `acp:subagents` (our bundled extension): live subagent lifecycle records, or `{ clear: true }`.
   *  - `subagents:record` (pi-subagents' own): the final subagent status + result/error + timing.
   *  - `acp:plan` (our bundled extension): cribsheet-style plan snapshots/updates (see plan-bridge.ts).
   * The emitted plan lists the cribsheet plan first, then the live subagent fleet.
   */
  handleSubagentEntry(entry) {
    const e = entry;
    if (e?.type !== "custom") return;
    let changed = false;
    if (e.customType === SUBAGENT_PLAN_CUSTOM_TYPE) {
      const parsed = parseSubagentEntry(e.data);
      if (!parsed) return;
      if ("clear" in parsed) {
        this.subagentFleet.clear();
      } else {
        this.subagentFleet.set(parsed.agent.id, mergeSubagent(this.subagentFleet.get(parsed.agent.id), parsed.agent));
      }
      changed = true;
    } else if (e.customType === SUBAGENT_RECORD_CUSTOM_TYPE) {
      const rec = parseSubagentRecord(e.data);
      if (!rec) return;
      this.subagentFleet.set(rec.id, mergeSubagent(this.subagentFleet.get(rec.id), rec));
      changed = true;
    } else if (e.customType === PLAN_CUSTOM_TYPE) {
      const op = parsePlanEntry(e.data);
      if (!op) return;
      changed = applyPlanEntry(this.planState, op);
    }
    if (changed) {
      if (getPiAcpDebug()) {
        const fleet = Array.from(this.subagentFleet.values(), (a) => `${a.id.slice(0, 8)}=${a.status ?? "?"}`).join(", ");
        const planCount = toPlanEntries2(this.planState).length;
        process.stderr.write(`[pi-acp] entry (${String(e.customType)}) -> plan:${planCount} fleet:[${fleet}]
`);
      }
      this.emit({
        sessionUpdate: "plan",
        entries: [...toPlanEntries2(this.planState), ...toPlanEntries(this.subagentFleet.values())]
      });
    }
  }
  async handleExtensionSelect(ev, id) {
    const rawOptions = ev.options;
    const options = Array.isArray(rawOptions) ? rawOptions.map((option) => String(option)) : [];
    if (!options.length) {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true });
      return;
    }
    const permissionOptions = options.map((name, index2) => ({
      optionId: `${CHOICE_OPTION_PREFIX}${index2}`,
      name,
      kind: "allow_once"
    }));
    const selected = await this.requestExtensionPermission(id, ev, permissionOptions);
    if (selected === null) {
      return;
    }
    const selectedOptionId = selected.outcome.outcome === "selected" ? selected.outcome.optionId : null;
    const index = selectedOptionId === null ? null : optionIndex(selectedOptionId);
    const value = index === null ? null : options.at(index) ?? null;
    await this.proc.sendExtensionUiResponse(value === null ? { id, cancelled: true } : { id, value });
  }
  async handleExtensionConfirm(ev, id) {
    const selected = await this.requestExtensionPermission(id, ev, CONFIRM_PERMISSION_OPTIONS);
    if (selected === null) {
      return;
    }
    if (selected.outcome.outcome === "cancelled") {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true });
      return;
    }
    await this.proc.sendExtensionUiResponse({ id, confirmed: selected.outcome.optionId === "yes" });
  }
  async requestExtensionPermission(id, ev, options) {
    try {
      return await this.conn.requestPermission({
        sessionId: this.sessionId,
        toolCall: extensionUiToolCall(id, ev),
        options
      });
    } catch {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true });
      return null;
    }
  }
};
function extensionUiToolCall(id, ev) {
  const method = stringProp(ev, "method") ?? "ui";
  const title = stringProp(ev, "title") ?? `Pi ${method}`;
  const rawInput = { method };
  for (const key of EXTENSION_UI_RAW_INPUT_KEYS) {
    if (Object.hasOwn(ev, key)) rawInput[key] = ev[key];
  }
  return {
    toolCallId: `pi-ui-${id}`,
    title,
    kind: "other",
    status: "pending",
    rawInput
  };
}
function stringProp(source, key) {
  const value = source[key];
  return typeof value === "string" ? value : null;
}
function optionIndex(optionId) {
  if (!optionId.startsWith(CHOICE_OPTION_PREFIX)) {
    return null;
  }
  const rawIndex = optionId.slice(CHOICE_OPTION_PREFIX.length);
  if (!rawIndex) {
    return null;
  }
  const index = Number(rawIndex);
  return Number.isSafeInteger(index) && index >= 0 && String(index) === rawIndex ? index : null;
}
function formatAutoRetryMessage(ev) {
  const attempt = Number(ev.attempt);
  const maxAttempts = Number(ev.maxAttempts);
  const delayMs = Number(ev.delayMs);
  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return "Retrying...";
  }
  let delaySeconds = Math.round(delayMs / 1e3);
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1;
  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`;
}
function toToolKind(toolName) {
  switch (toolName) {
    case "read":
      return "read";
    case "write":
    case "edit":
      return "edit";
    case "bash":
      return "execute";
    default:
      return "other";
  }
}

// src/acp/pi-sessions.ts
import { readdirSync as readdirSync2, readFileSync as readFileSync6, statSync, openSync, readSync, closeSync, existsSync as existsSync5 } from "fs";
import { homedir as homedir4 } from "os";
import { join as join6, resolve as resolve4, isAbsolute as isAbsolute2 } from "path";
var DEFAULT_TAIL_BYTES = 256 * 1024;
var DEFAULT_HEAD_BYTES = 64 * 1024;
function getPiAgentDir() {
  return process.env.PI_CODING_AGENT_DIR ? resolve4(process.env.PI_CODING_AGENT_DIR) : join6(homedir4(), ".pi", "agent");
}
function readSessionDirFromSettings(agentDir) {
  const settingsPath = join6(agentDir, "settings.json");
  try {
    if (!existsSync5(settingsPath)) return null;
    const raw = readFileSync6(settingsPath, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const sessionDir = data.sessionDir;
    if (typeof sessionDir !== "string" || !sessionDir.trim()) return null;
    return isAbsolute2(sessionDir) ? sessionDir : resolve4(agentDir, sessionDir);
  } catch {
    return null;
  }
}
function getPiSessionsDir() {
  const agentDir = getPiAgentDir();
  return readSessionDirFromSettings(agentDir) ?? join6(agentDir, "sessions");
}
function walkJsonlFiles(dir, out) {
  let entries;
  try {
    entries = readdirSync2(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }
  for (const e of entries) {
    const name = typeof e.name === "string" ? e.name : String(e.name);
    const p = join6(dir, name);
    if (e.isDirectory()) walkJsonlFiles(p, out);
    else if (e.isFile() && name.endsWith(".jsonl")) out.push(p);
  }
}
function readFirstLine(path) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(DEFAULT_HEAD_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n <= 0) return null;
    const s = buf.subarray(0, n).toString("utf-8");
    const idx = s.indexOf("\n");
    return idx === -1 ? s.trim() : s.slice(0, idx).trim();
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
    }
  }
}
function readTail(path, tailBytes = DEFAULT_TAIL_BYTES) {
  const st = statSync(path);
  const start = Math.max(0, st.size - tailBytes);
  const len = st.size - start;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, buf.length, start);
    return buf.subarray(0, n).toString("utf-8");
  } finally {
    try {
      closeSync(fd);
    } catch {
    }
  }
}
function parseSessionHeader(firstLine) {
  try {
    const obj = JSON.parse(firstLine);
    if (obj?.type !== "session") return null;
    const sessionId = typeof obj?.id === "string" ? obj.id : null;
    const cwd = typeof obj?.cwd === "string" ? obj.cwd : null;
    if (!sessionId || !cwd) return null;
    return { sessionId, cwd };
  } catch {
    return null;
  }
}
function pickTitleFromTail(tail) {
  const lines = tail.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj?.type === "session_info" && typeof obj?.name === "string" && obj.name.trim()) {
        return obj.name.trim();
      }
    } catch {
    }
  }
  return null;
}
function scanSessionInfoNameFromFile(path) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(256 * 1024);
    let leftover = "";
    let offset = 0;
    let lastName = null;
    while (true) {
      const n = readSync(fd, buf, 0, buf.length, offset);
      if (n <= 0) break;
      offset += n;
      const chunk = leftover + buf.subarray(0, n).toString("utf8");
      const lines = chunk.split(/\r?\n/);
      leftover = lines.pop() ?? "";
      for (const line0 of lines) {
        const line = line0.trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj?.type === "session_info" && typeof obj?.name === "string" && obj.name.trim()) {
            lastName = obj.name.trim();
          }
        } catch {
        }
      }
    }
    const tailLine = leftover.trim();
    if (tailLine) {
      try {
        const obj = JSON.parse(tailLine);
        if (obj?.type === "session_info" && typeof obj?.name === "string" && obj.name.trim()) {
          lastName = obj.name.trim();
        }
      } catch {
      }
    }
    return lastName;
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
    }
  }
}
function pickUpdatedAtFromTail(tail) {
  const lines = tail.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj?.type !== "message") continue;
      const ts = typeof obj?.timestamp === "string" ? obj.timestamp : null;
      if (!ts) continue;
      const d = new Date(ts);
      if (Number.isFinite(d.getTime())) return d.toISOString();
    } catch {
    }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const ts = typeof obj?.timestamp === "string" ? obj.timestamp : null;
      if (!ts) continue;
      const d = new Date(ts);
      if (Number.isFinite(d.getTime())) return d.toISOString();
    } catch {
    }
  }
  return null;
}
function pickFallbackTitleFromHead(path) {
  try {
    const raw = readFileSync6(path, { encoding: "utf8" });
    const lines = raw.split(/\r?\n/);
    for (const line0 of lines) {
      const line = line0.trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj?.type === "message" && obj?.message?.role === "user") {
          const content = obj?.message?.content;
          if (typeof content === "string") return content.slice(0, 80);
          if (Array.isArray(content)) {
            const t = content.find((c) => c?.type === "text" && typeof c?.text === "string");
            if (t?.text) return String(t.text).slice(0, 80);
          }
        }
      } catch {
      }
      if (lines.length > 2e3) break;
    }
  } catch {
  }
  return null;
}
function listPiSessions() {
  const sessionsDir = getPiSessionsDir();
  const files = [];
  walkJsonlFiles(sessionsDir, files);
  const items = [];
  for (const file of files) {
    const first = readFirstLine(file);
    if (!first) continue;
    const header = parseSessionHeader(first);
    if (!header) continue;
    let updatedAt = null;
    let title = null;
    try {
      const tail = readTail(file);
      title = pickTitleFromTail(tail);
      updatedAt = pickUpdatedAtFromTail(tail);
    } catch {
    }
    if (!title) {
      title = scanSessionInfoNameFromFile(file);
    }
    if (!updatedAt) {
      try {
        updatedAt = statSync(file).mtime.toISOString();
      } catch {
        updatedAt = null;
      }
    }
    if (!title) {
      title = pickFallbackTitleFromHead(file);
    }
    items.push({
      sessionId: header.sessionId,
      cwd: header.cwd,
      title,
      updatedAt,
      sessionFile: file
    });
  }
  items.sort((a, b) => {
    const aa = a.updatedAt ?? "";
    const bb = b.updatedAt ?? "";
    return bb.localeCompare(aa);
  });
  return items;
}
function findPiSession(sessionId) {
  const all = listPiSessions();
  return all.find((s) => s.sessionId === sessionId) ?? null;
}

// src/acp/translate/pi-messages.ts
function normalizePiMessageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => c?.type === "text" && typeof c.text === "string" ? c.text : "").filter(Boolean).join("");
}
function normalizePiAssistantText(content) {
  if (!Array.isArray(content)) return "";
  return content.map((c) => c?.type === "text" && typeof c.text === "string" ? c.text : "").filter(Boolean).join("");
}

// src/acp/translate/prompt.ts
function promptToPiMessage(blocks) {
  let message = "";
  const images = [];
  for (const b of blocks) {
    switch (b.type) {
      case "text":
        message += b.text;
        break;
      case "resource_link":
        message += `
[Context] ${b.uri}`;
        break;
      case "image": {
        images.push({
          type: "image",
          mimeType: b.mimeType,
          data: b.data
        });
        break;
      }
      case "resource": {
        const r = b.resource;
        const uri = typeof r?.uri === "string" ? r.uri : "(unknown)";
        if (typeof r?.text === "string") {
          const mime = typeof r?.mimeType === "string" ? r.mimeType : "text/plain";
          message += `
[Embedded Context] ${uri} (${mime})
${r.text}`;
        } else if (typeof r?.blob === "string") {
          const mime = typeof r?.mimeType === "string" ? r.mimeType : "application/octet-stream";
          const bytes = Buffer.byteLength(r.blob, "base64");
          message += `
[Embedded Context] ${uri} (${mime}, ${bytes} bytes)`;
        } else {
          message += `
[Embedded Context] ${uri}`;
        }
        break;
      }
      case "audio": {
        const bytes = Buffer.byteLength(b.data, "base64");
        message += `
[Audio] (${b.mimeType}, ${bytes} bytes) not supported by pi-acp`;
        break;
      }
      default:
        break;
    }
  }
  return { message, images };
}

// src/acp/pi-commands.ts
function describeFallback(c) {
  const source = typeof c.source === "string" ? c.source : "";
  const location = typeof c.location === "string" ? c.location : "";
  const parts = [];
  if (source) parts.push(source);
  if (location) parts.push(location);
  return parts.length ? `(${parts.join(":")})` : "(command)";
}
function toAvailableCommandsFromPiGetCommands(data, opts) {
  const enableSkillCommands = opts?.enableSkillCommands ?? true;
  const includeExtensionCommands = opts?.includeExtensionCommands ?? false;
  const root = data;
  const commandsRaw = Array.isArray(root?.commands) ? root.commands : Array.isArray(root?.data?.commands) ? root.data.commands : [];
  const out = [];
  for (const c of commandsRaw) {
    const name = typeof c?.name === "string" ? c.name.trim() : "";
    if (!name) continue;
    const source = typeof c?.source === "string" ? c.source : "";
    if (!includeExtensionCommands && source === "extension") continue;
    if (!enableSkillCommands && name.startsWith("skill:")) continue;
    const desc = typeof c?.description === "string" ? c.description.trim() : "";
    out.push({
      name,
      description: desc || describeFallback(c)
    });
  }
  return { commands: out, raw: commandsRaw };
}

// src/acp/mcp-config.ts
import { existsSync as existsSync6, readFileSync as readFileSync7, rmSync as rmSync3 } from "fs";
import { join as join7 } from "path";
var GENERATED_MARKER = "pi-acp";
function loadMcpPolicy(path = getPiAcpMcpPolicyPath()) {
  try {
    const raw = JSON.parse(readFileSync7(path, "utf-8"));
    if (!raw || typeof raw !== "object") return {};
    const obj = raw;
    const out = {};
    if (typeof obj.generate === "boolean" || obj.generate === "*") out.generate = obj.generate;
    else if (Array.isArray(obj.generate)) out.generate = obj.generate.filter((x) => typeof x === "string");
    if (Array.isArray(obj.exclude)) out.exclude = obj.exclude.filter((x) => typeof x === "string");
    const validExposures = ["codemode", "deferred", "direct", "hidden"];
    const asExposure = (v) => typeof v === "string" && validExposures.includes(v) ? v : void 0;
    out.defaultExposure = asExposure(obj.defaultExposure);
    if (!out.defaultExposure) delete out.defaultExposure;
    const exposureRaw = obj.exposure;
    if (exposureRaw && typeof exposureRaw === "object" && !Array.isArray(exposureRaw)) {
      const exposure = {};
      for (const [name, val] of Object.entries(exposureRaw)) {
        const parsed = asExposure(val);
        if (parsed) exposure[name] = parsed;
      }
      if (Object.keys(exposure).length) out.exposure = exposure;
    }
    if (obj.auth && typeof obj.auth === "object") {
      const auth = {};
      for (const [name, val] of Object.entries(obj.auth)) {
        if (!val || typeof val !== "object") continue;
        const v = val;
        const entry = {};
        if (typeof v.bearerTokenEnv === "string" && v.bearerTokenEnv) entry.bearerTokenEnv = v.bearerTokenEnv;
        if (v.headers && typeof v.headers === "object") {
          const headers = {};
          for (const [k, hv] of Object.entries(v.headers)) headers[k] = String(hv);
          if (Object.keys(headers).length) entry.headers = headers;
        }
        auth[name] = entry;
      }
      out.auth = auth;
    }
    return out;
  } catch {
    return {};
  }
}
function shouldGenerate(name, policy) {
  const lc = name.toLowerCase();
  if ((policy.exclude ?? []).some((n) => n.toLowerCase() === lc)) return false;
  const gen = policy.generate;
  if (gen === false) return false;
  if (gen === void 0 || gen === true || gen === "*") return true;
  return gen.some((n) => n.toLowerCase() === lc);
}
function lookup(map, name) {
  if (!map) return void 0;
  if (name in map) return map[name];
  const lc = name.toLowerCase();
  for (const key of Object.keys(map)) if (key.toLowerCase() === lc) return map[key];
  return void 0;
}
function toRecord(pairs) {
  const out = {};
  for (const p of pairs ?? []) {
    if (p && typeof p.name === "string") out[p.name] = String(p.value ?? "");
  }
  return out;
}
function translateMcpServers(servers, policy = {}) {
  const mcpServers = {};
  const skipped = [];
  const preserved = [];
  for (const server of servers ?? []) {
    const name = String(server.name ?? "").trim();
    if (!name) continue;
    if (!shouldGenerate(name, policy)) {
      preserved.push(name);
      continue;
    }
    const rule = lookup(policy.auth, name);
    const exposure = lookup(policy.exposure, name) ?? policy.defaultExposure;
    const type = server.type;
    if (!type || type === "stdio") {
      const stdio = server;
      const command = String(stdio.command ?? "").trim();
      if (!command) {
        skipped.push(name);
        continue;
      }
      const entry = {
        command,
        args: Array.isArray(stdio.args) ? stdio.args.map(String) : []
      };
      const env = toRecord(stdio.env);
      if (Object.keys(env).length) entry.env = env;
      if (exposure) entry.exposure = exposure;
      mcpServers[name] = entry;
    } else if (type === "http") {
      const http = server;
      const url = String(http.url ?? "").trim();
      if (!url) {
        skipped.push(name);
        continue;
      }
      const entry = { url };
      const headers = { ...toRecord(http.headers), ...rule?.headers ?? {} };
      if (rule?.bearerTokenEnv) headers["Authorization"] = `Bearer \${${rule.bearerTokenEnv}}`;
      if (Object.keys(headers).length) entry.headers = headers;
      if (exposure) entry.exposure = exposure;
      mcpServers[name] = entry;
    } else {
      skipped.push(name);
    }
  }
  return { config: { mcpServers, _generatedBy: GENERATED_MARKER }, skipped, preserved };
}
function isGeneratedConfig(path) {
  try {
    const existing = JSON.parse(readFileSync7(path, "utf-8"));
    return existing?._generatedBy === GENERATED_MARKER;
  } catch {
    return false;
  }
}
function encodeMcpConfig(servers, policy = loadMcpPolicy()) {
  const { config, skipped, preserved } = translateMcpServers(servers, policy);
  if (Object.keys(config.mcpServers).length === 0) {
    return { payload: null, skipped, preserved };
  }
  return { payload: Buffer.from(JSON.stringify(config), "utf-8").toString("base64"), skipped, preserved };
}
function cleanupStaleGeneratedConfig(cwd) {
  const path = join7(cwd, ".pi", "mcp.json");
  try {
    if (existsSync6(path) && isGeneratedConfig(path)) rmSync3(path, { force: true });
  } catch {
  }
}
function piMcpAdapterInstalled(cwd) {
  const settingsPaths = [join7(getAgentDir(), "settings.json"), join7(cwd, ".pi", "settings.json")];
  for (const p of settingsPaths) {
    try {
      const settings = JSON.parse(readFileSync7(p, "utf-8"));
      const pkgs = Array.isArray(settings.packages) ? settings.packages : [];
      if (pkgs.some((pkg2) => typeof pkg2 === "string" && pkg2.includes("pi-mcp-adapter"))) return true;
    } catch {
    }
  }
  return false;
}
function buildMcpNotice(cwd, result) {
  const lines = [];
  if (result.payload && piMcpAdapterInstalled(cwd)) {
    lines.push(
      "MCP servers were provided, but `pi-mcp-adapter` is installed and replaces pi's built-in MCP support, so they cannot be registered. Remove `pi-mcp-adapter` from your pi `packages` to use native MCP."
    );
  }
  if (result.preserved?.length) {
    lines.push(`MCP servers deferred to your existing config (auth policy): ${result.preserved.join(", ")}.`);
  }
  if (result.skipped.length) {
    lines.push(`Skipped MCP servers not expressible for pi (sse/acp): ${result.skipped.join(", ")}.`);
  }
  return lines.length ? lines.join("\n") : null;
}

// src/acp/agent.ts
import { isAbsolute as isAbsolute4 } from "path";
import { existsSync as existsSync7, readFileSync as readFileSync8, realpathSync, readdirSync as readdirSync3, statSync as statSync2, unlinkSync } from "fs";
import { join as join8, dirname as dirname4, basename } from "path";
import { spawnSync } from "child_process";

// src/acp/workspace-roots.ts
import { RequestError as RequestError3 } from "@agentclientprotocol/sdk";
import { isAbsolute as isAbsolute3, resolve as resolvePath2 } from "path";
function normalizeAdditionalDirectories(input2, cwd) {
  if (!input2 || input2.length === 0) return [];
  const resolvedCwd = resolvePath2(cwd);
  const out = [];
  for (const entry of input2) {
    if (typeof entry !== "string") {
      throw RequestError3.invalidParams(`additionalDirectories entries must be absolute paths: ${String(entry)}`);
    }
    const dir = entry.trim();
    if (!dir) continue;
    if (!isAbsolute3(dir)) {
      throw RequestError3.invalidParams(`additionalDirectories entries must be absolute paths: ${entry}`);
    }
    if (resolvePath2(dir) === resolvedCwd) continue;
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

// src/acp/agent.ts
import { fileURLToPath as fileURLToPath2 } from "url";
var MODEL_CONFIG_ID = "model";
var THOUGHT_LEVEL_CONFIG_ID = "thought_level";
function builtinAvailableCommands() {
  return [
    {
      name: "compact",
      description: "Manually compact the session context",
      input: { hint: "optional custom instructions" }
    },
    {
      name: "autocompact",
      description: "Toggle automatic context compaction",
      input: { hint: "on|off|toggle" }
    },
    {
      name: "export",
      description: "Export session to an HTML file in the session cwd"
    },
    {
      name: "session",
      description: "Show session stats (messages, tokens, cost, session file)"
    },
    {
      name: "name",
      description: "Set session display name",
      input: { hint: "<name>" }
    },
    {
      name: "steering",
      description: "Get/set pi steering message delivery mode (how queued steering messages are delivered)",
      input: { hint: "(no args to show) all | one-at-a-time" }
    },
    {
      name: "follow-up",
      description: "Get/set pi follow-up message delivery mode (how queued follow-up messages are delivered)",
      input: { hint: "(no args to show) all | one-at-a-time" }
    },
    {
      name: "changelog",
      description: "Show pi changelog"
    }
  ];
}
function mergeCommands(a, b) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const c of [...a, ...b]) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c);
  }
  return out;
}
var pkg = readNearestPackageJson(import.meta.url);
var PiAcpAgent = class {
  conn;
  sessions = new SessionManager();
  store = new SessionStore();
  restoringSessions = /* @__PURE__ */ new Map();
  // Full ACP client capabilities captured at initialize, threaded into every session so wire
  // features (terminals, plan, fs) can be gated per the client's advertised support.
  clientCapabilities;
  dispose() {
    this.sessions.disposeAll();
  }
  // Remember recent session cwd and use it as the default filter.
  lastSessionCwd = null;
  constructor(conn, _config) {
    this.conn = conn;
    void _config;
  }
  cleanupFailedNewSession(sessionId, state) {
    this.sessions.close(sessionId);
    const sessionFile = typeof state?.sessionFile === "string" && state.sessionFile.trim() ? state.sessionFile : this.store.get(sessionId)?.sessionFile;
    if (typeof sessionFile === "string" && sessionFile.trim()) {
      try {
        if (existsSync7(sessionFile)) unlinkSync(sessionFile);
      } catch {
      }
    }
    this.store.delete(sessionId);
  }
  findStoredSession(sessionId) {
    const stored = this.store.get(sessionId);
    if (stored?.cwd && stored?.sessionFile) {
      return { cwd: stored.cwd, sessionFile: stored.sessionFile };
    }
    const piSession = findPiSession(sessionId);
    if (!piSession) return null;
    this.store.upsert({
      sessionId,
      cwd: piSession.cwd,
      sessionFile: piSession.sessionFile
    });
    return {
      cwd: piSession.cwd,
      sessionFile: piSession.sessionFile
    };
  }
  async restoreSession(sessionId, opts) {
    const existing = this.sessions.maybeGet(sessionId);
    if (existing) return existing;
    const inFlight = this.restoringSessions.get(sessionId);
    if (inFlight) return inFlight;
    const restorePromise = (async () => {
      const stored = this.findStoredSession(sessionId);
      if (!stored) {
        throw RequestError4.invalidParams(`Unknown sessionId: ${sessionId}`);
      }
      const cwd = opts?.cwd ?? stored.cwd;
      cleanupStaleGeneratedConfig(cwd);
      const mcpConfig = encodeMcpConfig(opts?.mcpServers);
      let proc;
      try {
        proc = await PiRpcProcess.spawn({
          cwd,
          sessionPath: stored.sessionFile,
          piCommand: getPiCommandOverride(),
          additionalDirectories: opts?.additionalDirectories,
          mcpConfigPayload: mcpConfig.payload ?? void 0,
          rpcTimeoutMs: getRpcTimeoutMs()
        });
      } catch (e) {
        if (e?.name === "PiRpcSpawnError") {
          throw RequestError4.internalError({ code: e?.code }, String(e?.message ?? e));
        }
        throw e;
      }
      const fileCommands = loadSlashCommands(cwd);
      const session = this.sessions.getOrCreate(sessionId, {
        cwd,
        mcpServers: opts?.mcpServers ?? [],
        conn: this.conn,
        proc,
        fileCommands,
        additionalDirectories: opts?.additionalDirectories,
        clientCapabilities: this.clientCapabilities
      });
      this.lastSessionCwd = cwd;
      this.store.upsert({ sessionId, cwd, sessionFile: stored.sessionFile });
      return session;
    })();
    this.restoringSessions.set(sessionId, restorePromise);
    try {
      return await restorePromise;
    } finally {
      this.restoringSessions.delete(sessionId);
    }
  }
  async initialize(params) {
    this.clientCapabilities = params.clientCapabilities;
    ensurePiAcpSettingsFile();
    const supportedVersion = 1;
    const requested = params.protocolVersion;
    return {
      protocolVersion: requested === supportedVersion ? requested : supportedVersion,
      agentInfo: {
        name: pkg.name ?? "pi-acp",
        title: "pi ACP adapter",
        version: pkg.version ?? "0.0.0"
      },
      // Zed currently uses ClientCapabilities._meta["terminal-auth"] to decide whether to show
      // the "Authenticate" banner/button. If not supported, we still return the method for the registry.
      authMethods: getAuthMethods({
        supportsTerminalAuthMeta: params?.clientCapabilities?._meta?.["terminal-auth"] === true
      }),
      agentCapabilities: {
        loadSession: true,
        // stdio is the baseline; http servers are translated into pi's native MCP config shape
        // (streamable HTTP). sse/acp cannot be expressed — pi rejects `sse`.
        mcpCapabilities: { http: true, sse: false },
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: getEmbeddedContext()
        },
        sessionCapabilities: {
          // **UNSTABLE** ACP capability used by Zed's codex-acp adapter.
          // Enables a native session picker in clients that support it.
          list: {},
          delete: {},
          additionalDirectories: {},
          resume: {},
          close: {}
        }
      }
    };
  }
  async newSession(params) {
    if (!isAbsolute4(params.cwd)) {
      throw RequestError4.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
    }
    const additionalDirectories = normalizeAdditionalDirectories(params.additionalDirectories, params.cwd);
    this.lastSessionCwd = params.cwd;
    const preexistingSessionIds = this.sessions.sessionIds?.() ?? [];
    const fileCommands = loadSlashCommands(params.cwd);
    const enableSkillCommands = getEnableSkillCommands(params.cwd);
    cleanupStaleGeneratedConfig(params.cwd);
    const mcpConfig = encodeMcpConfig(params.mcpServers);
    const mcpNotice = buildMcpNotice(params.cwd, mcpConfig);
    const session = await this.sessions.create({
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      mcpConfigPayload: mcpConfig.payload ?? void 0,
      conn: this.conn,
      fileCommands,
      piCommand: getPiCommandOverride(),
      additionalDirectories,
      clientCapabilities: this.clientCapabilities,
      rpcTimeoutMs: getRpcTimeoutMs()
    });
    let state = null;
    let availableModels = null;
    let stateErr = null;
    let availableModelsErr = null;
    await Promise.all([
      session.proc.getState().then((s) => {
        state = s;
      }).catch((err) => {
        stateErr = err;
        state = null;
      }),
      session.proc.getAvailableModels().then((m) => {
        availableModels = m;
      }).catch((err) => {
        availableModelsErr = err;
        availableModels = null;
      })
    ]);
    const availableModelsAuthErr = maybeAuthRequiredError(availableModelsErr);
    if (availableModelsAuthErr) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw availableModelsAuthErr;
    }
    if (availableModelsErr) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw RequestError4.internalError({}, String(availableModelsErr?.message ?? availableModelsErr));
    }
    const rawModelsCount = Array.isArray(availableModels?.models) ? availableModels.models.length : 0;
    if (rawModelsCount === 0) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw RequestError4.authRequired(
        { authMethods: getAuthMethods() },
        "Configure an API key or log in with an OAuth provider."
      );
    }
    if (stateErr && maybeAuthRequiredError(stateErr)) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw RequestError4.authRequired(
        { authMethods: getAuthMethods() },
        "Configure an API key or log in with an OAuth provider."
      );
    }
    const { configOptions, models, modes } = await getSessionConfiguration(session.proc, {
      state,
      availableModels
    });
    const quietStartup = getQuietStartup(params.cwd);
    const updateNotice = buildUpdateNotice();
    const basePrelude = quietStartup ? updateNotice ? updateNotice + "\n" : "" : buildStartupInfo({
      cwd: params.cwd,
      fileCommands,
      updateNotice,
      additionalDirectories
    });
    const preludeText = mcpNotice ? `${basePrelude}${basePrelude ? "\n" : ""}${mcpNotice}
` : basePrelude;
    if (preludeText)
      session.setStartupInfo(preludeText);
    this.sessions.closeAllExcept?.(session.sessionId, preexistingSessionIds);
    const response = {
      sessionId: session.sessionId,
      configOptions,
      models,
      modes,
      _meta: {
        piAcp: {
          startupInfo: preludeText || null
        }
      }
    };
    if (preludeText) setTimeout(() => session.sendStartupInfoIfPending(), 0);
    setTimeout(() => {
      void (async () => {
        try {
          const pi = await session.proc.getCommands();
          const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
            enableSkillCommands,
            includeExtensionCommands: false
          });
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: mergeCommands(commands, builtinAvailableCommands())
            }
          });
          return;
        } catch {
        }
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: mergeCommands(toAvailableCommands(fileCommands), builtinAvailableCommands())
          }
        });
      })();
    }, 0);
    return response;
  }
  async authenticate(_params) {
    return;
  }
  async prompt(params) {
    const session = await this.restoreSession(params.sessionId);
    const { message, images } = promptToPiMessage(params.prompt);
    if (images.length === 0 && message.trimStart().startsWith("/")) {
      const trimmed = message.trim();
      const space = trimmed.indexOf(" ");
      const cmd = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space);
      const argsString = space === -1 ? "" : trimmed.slice(space + 1);
      const args = parseCommandArgs(argsString);
      if (cmd === "compact") {
        const customInstructions = args.join(" ").trim() || void 0;
        const res = await session.proc.compact(customInstructions);
        const r = res && typeof res === "object" ? res : null;
        const tokensBefore = typeof r?.tokensBefore === "number" ? r.tokensBefore : null;
        const summary = typeof r?.summary === "string" ? r.summary : null;
        const headerLines = [
          `Compaction completed.${customInstructions ? " (custom instructions applied)" : ""}`,
          tokensBefore !== null ? `Tokens before: ${tokensBefore}` : null
        ].filter(Boolean);
        const text = headerLines.join("\n") + (summary ? `

${summary}` : "");
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "session") {
        const stats = await session.proc.getSessionStats();
        const lines = [];
        if (stats?.sessionId) lines.push(`Session: ${stats.sessionId}`);
        if (stats?.sessionFile) lines.push(`Session file: ${stats.sessionFile}`);
        if (typeof stats?.totalMessages === "number") lines.push(`Messages: ${stats.totalMessages}`);
        if (typeof stats?.cost === "number") lines.push(`Cost: ${stats.cost}`);
        const t = stats?.tokens;
        if (t && typeof t === "object") {
          const parts = [];
          if (typeof t.input === "number") parts.push(`in ${t.input}`);
          if (typeof t.output === "number") parts.push(`out ${t.output}`);
          if (typeof t.cacheRead === "number") parts.push(`cache read ${t.cacheRead}`);
          if (typeof t.cacheWrite === "number") parts.push(`cache write ${t.cacheWrite}`);
          if (typeof t.total === "number") parts.push(`total ${t.total}`);
          if (parts.length) lines.push(`Tokens: ${parts.join(", ")}`);
        }
        const text = lines.length ? lines.join("\n") : `Session stats:
${JSON.stringify(stats, null, 2)}`;
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "name") {
        const name = args.join(" ").trim();
        if (!name) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Usage: /name <name>" }
            }
          });
          return { stopReason: "end_turn" };
        }
        try {
          await session.proc.setSessionName(name);
        } catch (e) {
          const msg = String(e?.message ?? e);
          const hint = /set_session_name/i.test(msg) ? " This requires a newer pi version that supports `set_session_name` in RPC mode." : "";
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `Failed to set session name: ${msg}${hint}` }
            }
          });
          return { stopReason: "end_turn" };
        }
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "session_info_update",
            title: name,
            updatedAt: (/* @__PURE__ */ new Date()).toISOString()
          }
        });
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Session name set: ${name}` }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "steering") {
        const modeRaw = String(args[0] ?? "").toLowerCase();
        const state = await session.proc.getState();
        const current = String(state?.steeringMode ?? "");
        if (!modeRaw) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `Steering mode: ${current || "unknown"}`
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        if (modeRaw !== "all" && modeRaw !== "one-at-a-time") {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Usage: /steering all | /steering one-at-a-time"
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        await session.proc.setSteeringMode(modeRaw);
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Steering mode set to: ${modeRaw}` }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "follow-up") {
        const modeRaw = String(args[0] ?? "").toLowerCase();
        const state = await session.proc.getState();
        const current = String(state?.followUpMode ?? "");
        if (!modeRaw) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `Follow-up mode: ${current || "unknown"}`
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        if (modeRaw !== "all" && modeRaw !== "one-at-a-time") {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Usage: /follow-up all | /follow-up one-at-a-time"
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        await session.proc.setFollowUpMode(modeRaw);
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Follow-up mode set to: ${modeRaw}` }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "changelog") {
        const findChangelog = () => {
          try {
            const whichCmd = process.platform === "win32" ? "where" : "which";
            const which = spawnSync(whichCmd, ["pi"], { encoding: "utf-8", timeout: 2e3 });
            const piPath = String(which.stdout ?? "").split(/\r?\n/)[0]?.trim();
            if (piPath) {
              const resolved = realpathSync(piPath);
              const pkgRoot = dirname4(dirname4(resolved));
              const p = join8(pkgRoot, "CHANGELOG.md");
              if (existsSync7(p)) return p;
            }
          } catch {
          }
          try {
            const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf-8", timeout: 2e3 });
            const root = String(npmRoot.stdout ?? "").trim();
            if (root) {
              const p = join8(root, "@earendil-works", "pi-coding-agent", "CHANGELOG.md");
              if (existsSync7(p)) return p;
            }
          } catch {
          }
          return null;
        };
        const changelogPath = findChangelog();
        if (!changelogPath) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Changelog not found (couldn't locate pi installation)." }
            }
          });
          return { stopReason: "end_turn" };
        }
        let text = "";
        try {
          text = readFileSync8(changelogPath, "utf-8");
        } catch (e) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `Failed to read changelog: ${String(e?.message ?? e)}` }
            }
          });
          return { stopReason: "end_turn" };
        }
        const maxChars = 2e4;
        if (text.length > maxChars) text = text.slice(0, maxChars) + "\n\n...(truncated)...";
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "export") {
        const state = await session.proc.getState();
        const sessionFile = typeof state?.sessionFile === "string" ? state.sessionFile : null;
        const messageCount = typeof state?.messageCount === "number" ? state.messageCount : 0;
        if (!sessionFile || messageCount === 0 || !existsSync7(sessionFile)) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Nothing to export yet (no session messages). Send a prompt first."
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        try {
          const raw = readFileSync8(sessionFile, "utf-8");
          if (raw.trim().length === 0) {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: "Nothing to export yet (empty session file). Send a prompt first."
                }
              }
            });
            return { stopReason: "end_turn" };
          }
        } catch {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Couldn't read session file for export. Try sending a prompt first."
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        const safeSessionId = session.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
        const outputPath = join8(session.cwd, `pi-session-${safeSessionId}.html`);
        let resultPath = "";
        try {
          const result2 = await session.proc.exportHtml(outputPath);
          resultPath = result2.path;
        } catch (e) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `Export failed: ${String(e?.message ?? e)}`
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        if (!resultPath) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Export failed: no output path returned by pi."
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        const uri = `file://${resultPath}`;
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "Session exported: "
            }
          }
        });
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "resource_link",
              name: `pi-session-${safeSessionId}.html`,
              uri,
              mimeType: "text/html",
              title: "Session exported"
            }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "autocompact") {
        const mode = (args[0] ?? "toggle").toLowerCase();
        let enabled = null;
        if (mode === "on" || mode === "true" || mode === "enable" || mode === "enabled") enabled = true;
        else if (mode === "off" || mode === "false" || mode === "disable" || mode === "disabled") enabled = false;
        if (enabled === null) {
          const state = await session.proc.getState();
          const current = Boolean(state?.autoCompactionEnabled);
          enabled = !current;
        }
        await session.proc.setAutoCompaction(enabled);
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `Auto-compaction ${enabled ? "enabled" : "disabled"}.`
            }
          }
        });
        return { stopReason: "end_turn" };
      }
    }
    const result = await session.prompt(message, images);
    const stopReason = result === "error" ? session.wasCancelRequested() ? "cancelled" : "end_turn" : result;
    return { stopReason };
  }
  async cancel(params) {
    const session = this.sessions.maybeGet(params.sessionId);
    if (!session) return;
    await session.cancel();
  }
  async listSessions(params) {
    const all = listPiSessions();
    const effectiveCwd = params.cwd ?? this.lastSessionCwd;
    const filtered = effectiveCwd ? all.filter((s) => s.cwd === effectiveCwd) : all;
    const offset = params.cursor ? Number.parseInt(params.cursor, 10) : 0;
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
    const PAGE_SIZE = 50;
    const page = filtered.slice(start, start + PAGE_SIZE);
    const sessions = page.map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      updatedAt: s.updatedAt
    }));
    const nextCursor = start + PAGE_SIZE < filtered.length ? String(start + PAGE_SIZE) : null;
    return { sessions, nextCursor, _meta: {} };
  }
  async loadSession(params) {
    if (!isAbsolute4(params.cwd)) {
      throw RequestError4.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
    }
    this.sessions.close(params.sessionId);
    this.lastSessionCwd = params.cwd;
    const stored = this.findStoredSession(params.sessionId);
    if (!stored) {
      throw RequestError4.invalidParams(`Unknown sessionId: ${params.sessionId}`);
    }
    const preexistingSessionIds = this.sessions.sessionIds?.() ?? [];
    const enableSkillCommands = getEnableSkillCommands(params.cwd);
    const additionalDirectories = normalizeAdditionalDirectories(params.additionalDirectories, params.cwd);
    const session = await this.restoreSession(params.sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      additionalDirectories
    });
    const proc = session.proc;
    const fileCommands = loadSlashCommands(params.cwd);
    this.sessions.closeAllExcept?.(session.sessionId, preexistingSessionIds);
    this.store.upsert({
      sessionId: params.sessionId,
      cwd: params.cwd,
      sessionFile: stored.sessionFile
    });
    const data = await proc.getMessages();
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    for (const m of messages) {
      const role = String(m?.role ?? "");
      if (role === "user") {
        const text = normalizePiMessageText(m?.content);
        if (text) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text }
            }
          });
        }
      }
      if (role === "assistant") {
        const text = normalizePiAssistantText(m?.content);
        if (text) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text }
            }
          });
        }
      }
      if (role === "toolResult") {
        const toolName = String(m?.toolName ?? "tool");
        const toolCallId = String(m?.toolCallId ?? crypto.randomUUID());
        const isError = Boolean(m?.isError);
        const isBash = isBashTool(toolName);
        if (isBash) {
          const text2 = bashResultText(m);
          if (this.clientCapabilities?.terminal !== true) {
            const exitCode = bashExitCode(m, isError);
            const body = exitCode !== 0 ? `${text2}

exit code: ${exitCode}` : text2;
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId,
                title: bashCommand(m) ?? toolName,
                kind: "execute",
                status: isError ? "failed" : "completed",
                content: body ? [{ type: "content", content: { type: "text", text: body } }] : void 0,
                rawOutput: m
              }
            });
            continue;
          }
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId,
              title: bashCommand(m) ?? toolName,
              kind: "execute",
              status: "completed",
              content: bashTerminalContent(toolCallId),
              _meta: bashTerminalInfoMeta(toolCallId, params.cwd)
            }
          });
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: isError ? "failed" : "completed",
              _meta: {
                ...text2 ? bashTerminalOutputMeta(toolCallId, text2) : {},
                ...bashTerminalExitMeta(toolCallId, bashExitCode(m, isError))
              }
            }
          });
          continue;
        }
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: toolName,
            kind: toolName === "read" ? "read" : toolName === "write" || toolName === "edit" ? "edit" : "other",
            status: "completed",
            rawInput: null,
            rawOutput: m
          }
        });
        const text = toolResultToText(m);
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: isError ? "failed" : "completed",
            content: text ? [{ type: "content", content: { type: "text", text } }] : null,
            rawOutput: m
          }
        });
      }
    }
    const { configOptions, models, modes } = await getSessionConfiguration(proc);
    const response = {
      configOptions,
      models,
      modes,
      _meta: {
        piAcp: {
          startupInfo: null
        }
      }
    };
    setTimeout(() => {
      void (async () => {
        try {
          const pi = await proc.getCommands();
          const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
            enableSkillCommands,
            includeExtensionCommands: false
          });
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: mergeCommands(commands, builtinAvailableCommands())
            }
          });
          return;
        } catch {
        }
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: mergeCommands(toAvailableCommands(fileCommands), builtinAvailableCommands())
          }
        });
      })();
    }, 0);
    return response;
  }
  async deleteSession(params) {
    const stored = this.store.get(params.sessionId);
    const piSession = findPiSession(params.sessionId);
    if (!stored && !piSession) {
      return {};
    }
    const sessionFile = stored?.sessionFile ?? piSession?.sessionFile;
    this.sessions.close(params.sessionId);
    if (sessionFile) {
      try {
        if (existsSync7(sessionFile)) unlinkSync(sessionFile);
      } catch {
      }
    }
    this.store.delete(params.sessionId);
    return {};
  }
  /**
   * ACP `session/resume`: reattach to an existing session WITHOUT replaying history
   * (unlike `session/load`, which streams the full transcript back). Re-advertises
   * commands and returns current mode/config state.
   */
  async resumeSession(params) {
    if (!isAbsolute4(params.cwd)) {
      throw RequestError4.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
    }
    const additionalDirectories = normalizeAdditionalDirectories(params.additionalDirectories, params.cwd);
    const enableSkillCommands = getEnableSkillCommands(params.cwd);
    this.sessions.close(params.sessionId);
    this.lastSessionCwd = params.cwd;
    const preexistingSessionIds = this.sessions.sessionIds?.() ?? [];
    const session = await this.restoreSession(params.sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      additionalDirectories
    });
    const proc = session.proc;
    const fileCommands = loadSlashCommands(params.cwd);
    this.sessions.closeAllExcept?.(session.sessionId, preexistingSessionIds);
    const { configOptions, modes } = await getSessionConfiguration(proc);
    setTimeout(() => {
      void (async () => {
        try {
          const pi = await proc.getCommands();
          const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
            enableSkillCommands,
            includeExtensionCommands: false
          });
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: mergeCommands(commands, builtinAvailableCommands())
            }
          });
          return;
        } catch {
        }
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: mergeCommands(toAvailableCommands(fileCommands), builtinAvailableCommands())
          }
        });
      })();
    }, 0);
    return { configOptions, modes, _meta: { piAcp: { startupInfo: null } } };
  }
  /**
   * ACP `session/close`: cancel any ongoing work and free the session's pi subprocess.
   * Idempotent — closing an unknown/already-closed session succeeds.
   */
  async closeSession(params) {
    this.sessions.close(params.sessionId);
    return {};
  }
  /**
   * ACP `auth/logout`. Terminal Auth is handled out-of-band by pi; there is no cached
   * ACP-side auth state to clear, so this succeeds as a no-op.
   */
  async logout(_params) {
    return {};
  }
  async unstable_setSessionModel(params) {
    const session = await this.restoreSession(params.sessionId);
    await setSessionModel(session.proc, params.modelId);
    await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc);
  }
  async setSessionMode(params) {
    const session = await this.restoreSession(params.sessionId);
    const mode = String(params.modeId);
    if (!isThinkingLevel(mode)) {
      throw RequestError4.invalidParams(`Unknown modeId: ${mode}`);
    }
    await session.proc.setThinkingLevel(mode);
    void this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: mode
      }
    });
    await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc);
    return {};
  }
  async setSessionConfigOption(params) {
    const session = await this.restoreSession(params.sessionId);
    const configId = String(params.configId);
    if (typeof params.value !== "string") {
      throw RequestError4.invalidParams(`Expected string value for config option: ${configId}`);
    }
    if (configId === MODEL_CONFIG_ID) {
      await setSessionModel(session.proc, params.value);
    } else if (configId === THOUGHT_LEVEL_CONFIG_ID) {
      if (!isThinkingLevel(params.value)) {
        throw RequestError4.invalidParams(`Unknown thinking level: ${params.value}`);
      }
      await session.proc.setThinkingLevel(params.value);
      void this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: params.value
        }
      });
    } else {
      throw RequestError4.invalidParams(`Unknown config option: ${configId}`);
    }
    const configOptions = await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc);
    return { configOptions };
  }
};
function isThinkingLevel(x) {
  return x === "off" || x === "minimal" || x === "low" || x === "medium" || x === "high" || x === "xhigh";
}
async function getThinkingState(proc, pre) {
  let current = "medium";
  const state = pre?.state ?? await (async () => {
    try {
      return await proc.getState();
    } catch {
      return null;
    }
  })();
  const tl = typeof state?.thinkingLevel === "string" ? state.thinkingLevel : null;
  if (tl && isThinkingLevel(tl)) current = tl;
  const available = ["off", "minimal", "low", "medium", "high", "xhigh"];
  return {
    currentModeId: current,
    availableModes: available.map((id) => ({
      id,
      name: `Thinking: ${id}`,
      description: null
    }))
  };
}
async function getSessionConfiguration(proc, pre) {
  const [models, modes] = await Promise.all([getModelState(proc, pre), getThinkingState(proc, { state: pre?.state })]);
  return {
    configOptions: buildConfigOptions({ models, modes }),
    models,
    modes
  };
}
function buildConfigOptions(state) {
  const configOptions = [
    {
      type: "select",
      id: THOUGHT_LEVEL_CONFIG_ID,
      category: "thought_level",
      name: "Thinking",
      description: "Set the reasoning effort for this session",
      currentValue: state.modes.currentModeId,
      options: state.modes.availableModes.map((mode) => ({
        value: mode.id,
        name: mode.name,
        description: mode.description ?? null
      }))
    }
  ];
  if (state.models?.availableModels.length) {
    configOptions.unshift({
      type: "select",
      id: MODEL_CONFIG_ID,
      category: "model",
      name: "Model",
      description: "Select the model for this session",
      currentValue: state.models.currentModelId,
      options: state.models.availableModels.map((model) => ({
        value: model.modelId,
        name: model.name,
        description: model.description ?? null
      }))
    });
  }
  return configOptions;
}
async function getModelState(proc, pre) {
  let availableModels = [];
  const data = pre?.availableModels ?? await (async () => {
    try {
      return await proc.getAvailableModels();
    } catch {
      return null;
    }
  })();
  const models = Array.isArray(data?.models) ? data.models : [];
  availableModels = models.map((m) => {
    const provider = String(m?.provider ?? "").trim();
    const id = String(m?.id ?? "").trim();
    if (!provider || !id) return null;
    const name = String(m?.name ?? id);
    return {
      modelId: `${provider}/${id}`,
      name: `${provider}/${name}`,
      description: null
    };
  }).filter(Boolean);
  let currentModelId = null;
  const state = pre?.state ?? await (async () => {
    try {
      return await proc.getState();
    } catch {
      return null;
    }
  })();
  const model = state?.model;
  if (model && typeof model === "object") {
    const provider = String(model.provider ?? "").trim();
    const id = String(model.id ?? "").trim();
    if (provider && id) currentModelId = `${provider}/${id}`;
  }
  if (!availableModels.length && !currentModelId) return null;
  if (!currentModelId) currentModelId = availableModels[0]?.modelId ?? "default";
  return {
    availableModels,
    currentModelId: currentModelId ?? availableModels[0]?.modelId ?? "default"
  };
}
async function emitConfigOptionsUpdate(conn, sessionId, proc) {
  const { configOptions } = await getSessionConfiguration(proc);
  await conn.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: "config_option_update",
      configOptions
    }
  });
  return configOptions;
}
async function setSessionModel(proc, requestedModelId) {
  let provider = null;
  let modelId = null;
  if (requestedModelId.includes("/")) {
    const [candidateProvider, ...rest] = requestedModelId.split("/");
    provider = candidateProvider;
    modelId = rest.join("/");
  } else {
    modelId = requestedModelId;
  }
  if (!provider) {
    const data = await proc.getAvailableModels();
    const models = Array.isArray(data?.models) ? data.models : [];
    const found = models.find((m) => String(m?.id) === modelId);
    if (found) {
      provider = String(found.provider);
      modelId = String(found.id);
    }
  }
  if (!provider || !modelId) {
    throw RequestError4.invalidParams(`Unknown modelId: ${requestedModelId}`);
  }
  await proc.setModel(provider, modelId);
}
function isSemver(v) {
  return /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(v);
}
function compareSemver(a, b) {
  const pa = a.split(/[.-]/).slice(0, 3).map((n) => Number(n));
  const pb = b.split(/[.-]/).slice(0, 3).map((n) => Number(n));
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}
function buildUpdateNotice() {
  try {
    const piVersion = spawnSync("pi", ["--version"], { encoding: "utf-8", timeout: 2e3 });
    const installed = (String(piVersion.stdout ?? "").trim() || String(piVersion.stderr ?? "").trim()).replace(
      /^v/i,
      ""
    );
    if (!installed || !isSemver(installed)) return null;
    const latestRes = spawnSync("npm", ["view", "@earendil-works/pi-coding-agent", "version"], {
      encoding: "utf-8",
      timeout: 800
    });
    const latest = String(latestRes.stdout ?? "").trim().replace(/^v/i, "");
    if (!latest || !isSemver(latest)) return null;
    if (compareSemver(latest, installed) <= 0) return null;
    return `New version available: v${latest} (installed v${installed}). Run: \`npm i -g @earendil-works/pi-coding-agent\``;
  } catch {
    return null;
  }
}
function buildStartupInfo(opts) {
  void opts.fileCommands;
  const md = [];
  try {
    const piVersion = spawnSync("pi", ["--version"], { encoding: "utf-8", timeout: 2e3 });
    const installed = (String(piVersion.stdout ?? "").trim() || String(piVersion.stderr ?? "").trim()).replace(
      /^v/i,
      ""
    );
    if (installed) {
      md.push(`pi v${installed}`);
      md.push("---");
      md.push("");
    }
  } catch {
  }
  const addSection = (title, items) => {
    const cleaned = items.map((s) => s.trim()).filter(Boolean);
    if (!cleaned.length) return;
    md.push(`## ${title}`);
    for (const item of cleaned) md.push(`- ${item}`);
    md.push("");
  };
  const contextItems = [];
  const contextPath = join8(opts.cwd, "AGENTS.md");
  if (existsSync7(contextPath)) contextItems.push(contextPath);
  addSection("Context", contextItems);
  addSection("Additional workspace roots", opts.additionalDirectories ?? []);
  const skillsItems = [];
  const pushSkillFromRoot = (root) => {
    try {
      for (const e of readdirSync3(root)) {
        const p = join8(root, e);
        try {
          const st = statSync2(p);
          if (st.isFile() && e.toLowerCase().endsWith(".md")) {
            skillsItems.push(p);
          }
        } catch {
        }
      }
      const stack = [root];
      while (stack.length) {
        const dir = stack.pop();
        let entries = [];
        try {
          entries = readdirSync3(dir);
        } catch {
          continue;
        }
        for (const name of entries) {
          if (name === "node_modules" || name === ".git") continue;
          const p = join8(dir, name);
          let st;
          try {
            st = statSync2(p);
          } catch {
            continue;
          }
          if (st.isDirectory()) {
            stack.push(p);
          } else if (st.isFile() && name === "SKILL.md") {
            skillsItems.push(p);
          }
        }
      }
    } catch {
    }
  };
  const globalSkillsDir = join8(getAgentDir(), "skills");
  pushSkillFromRoot(globalSkillsDir);
  const legacyAgentsSkillsDir = join8(process.env.HOME ?? "", ".agents", "skills");
  pushSkillFromRoot(legacyAgentsSkillsDir);
  const projectSkillsDir = join8(opts.cwd, ".pi", "skills");
  pushSkillFromRoot(projectSkillsDir);
  addSection("Skills", skillsItems);
  const promptsItems = [];
  const promptsDir = join8(process.env.HOME ?? "", ".pi", "agent", "prompts");
  try {
    const prompts = readdirSync3(promptsDir).filter((f) => f.endsWith(".md"));
    for (const f of prompts) promptsItems.push(`/${basename(f, ".md")}`);
  } catch {
  }
  addSection("Prompts", promptsItems);
  const extItems = [];
  const extDir = join8(process.env.HOME ?? "", ".pi", "agent", "extensions");
  try {
    const exts = readdirSync3(extDir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
    for (const f of exts) extItems.push(join8(extDir, f));
  } catch {
  }
  const settingsPaths = [join8(getAgentDir(), "settings.json"), join8(opts.cwd, ".pi", "settings.json")];
  for (const settingsPath of settingsPaths) {
    try {
      const settings = JSON.parse(readFileSync8(settingsPath, "utf-8"));
      const pkgs = Array.isArray(settings?.packages) ? settings.packages : [];
      for (const pkg2 of pkgs) {
        const s = String(pkg2);
        if (s.startsWith("npm:")) {
          extItems.push(`${s}
  - index.ts`);
        } else {
          extItems.push(s);
        }
      }
    } catch {
    }
  }
  addSection("Extensions", extItems);
  if (opts.updateNotice) {
    md.push("---");
    md.push(opts.updateNotice);
    md.push("");
  }
  return md.join("\n").trim() + "\n";
}
function readNearestPackageJson(metaUrl) {
  try {
    let dir = dirname4(fileURLToPath2(metaUrl));
    for (let i = 0; i < 6; i++) {
      const p = join8(dir, "package.json");
      if (existsSync7(p)) {
        const json = JSON.parse(readFileSync8(p, "utf-8"));
        return { name: json?.name, version: json?.version };
      }
      dir = dirname4(dir);
    }
  } catch {
  }
  return { name: "pi-acp", version: "0.0.0" };
}

// src/index.ts
if (process.argv.includes("--terminal-login")) {
  const { spawnSync: spawnSync2 } = await import("child_process");
  const cmd = getPiCommand(getPiCommandOverride());
  const res = spawnSync2(cmd, [], {
    stdio: "inherit",
    env: process.env,
    shell: shouldUseShellForPiCommand(cmd)
  });
  if (res.error && res.error.code === "ENOENT") {
    process.stderr.write(
      `pi-acp: could not start pi (command not found: ${cmd}). Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH.
`
    );
    process.exit(1);
  }
  process.exit(typeof res.status === "number" ? res.status : 1);
}
var input = new WritableStream({
  write(chunk) {
    return new Promise((resolve5) => {
      if (process.stdout.destroyed || !process.stdout.writable) return resolve5();
      try {
        process.stdout.write(chunk, (err) => {
          void err;
          resolve5();
        });
      } catch {
        resolve5();
      }
    });
  }
});
var output = new ReadableStream({
  start(controller) {
    process.stdin.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
    process.stdin.on("end", () => controller.close());
    process.stdin.on("error", (err) => controller.error(err));
  }
});
var stream = ndJsonStream(input, output);
var agent = new AgentSideConnection((conn) => new PiAcpAgent(conn), stream);
function shutdown() {
  try {
    ;
    agent?.agent?.dispose?.();
  } catch {
  }
  try {
    process.exit(0);
  } catch {
  }
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.stdin.resume();
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdout.on("error", () => {
  try {
    process.exit(0);
  } catch {
  }
});
