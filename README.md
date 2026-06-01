# OpenCode Chat Bridge

A local VS Code extension that exposes OpenCode Go / Zen to VS Code Chat in two ways:

1. a proper VS Code language model provider named **OpenCode Go / Zen**; and
2. a fallback/debug `@opencode` chat participant.

For normal agent/tool usage, prefer the **OpenCode Go / Zen** model provider. VS Code's own Chat/Agent loop can then pass tools to the model provider, execute tool calls, show confirmations, and feed tool results back through the official `vscode.lm` APIs.

## Why this exists

OpenCode exposes multiple endpoint styles:

- `/zen/v1/responses`
- `/zen/v1/messages`
- `/zen/v1/chat/completions`
- `/zen/go/v1/messages`
- `/zen/go/v1/chat/completions`
- per-model endpoints such as `/zen/v1/models/<model>`

VS Code Chat tool calling expects the extension to manage tool schemas, tool-call messages, tool execution, and tool-result messages. Pointing a generic VS Code Chat/OpenAI-compatible client at the wrong Zen endpoint can make tool calling fail.

This bridge uses the OpenAI-compatible `/chat/completions` flow for Go/Zen models that expose OpenAI-style `tool_calls`, and the Anthropic-compatible `/messages` flow for Go MiniMax/Qwen models. The provider translates between:

- VS Code `LanguageModelChatProvider` messages/tools/results; and
- OpenAI-compatible chat completions or Anthropic-compatible messages/tools/tool calls.

The fallback `@opencode` participant performs its own small tool loop and is useful for testing the endpoint directly, but it is not the recommended path if you specifically want VS Code Chat's built-in agent/tool behavior.

## Important limitations

- This does not use or bypass GitHub Copilot private tokens.
- VS Code/Copilot private internal tools are not all available to third-party extensions.
- The bridge can only invoke tools exposed through the VS Code `vscode.lm` tool APIs and allowed for the current request.
- The `@opencode` participant passes `request.toolInvocationToken` to `vscode.lm.invokeTool`, which is required for VS Code Chat UI/confirmation wiring.
- OpenCode's ACP support is not used here because current VS Code Chat does not expose a stable public ACP agent-host extension point. ACP is the right protocol for ACP-compatible editors; for VS Code Chat, `LanguageModelChatProvider` is the correct public integration point.

## Setup

1. Install dependencies:
   ```powershell
   npm install
   ```
2. Compile:
   ```powershell
   npm run compile
   ```
3. Press `F5` in VS Code to launch an Extension Development Host, or package/install the VSIX.
4. In the Extension Development Host or installed window, run **OpenCode Chat Bridge: Set API Key** from the Command Palette.
5. Paste your OpenCode Zen / Go API key. It is stored in VS Code Secret Storage.
6. In VS Code Chat, select an **OpenCode Go** model from the model picker, then use Chat/Agent normally.
7. Optional fallback/debug entry point:
   ```text
   @opencode explain this workspace
   ```

## OpenCode Go models

The model provider exposes these Go subscription models in the VS Code Chat model picker:

- OpenAI-compatible `/zen/go/v1/chat/completions`:
   - `kimi-k2.6`
   - `kimi-k2.5`
   - `glm-5.1`
   - `glm-5`
   - `deepseek-v4-pro`
   - `deepseek-v4-flash`
   - `mimo-v2.5-pro`
   - `mimo-v2.5`
- Anthropic-compatible `/zen/go/v1/messages`:
   - `minimax-m3`
   - `minimax-m2.7`
   - `minimax-m2.5`
   - `qwen3.7-max`
   - `qwen3.6-plus`

It also keeps `deepseek-v4-flash-free` as a Zen free fallback model.

The model provider also exposes these Zen free `/zen/v1/chat/completions` models:

- `big-pickle`
- `mimo-v2.5-free`
- `nemotron-3-super-free`
- `deepseek-v4-flash-free`

OpenCode's own config names Go models as `opencode-go/<model-id>`. This bridge sends the raw model ID to the Go API because the Go endpoint expects IDs such as `kimi-k2.6`.

The public Go `/models` endpoint currently returns model IDs only, so the extension uses the original `limit.context` and `limit.output` values from the `opencode-go` entries in `https://models.dev/api.json`.

## Fallback participant settings

The settings below only affect the fallback/debug `@opencode` participant. The proper VS Code model provider uses its built-in per-model endpoints.

If the Settings UI still shows old endpoint/model values, they are user/workspace overrides from a previous version. Clear or update them in VS Code Settings; the Chat model picker is still driven by the built-in provider model list.

```json
{
   "opencodeChatBridge.endpoint": "https://opencode.ai/zen/go/v1/chat/completions",
   "opencodeChatBridge.model": "kimi-k2.6"
}
```

Use a `/chat/completions` endpoint for the fallback participant. The fallback path does not translate `/messages`; the provider path does.

## Researched integration notes

- VS Code exposes the public `vscode.lm.registerLanguageModelChatProvider` API and the `languageModelChatProviders` contribution point for adding selectable chat models.
- VS Code's public tool API is `vscode.lm.tools` plus `vscode.lm.invokeTool`; chat participants should pass `ChatRequest.toolInvocationToken` when invoking tools.
- OpenCode exposes `opencode acp` as an ACP subprocess over nd-JSON JSON-RPC, but VS Code Chat does not currently provide a stable public ACP host contribution point.
- OpenCode Zen/Go `/chat/completions` routes support OpenAI-compatible `tools`, `tool_choice`, assistant `tool_calls`, and `tool` role result messages.
- OpenCode Go `/messages` routes use Anthropic-compatible `x-api-key`, `tools`, `tool_choice`, `tool_use`, and `tool_result` blocks.

## Security

Store your OpenCode Zen / Go key only with **OpenCode Chat Bridge: Set API Key**. The key is saved in VS Code Secret Storage and is not written to source files.

If you pasted a real key into chat, revoke or rotate it in the OpenCode dashboard.
