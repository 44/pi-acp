import { defineConfig } from 'tsup'

const common = {
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'node22',
  // dist/ is committed and shipped as-is; sourcemaps are dead weight without
  // `node --enable-source-maps` and would double every release diff.
  sourcemap: false,
  dts: false,
  splitting: false,
  minify: false
}

export default defineConfig([
  {
    ...common,
    // The ACP adapter binary.
    entry: ['src/index.ts'],
    clean: true,
    banner: {
      js: '#!/usr/bin/env node'
    }
  },
  {
    ...common,
    // Bundled pi extensions. Loaded explicitly by the adapter via `--extension` (see
    // src/pi-rpc/process.ts), so they must sit next to dist/index.js and must not carry the bin
    // shebang.
    //  - pi-extension-mcp: bridges ACP `mcpServers` to pi's native `pi.registerMcpServer()`.
    //  - pi-extension-ask-user: model-facing `ask_user` tool, whose `ctx.ui` dialogs pi-acp maps
    //    onto ACP permission/elicitation requests.
    entry: ['src/pi-extension-mcp.ts', 'src/pi-extension-ask-user.ts'],
    clean: false,
    banner: {}
  }
])
