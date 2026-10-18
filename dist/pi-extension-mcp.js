// src/pi-extension-mcp.ts
var ENV_VAR = "PI_ACP_MCP_CONFIG";
function warn(message) {
  try {
    process.stderr.write(`[pi-acp] ${message}
`);
  } catch {
  }
}
function decodeServers(raw) {
  if (!raw) return null;
  try {
    const trimmed = raw.trim();
    const text = trimmed.startsWith("{") ? trimmed : Buffer.from(trimmed, "base64").toString("utf-8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    const servers = parsed.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return null;
    return servers;
  } catch {
    return null;
  }
}
function pi_extension_mcp_default(pi) {
  const servers = decodeServers(process.env[ENV_VAR]);
  delete process.env[ENV_VAR];
  if (!servers) return;
  if (typeof pi.registerMcpServer !== "function") {
    warn("pi does not expose registerMcpServer(); native MCP needs pi >= 1.3 \u2014 MCP servers not loaded");
    return;
  }
  for (const [name, config] of Object.entries(servers)) {
    try {
      pi.registerMcpServer(name, config);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      warn(`could not register MCP server "${name}": ${detail}`);
    }
  }
}
export {
  pi_extension_mcp_default as default
};
