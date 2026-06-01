# OpenCode Chat Bridge instructions

- Keep API keys out of source files and logs.
- Store the OpenCode Zen key only in VS Code secret storage via the extension command.
- Prefer OpenCode Zen models whose endpoint is `/zen/v1/chat/completions` when tool calling is needed.
- Compile with `npm run compile` before packaging.
