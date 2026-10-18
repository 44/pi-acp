import { defineConfig } from 'tsup'

const common = {
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'node22',
  sourcemap: true,
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
    // Bundled pi extension: bridges ACP `mcpServers` to pi's native `pi.registerMcpServer()`.
    // Loaded explicitly by the adapter via `--extension` (see src/pi-rpc/process.ts), so it must sit
    // next to dist/index.js and must not carry the bin shebang.
    entry: ['src/pi-extension-mcp.ts'],
    clean: false,
    banner: {}
  }
])
