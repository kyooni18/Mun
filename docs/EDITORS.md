# Editor integrations

Mün ships a small stdio Language Server Protocol server. It shares the
compiler's diagnostics, formatting, semantic completion, and hover data, so the
same server can be used from Vim, Neovim, Zed, Helix, or another LSP client.

Install project-local editor configuration from a Mün project:

```bash
npx mun editor install --editor all
```

The command writes `.mun/editors/` snippets for Vim, Neovim, Zed, and Helix,
and merges Mün file associations and the extension recommendation into
`.vscode/`. Pass `--global` to write the corresponding user configuration
locations instead. Vim's generated snippet activates when `vim-lsp` is
installed; Neovim uses the built-in `vim.lsp.start` API.

The server can also be run directly by any LSP client:

```bash
mun lsp --stdio
```

The generic server command is `mun lsp --stdio`, with `.mun`, `.mun.ts`, and `.vue`
documents supported. `textDocument/publishDiagnostics`, completion, hover,
formatting, and incremental document updates are implemented.

## VS Code

Build a local installable VSIX without a global `vsce` dependency:

```bash
pnpm vscode:package
code --install-extension dist/mun-language-support-<version>.vsix
```

Or export to a specific path with `mun editor export vscode ./mun.vsix`.
The extension provides Mün/HTML syntax highlighting, diagnostics, formatting,
completion, hover, signature help, definition, rename, and semantic tokens.
