import * as vscode from 'vscode';

declare const require: (moduleName: string) => unknown;

const nodeFs = require('fs/promises') as {
  mkdir(path: string, options: { recursive: boolean }): Promise<void>;
  appendFile(path: string, data: string, encoding: BufferEncoding): Promise<void>;
};
const nodePath = require('path') as {
  dirname(path: string): string;
};
type BufferEncoding = 'utf8';

const SECRET_KEY = 'opencodeChatBridge.apiKey';
const ZEN_CHAT_COMPLETIONS_ENDPOINT = 'https://opencode.ai/zen/v1/chat/completions';
const GO_CHAT_COMPLETIONS_ENDPOINT = 'https://opencode.ai/zen/go/v1/chat/completions';
const GO_MESSAGES_ENDPOINT = 'https://opencode.ai/zen/go/v1/messages';

let diagnostics: BridgeDiagnostics | undefined;
let diagnosticWriteQueue: Promise<void> = Promise.resolve();

type ChatRole = 'system' | 'user' | 'assistant' | 'tool';
type ModelProtocol = 'openai-chat' | 'anthropic-messages';

type OpenAiMessage = {
  role: ChatRole;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};

type ToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

type ChatCompletionChoice = {
  message?: OpenAiMessage;
  delta?: Partial<OpenAiMessage> & { tool_calls?: Partial<ToolCall>[] };
  finish_reason?: string | null;
};

type ChatCompletionResponse = {
  choices?: ChatCompletionChoice[];
  error?: { message?: string; type?: string; code?: string | number };
};

type OpenAiTool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
};

type BridgeSettings = {
  endpoint: string;
  model: string;
  temperature: number;
  maxToolRounds: number;
  systemPrompt: string;
  diagnosticsEnabled: boolean;
  diagnosticsFullPayloads: boolean;
  diagnosticsWriteFile: boolean;
  diagnosticsFile: string;
};

type BridgeDiagnostics = {
  channel: vscode.OutputChannel;
  enabled: () => boolean;
  log: (message: string, data?: unknown, options?: { full?: boolean }) => void;
};

type ToolInfo = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  raw: unknown;
};

type ChatCompletionsOptions = {
  toolChoice?: unknown;
  stream?: boolean;
};

type OpenCodeModelInfo = {
  id: string;
  name: string;
  family: string;
  version: string;
  endpoint: string;
  protocol: ModelProtocol;
  maxInputTokens: number;
  maxOutputTokens: number;
};

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
};

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

type AnthropicResponse = {
  content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>;
  error?: { message?: string; type?: string };
};

type AnthropicRequestMessages = {
  system: string[];
  messages: AnthropicMessage[];
};

type AnthropicMessagesOptions = {
  toolChoice?: unknown;
};

const OPEN_CODE_MODELS: OpenCodeModelInfo[] = [
  openAiGoModel('kimi-k2.6', 'Kimi K2.6', 262144, 65536),
  openAiGoModel('kimi-k2.5', 'Kimi K2.5', 262144, 65536),
  openAiGoModel('glm-5.1', 'GLM-5.1', 202752, 32768),
  openAiGoModel('glm-5', 'GLM-5', 202752, 32768),
  openAiGoModel('deepseek-v4-pro', 'DeepSeek V4 Pro', 1000000, 384000),
  openAiGoModel('deepseek-v4-flash', 'DeepSeek V4 Flash', 1000000, 384000),
  openAiGoModel('mimo-v2.5-pro', 'MiMo-V2.5-Pro', 1048576, 128000),
  openAiGoModel('mimo-v2.5', 'MiMo-V2.5', 1000000, 128000),
  anthropicGoModel('minimax-m3', 'MiniMax M3', 512000, 131072),
  anthropicGoModel('minimax-m2.7', 'MiniMax M2.7', 204800, 131072),
  anthropicGoModel('minimax-m2.5', 'MiniMax M2.5', 204800, 65536),
  anthropicGoModel('qwen3.7-max', 'Qwen3.7 Max', 1000000, 65536),
  anthropicGoModel('qwen3.6-plus', 'Qwen3.6 Plus', 262144, 65536),
  zenFreeModel('big-pickle', 'Big Pickle', 200000, 32000),
  zenFreeModel('mimo-v2.5-free', 'MiMo V2.5 Free', 200000, 32000),
  zenFreeModel('nemotron-3-super-free', 'Nemotron 3 Super Free', 204800, 128000),
  {
    id: 'deepseek-v4-flash-free',
    name: 'OpenCode Zen Free: DeepSeek V4 Flash',
    family: 'deepseek-v4-flash',
    version: 'zen-chat-completions',
    endpoint: ZEN_CHAT_COMPLETIONS_ENDPOINT,
    protocol: 'openai-chat',
    maxInputTokens: 200000,
    maxOutputTokens: 128000
  }
];

function openAiGoModel(id: string, label: string, maxInputTokens: number, maxOutputTokens: number): OpenCodeModelInfo {
  return {
    id,
    name: `OpenCode Go: ${label}`,
    family: id,
    version: 'go-chat-completions',
    endpoint: GO_CHAT_COMPLETIONS_ENDPOINT,
    protocol: 'openai-chat',
    maxInputTokens,
    maxOutputTokens
  };
}

function anthropicGoModel(id: string, label: string, maxInputTokens: number, maxOutputTokens: number): OpenCodeModelInfo {
  return {
    id,
    name: `OpenCode Go: ${label}`,
    family: id,
    version: 'go-messages',
    endpoint: GO_MESSAGES_ENDPOINT,
    protocol: 'anthropic-messages',
    maxInputTokens,
    maxOutputTokens
  };
}

function zenFreeModel(id: string, label: string, maxInputTokens: number, maxOutputTokens: number): OpenCodeModelInfo {
  return {
    id,
    name: `OpenCode Zen Free: ${label}`,
    family: id,
    version: 'zen-free-chat-completions',
    endpoint: ZEN_CHAT_COMPLETIONS_ENDPOINT,
    protocol: 'openai-chat',
    maxInputTokens,
    maxOutputTokens
  };
}

class OpenCodeBridgeViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async message => {
      const command = typeof message?.command === 'string' ? message.command : '';

      if (command === 'setApiKey') {
        await vscode.commands.executeCommand('opencodeChatBridge.setApiKey');
      } else if (command === 'openChat') {
        await vscode.commands.executeCommand('opencodeChatBridge.openChat');
      } else if (command === 'showRunHelp') {
        await vscode.commands.executeCommand('opencodeChatBridge.showRunHelp');
      } else if (command === 'openSettings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'opencodeChatBridge');
      } else if (command === 'toggleDiagnostics') {
        await vscode.commands.executeCommand('opencodeChatBridge.toggleDiagnostics');
        webviewView.webview.html = this.getHtml(webviewView.webview);
      }
    }, undefined, this.context.subscriptions);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = Date.now().toString(36);
    const settings = getSettings();
    const diagnosticsLabel = settings.diagnosticsEnabled ? 'Disable Full Diagnostics' : 'Enable Full Diagnostics';
    const diagnosticsStatus = settings.diagnosticsEnabled
      ? `Full diagnostics are ON. File: ${settings.diagnosticsFile}`
      : 'Full diagnostics are OFF.';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { padding: 14px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
    h2 { margin: 0 0 8px; font-size: 16px; }
    p { line-height: 1.45; color: var(--vscode-descriptionForeground); }
    button { width: 100%; margin: 6px 0; padding: 8px 10px; border: 0; border-radius: 3px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    code { color: var(--vscode-textLink-foreground); }
    .box { margin-top: 12px; padding: 10px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
  </style>
</head>
<body>
  <h2>OpenCode Chat Bridge</h2>
  <p>Runs inside VS Code Chat. Do not type bridge commands in the terminal.</p>
  <button data-command="setApiKey">1. Set / Update OpenCode API Key</button>
  <button data-command="openChat">2. Open VS Code Chat</button>
  <button data-command="toggleDiagnostics">${escapeHtml(diagnosticsLabel)}</button>
  <button class="secondary" data-command="openSettings">Open Bridge Settings</button>
  <button class="secondary" data-command="showRunHelp">Show Run Help</button>
  <div class="box">
    <p><b>Recommended:</b> select an <code>OpenCode Go</code> model such as <code>${escapeHtml(resolveModelInfo(settings.model).name)}</code> in the Chat model picker, then use Agent/Chat normally.</p>
    <p><b>Fallback test:</b> type <code>@opencode hello</code> in Chat.</p>
    <p><b>Diagnostics:</b> ${escapeHtml(diagnosticsStatus)}</p>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    for (const button of document.querySelectorAll('button[data-command]')) {
      button.addEventListener('click', () => vscode.postMessage({ command: button.dataset.command }));
    }
  </script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext) {
  diagnostics = createDiagnostics(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('opencodeChatBridge.setApiKey', async () => {
      const apiKey = await vscode.window.showInputBox({
        title: 'OpenCode API Key',
        prompt: 'Paste your OpenCode Zen / Go API key. It will be stored in VS Code Secret Storage.',
        password: true,
        ignoreFocusOut: true,
        validateInput: value => value.trim() ? undefined : 'API key is required.'
      });

      if (!apiKey) {
        return;
      }

      await context.secrets.store(SECRET_KEY, apiKey.trim());
      vscode.window.showInformationMessage('OpenCode Chat Bridge API key saved.');
    }),
    vscode.commands.registerCommand('opencodeChatBridge.clearApiKey', async () => {
      await context.secrets.delete(SECRET_KEY);
      vscode.window.showInformationMessage('OpenCode Chat Bridge API key cleared.');
    }),
    vscode.commands.registerCommand('opencodeChatBridge.openChat', async () => {
      await vscode.commands.executeCommand('workbench.action.chat.open');
      vscode.window.showInformationMessage('Select an OpenCode Go model in VS Code Chat, then ask normally.');
    }),
    vscode.commands.registerCommand('opencodeChatBridge.showRunHelp', async () => {
      const choice = await vscode.window.showInformationMessage(
        'OpenCode Chat Bridge runs inside VS Code Chat. Use Ctrl+Shift+P for commands, not the terminal. Select an OpenCode Go model in Chat after saving your key.',
        'Set API Key',
        'Open Chat'
      );

      if (choice === 'Set API Key') {
        await vscode.commands.executeCommand('opencodeChatBridge.setApiKey');
      } else if (choice === 'Open Chat') {
        await vscode.commands.executeCommand('opencodeChatBridge.openChat');
      }
    }),
    vscode.commands.registerCommand('opencodeChatBridge.toggleDiagnostics', async () => {
      const config = vscode.workspace.getConfiguration('opencodeChatBridge');
      const enabled = config.get<boolean>('diagnostics.enabled', false);

      if (enabled) {
        await config.update('diagnostics.enabled', false, vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage('OpenCode Chat Bridge diagnostics disabled.');
        return;
      }

      await config.update('diagnostics.enabled', true, vscode.ConfigurationTarget.Workspace);
      await config.update('diagnostics.fullPayloads', true, vscode.ConfigurationTarget.Workspace);
      await config.update('diagnostics.writeFile', true, vscode.ConfigurationTarget.Workspace);
      await config.update('diagnostics.file', '.opencode-chat-bridge/diagnostics.jsonl', vscode.ConfigurationTarget.Workspace);
      await clearDiagnosticsFile(getSettings().diagnosticsFile);
      vscode.window.showInformationMessage('OpenCode Chat Bridge full diagnostics enabled. Model responses, tool calls, and tool results will be written to .opencode-chat-bridge/diagnostics.jsonl. API keys are still redacted.');
    })
  );

  context.subscriptions.push(vscode.window.registerWebviewViewProvider('opencodeChatBridge.welcome', new OpenCodeBridgeViewProvider(context)));

  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('opencode', {
    provideLanguageModelChatInformation: async () => OPEN_CODE_MODELS.map(model => ({
      id: model.id,
      name: model.name,
      family: model.family,
      version: model.version,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      capabilities: {
        toolCalling: true
      }
    })),
    provideLanguageModelChatResponse: async (model, messages, options, progress, token) => {
      await provideOpenCodeLanguageModelResponse(context, model, messages, options, progress, token);
    },
    provideTokenCount: async (_model, text) => estimateTokenCount(text)
  }));

  const participant = vscode.chat.createChatParticipant('opencode-chat-bridge.opencode', async (request, _chatContext, stream, token) => {
    try {
      await handleChatRequest(context, request, stream, token);
      return {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stream.markdown(`OpenCode bridge error: ${message}`);
      return { metadata: { error: message } };
    }
  });

  context.subscriptions.push(participant);
}

export function deactivate() {
  // Nothing to dispose outside subscriptions.
}

async function handleChatRequest(
  context: vscode.ExtensionContext,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
) {
  const settings = getSettings();
  const apiKey = await context.secrets.get(SECRET_KEY);

  if (!apiKey) {
    stream.markdown('OpenCode API key is not configured. Run **OpenCode Chat Bridge: Set API Key** from the Command Palette first.');
    return;
  }

  if (!settings.endpoint.includes('/chat/completions')) {
    stream.markdown('The configured endpoint is not a `/chat/completions` endpoint. Tool calling needs an OpenAI-compatible chat completions endpoint, such as `https://opencode.ai/zen/v1/chat/completions`.');
    return;
  }

  const availableTools = getAvailableTools(request);
  const messages: OpenAiMessage[] = [
    { role: 'system', content: settings.systemPrompt },
    { role: 'user', content: buildUserPrompt(request) }
  ];

  stream.progress(`Using ${settings.model}${availableTools.length ? ` with ${availableTools.length} VS Code tool(s)` : ''}.`);
  diag('participant.request', {
    model: settings.model,
    endpoint: settings.endpoint,
    toolCount: availableTools.length,
    tools: availableTools.map(tool => tool.name),
    promptSize: request.prompt.length
  });
  diagFull('participant.request.full', {
    prompt: request.prompt,
    references: request.references.map(describeReference),
    tools: availableTools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
  });

  for (let round = 0; round <= settings.maxToolRounds; round++) {
    throwIfCancelled(token);

    const response = await callChatCompletions(settings, apiKey, messages, toOpenAiTools(availableTools), token, {
      toolChoice: availableTools.length ? 'auto' : undefined
    });
    const assistantMessage = response.choices?.[0]?.message;

    if (!assistantMessage) {
      throw new Error('No assistant message was returned by the model.');
    }

    if (assistantMessage.content) {
      stream.markdown(assistantMessage.content);
    }

    const toolCalls = assistantMessage.tool_calls ?? [];
    if (!toolCalls.length) {
      return;
    }

    messages.push({
      role: 'assistant',
      content: assistantMessage.content ?? null,
      tool_calls: toolCalls
    });

    if (!availableTools.length) {
      stream.markdown('\n\nThe model requested tool calls, but VS Code did not expose any tools to this participant for this request. Attach tools in Chat or use a Copilot/VS Code build that exposes `lm.tools`.');
      return;
    }

    for (const toolCall of toolCalls) {
      throwIfCancelled(token);
      stream.progress(`Running VS Code tool: ${toolCall.function.name}`);
      diagFull('participant.toolCall.full', toolCall);
      const result = await invokeVsCodeTool(toolCall, availableTools, request.toolInvocationToken, token);
      diagFull('participant.toolResult.full', { callId: toolCall.id, name: toolCall.function.name, result });
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result
      });
    }
  }

  stream.markdown(`\n\nStopped after ${settings.maxToolRounds} tool round(s). Increase \`opencodeChatBridge.maxToolRounds\` if the task needs more steps.`);
}

async function provideOpenCodeLanguageModelResponse(
  context: vscode.ExtensionContext,
  model: vscode.LanguageModelChatInformation,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  token: vscode.CancellationToken
): Promise<void> {
  const settings = getSettings();
  const apiKey = await context.secrets.get(SECRET_KEY);

  if (!apiKey) {
    throw new Error('OpenCode API key is not configured. Run "OpenCode Chat Bridge: Set API Key" first.');
  }

  const modelInfo = resolveModelInfo(model.id || settings.model);
  const languageModelTools = options.tools ?? [];
  const toolNameMap = new Map(languageModelTools.map(tool => [sanitizeToolName(tool.name), tool.name]));

  diag('provider.request', {
    modelId: modelInfo.id,
    protocol: modelInfo.protocol,
    messageCount: messages.length,
    toolCount: languageModelTools.length,
    toolMode: String(options.toolMode),
    tools: languageModelTools.map(tool => ({ name: tool.name, sanitized: sanitizeToolName(tool.name), schemaSize: sizeOf(tool.inputSchema) }))
  });

  if (modelInfo.protocol === 'anthropic-messages') {
    const anthropicMessages = toAnthropicMessages(messages);
    const tools = languageModelTools.map(toAnthropicToolFromLanguageModelTool);
    diag('provider.anthropic.requestBodySummary', {
      systemCount: anthropicMessages.system.length,
      messageRoles: anthropicMessages.messages.map(message => message.role),
      contentTypes: anthropicMessages.messages.map(message => message.content.map(part => part.type)),
      tools: tools.map(tool => ({ name: tool.name, descriptionSize: tool.description.length, schemaSize: sizeOf(tool.input_schema) }))
    });
    diagFull('provider.anthropic.messages.full', anthropicMessages);
    diagFull('provider.anthropic.tools.full', tools);
    const response = await callAnthropicMessages(modelInfo, settings, apiKey, anthropicMessages, tools, token, {
      toolChoice: toAnthropicToolChoice(options.toolMode)
    });

    if (!Array.isArray(response.content)) {
      throw new Error('No assistant content was returned by OpenCode Go.');
    }

    diagFull('model.anthropic.rawResponse.full', response);

    for (const block of response.content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        diag('provider.anthropic.text', { size: block.text.length });
        progress.report(new vscode.LanguageModelTextPart(block.text));
      }

      if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        const originalToolName = toolNameMap.get(block.name) ?? block.name;
        diag('provider.anthropic.toolCall', {
          callId: block.id,
          modelToolName: block.name,
          originalToolName,
          inputSize: sizeOf(block.input)
        });
        diagFull('provider.anthropic.toolCall.full', { block, originalToolName, parsedInput: parseToolInput(block.input) });
        progress.report(new vscode.LanguageModelToolCallPart(
          block.id,
          originalToolName,
          parseToolInput(block.input)
        ));
      }
    }

    return;
  }

  const openAiMessages = messages.flatMap(toOpenAiMessages);
  const tools = languageModelTools.map(toOpenAiToolFromLanguageModelTool);
  diag('provider.openai.requestBodySummary', {
    messageRoles: openAiMessages.map(message => message.role),
    messageCount: openAiMessages.length,
    toolCount: tools.length,
    tools: tools.map(tool => ({ name: tool.function.name, descriptionSize: tool.function.description.length, schemaSize: sizeOf(tool.function.parameters) }))
  });
  diagFull('provider.openai.messages.full', openAiMessages);
  diagFull('provider.openai.tools.full', tools);
  let response = await callChatCompletions(
    { ...settings, endpoint: modelInfo.endpoint, model: modelInfo.id },
    apiKey,
    openAiMessages,
    tools,
    token,
    {
      toolChoice: toOpenAiToolChoice(options.toolMode),
      stream: false
    }
  );

  let assistantMessage = response.choices?.[0]?.message;
  if (!assistantMessage) {
    throw new Error('No assistant message was returned by OpenCode.');
  }

  diagFull('model.openai.rawResponse.full', response);
  diagFull('model.openai.assistantMessage.full', assistantMessage);

  if (shouldRetryMissingToolCall(assistantMessage, tools)) {
    diag('provider.openai.missingToolCallRetry', {
      contentSize: assistantMessage.content?.length ?? 0,
      toolCount: tools.length
    });
    const originalAssistantMessage = assistantMessage;

    try {
      response = await callChatCompletions(
        { ...settings, endpoint: modelInfo.endpoint, model: modelInfo.id },
        apiKey,
        buildMissingToolCallRetryMessages(openAiMessages, assistantMessage),
        tools,
        token,
        {
          toolChoice: 'auto',
          stream: false
        }
      );

      assistantMessage = response.choices?.[0]?.message;
      if (!assistantMessage) {
        throw new Error('No assistant message was returned by OpenCode after forcing a tool call retry.');
      }

      diagFull('model.openai.retryRawResponse.full', response);
      diagFull('model.openai.retryAssistantMessage.full', assistantMessage);
    } catch (error) {
      diag('provider.openai.missingToolCallRetry.failed', { error: error instanceof Error ? error.message : String(error) });
      assistantMessage = originalAssistantMessage;
    }
  }

  if (assistantMessage.content) {
    diag('provider.openai.text', { size: assistantMessage.content.length });
    progress.report(new vscode.LanguageModelTextPart(assistantMessage.content));
  }

  for (const toolCall of assistantMessage.tool_calls ?? []) {
    const originalToolName = toolNameMap.get(toolCall.function.name) ?? toolCall.function.name;
    diag('provider.openai.toolCall', {
      callId: toolCall.id,
      modelToolName: toolCall.function.name,
      originalToolName,
      argumentsSize: sizeOf(toolCall.function.arguments)
    });
    diagFull('provider.openai.toolCall.full', { toolCall, originalToolName, parsedInput: parseToolArguments(toolCall.function.arguments) });
    progress.report(new vscode.LanguageModelToolCallPart(
      toolCall.id || `call_${Date.now().toString(36)}`,
      originalToolName,
      parseToolArguments(toolCall.function.arguments)
    ));
  }
}

function throwIfCancelled(token: vscode.CancellationToken) {
  if (token.isCancellationRequested) {
    throw new Error('Request cancelled.');
  }
}

function shouldRetryMissingToolCall(assistantMessage: OpenAiMessage, tools: OpenAiTool[]): boolean {
  if (!tools.length || assistantMessage.tool_calls?.length) {
    return false;
  }

  const content = (assistantMessage.content ?? '').toLowerCase();
  if (!content.trim()) {
    return false;
  }

  return /\b(use|call|invoke|run|execute|create|write|edit|modify|patch|read|search|inspect|check|list|apply)\b/.test(content)
    || /立刻|马上|直接|创建|写入|修改|编辑|读取|查看|搜索|执行|运行|调用|工具|动手|爪爪/.test(content);
}

function buildMissingToolCallRetryMessages(messages: OpenAiMessage[], assistantMessage: OpenAiMessage): OpenAiMessage[] {
  return [
    ...messages,
    {
      role: 'assistant',
      content: assistantMessage.content ?? ''
    },
    {
      role: 'user',
      content: 'You just said you would take action, but you did not emit a tool call. Use one of the provided tools now. Do not answer with prose unless no tool can possibly help.'
    }
  ];
}

function getSettings(): BridgeSettings {
  const config = vscode.workspace.getConfiguration('opencodeChatBridge');
  return {
    endpoint: config.get<string>('endpoint', GO_CHAT_COMPLETIONS_ENDPOINT),
    model: config.get<string>('model', 'kimi-k2.6'),
    temperature: config.get<number>('temperature', 0.2),
    maxToolRounds: config.get<number>('maxToolRounds', 5),
    systemPrompt: config.get<string>('systemPrompt', 'You are OpenCode running inside VS Code Chat. Use available tools when helpful. Explain file changes clearly and keep responses concise.'),
    diagnosticsEnabled: config.get<boolean>('diagnostics.enabled', false),
    diagnosticsFullPayloads: config.get<boolean>('diagnostics.fullPayloads', false),
    diagnosticsWriteFile: config.get<boolean>('diagnostics.writeFile', false),
    diagnosticsFile: config.get<string>('diagnostics.file', '.opencode-chat-bridge/diagnostics.jsonl')
  };
}

function createDiagnostics(context: vscode.ExtensionContext): BridgeDiagnostics {
  const channel = vscode.window.createOutputChannel('OpenCode Chat Bridge');
  context.subscriptions.push(channel);

  return {
    channel,
    enabled: () => getSettings().diagnosticsEnabled,
    log: (message, data, options) => {
      const settings = getSettings();
      if (!settings.diagnosticsEnabled) {
        return;
      }

      const full = Boolean(options?.full && settings.diagnosticsFullPayloads);
      const payload = full
        ? redactSecrets(data)
        : sanitizeDiagnosticData(data);
      const suffix = data !== undefined
        ? (full && settings.diagnosticsWriteFile ? ' [full payload written to diagnostics file]' : ` ${safeJsonStringify(payload)}`)
        : '';
      const timestamp = new Date().toISOString();
      channel.appendLine(`[${timestamp}] ${message}${suffix}`);
      enqueueDiagnosticFileWrite(settings, {
        timestamp,
        event: message,
        full,
        data: payload
      });
    }
  };
}

function enqueueDiagnosticFileWrite(settings: BridgeSettings, entry: Record<string, unknown>): void {
  diagnosticWriteQueue = diagnosticWriteQueue
    .then(() => writeDiagnosticFile(settings, entry))
    .catch(error => {
      diagnostics?.channel.appendLine(`[${new Date().toISOString()}] diagnostics.writeFile.queueError ${error instanceof Error ? error.message : String(error)}`);
    });
}

async function writeDiagnosticFile(settings: BridgeSettings, entry: Record<string, unknown>): Promise<void> {
  if (!settings.diagnosticsWriteFile) {
    return;
  }

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return;
  }

  const relativePath = settings.diagnosticsFile.trim() || '.opencode-chat-bridge/diagnostics.jsonl';
  const safeRelativePath = relativePath.replace(/^[/\\]+/, '');
  const segments = safeRelativePath.split(/[\\/]+/).filter(Boolean);
  const target = vscode.Uri.joinPath(folder.uri, ...segments);

  try {
    const line = `${JSON.stringify(entry)}\n`;
    if (target.scheme === 'file') {
      await nodeFs.mkdir(nodePath.dirname(target.fsPath), { recursive: true });
      await nodeFs.appendFile(target.fsPath, line, 'utf8');
      return;
    }

    const parent = vscode.Uri.joinPath(folder.uri, ...segments.slice(0, -1));
    await vscode.workspace.fs.createDirectory(parent);
    const existing = await readExistingDiagnosticFile(target);
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(`${existing}${line}`));
  } catch (error) {
    diagnostics?.channel.appendLine(`[${new Date().toISOString()}] diagnostics.writeFile.error ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readExistingDiagnosticFile(uri: vscode.Uri): Promise<string> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return '';
  }
}

async function clearDiagnosticsFile(relativePath: string): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return;
  }

  const segments = relativePath.replace(/^[/\\]+/, '').split(/[\\/]+/).filter(Boolean);
  const target = vscode.Uri.joinPath(folder.uri, ...segments);
  const parent = vscode.Uri.joinPath(folder.uri, ...segments.slice(0, -1));
  await vscode.workspace.fs.createDirectory(parent);
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(''));
}

function diag(message: string, data?: unknown, options?: { full?: boolean }): void {
  diagnostics?.log(message, data, options);
}

function diagFull(message: string, data?: unknown): void {
  diagnostics?.log(message, data, { full: true });
}

function sanitizeDiagnosticData(value: unknown): unknown {
  if (value === undefined || value === null) {
    return value;
  }

  if (typeof value === 'string') {
    return value.length > 300 ? `${value.slice(0, 300)}...[${value.length} chars]` : value;
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map(sanitizeDiagnosticData);
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/api|key|token|authorization|secret|prompt|content|text/i.test(key)) {
      result[key] = `[redacted:${sizeOf(entry)}]`;
    } else {
      result[key] = sanitizeDiagnosticData(entry);
    }
  }
  return result;
}

function redactSecrets(value: unknown): unknown {
  if (value === undefined || value === null) {
    return value;
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/api[_-]?key|x-api-key|authorization|bearer|secret|token/i.test(key)) {
      result[key] = '[redacted]';
    } else {
      result[key] = redactSecrets(entry);
    }
  }
  return result;
}

function sizeOf(value: unknown): number {
  if (typeof value === 'string') {
    return value.length;
  }

  return safeJsonStringify(value).length;
}

function resolveModelInfo(id: string): OpenCodeModelInfo {
  return OPEN_CODE_MODELS.find(model => model.id === id) ?? OPEN_CODE_MODELS[0];
}

function buildUserPrompt(request: vscode.ChatRequest): string {
  const references = request.references
    .map(reference => `- ${describeReference(reference)}`)
    .filter(Boolean)
    .join('\n');

  if (!references) {
    return request.prompt;
  }

  return `${request.prompt}\n\nVS Code chat references attached by the user:\n${references}`;
}

function describeReference(reference: vscode.ChatPromptReference): string {
  const value = reference.value as unknown;
  if (value instanceof vscode.Uri) {
    return value.toString();
  }

  if (value && typeof value === 'object') {
    const location = value as { uri?: vscode.Uri; range?: vscode.Range };
    if (location.uri instanceof vscode.Uri) {
      return location.range ? `${location.uri.toString()}#${location.range.start.line + 1}-${location.range.end.line + 1}` : location.uri.toString();
    }
  }

  return String(value ?? reference.id ?? 'reference');
}

function getAvailableTools(request: vscode.ChatRequest): ToolInfo[] {
  const lmAny = vscode.lm as unknown as { tools?: unknown[] };
  const allTools = Array.isArray(lmAny.tools) ? lmAny.tools : [];
  const requestedToolNames = new Set(
    (request.toolReferences ?? [])
      .map(reference => String((reference as unknown as { name?: string; id?: string }).name ?? (reference as unknown as { id?: string }).id ?? ''))
      .filter(Boolean)
  );

  return allTools
    .map(normalizeToolInfo)
    .filter((tool): tool is ToolInfo => Boolean(tool))
    .filter(tool => requestedToolNames.size === 0 || requestedToolNames.has(tool.name));
}

function normalizeToolInfo(raw: unknown): ToolInfo | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const candidate = raw as { name?: unknown; id?: unknown; description?: unknown; inputSchema?: unknown; inputSchemaTokenCount?: unknown; tags?: unknown };
  const name = typeof candidate.name === 'string'
    ? candidate.name
    : typeof candidate.id === 'string'
      ? candidate.id
      : undefined;

  if (!name) {
    return undefined;
  }

  return {
    name,
    description: typeof candidate.description === 'string' ? candidate.description : undefined,
    inputSchema: candidate.inputSchema,
    raw
  };
}

function toOpenAiTools(tools: ToolInfo[]): OpenAiTool[] {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: sanitizeToolName(tool.name),
      description: tool.description ?? `VS Code tool ${tool.name}`,
      parameters: normalizeJsonSchema(tool.inputSchema)
    }
  }));
}

function toOpenAiToolFromLanguageModelTool(tool: vscode.LanguageModelChatTool): OpenAiTool {
  return {
    type: 'function',
    function: {
      name: sanitizeToolName(tool.name),
      description: tool.description,
      parameters: normalizeJsonSchema(tool.inputSchema)
    }
  };
}

function toOpenAiToolChoice(mode: vscode.LanguageModelChatToolMode): unknown {
  if (mode === vscode.LanguageModelChatToolMode.Required) {
    return 'required';
  }

  return 'auto';
}

function toAnthropicToolChoice(mode: vscode.LanguageModelChatToolMode): unknown {
  if (mode === vscode.LanguageModelChatToolMode.Required) {
    return { type: 'any' };
  }

  return { type: 'auto' };
}

function normalizeJsonSchema(schema: unknown): unknown {
  if (schema && typeof schema === 'object') {
    return schema;
  }

  return {
    type: 'object',
    properties: {},
    additionalProperties: true
  };
}

function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function findToolByCallName(callName: string, tools: ToolInfo[]): ToolInfo | undefined {
  const normalizedCallName = sanitizeToolName(callName);
  return tools.find(tool => sanitizeToolName(tool.name) === normalizedCallName || tool.name === callName);
}

async function callChatCompletions(
  settings: BridgeSettings,
  apiKey: string,
  messages: OpenAiMessage[],
  tools: OpenAiTool[],
  token: vscode.CancellationToken,
  options: ChatCompletionsOptions = {}
): Promise<ChatCompletionResponse> {
  const abort = new AbortController();
  const disposable = token.onCancellationRequested(() => abort.abort());

  try {
    const body: Record<string, unknown> = {
      model: settings.model,
      messages,
      temperature: settings.temperature,
      stream: options.stream ?? false
    };

    if (tools.length) {
      body.tools = tools;
      if (options.toolChoice !== undefined) {
        body.tool_choice = options.toolChoice;
      }
    }

    diagFull('http.openai.request.full', {
      endpoint: settings.endpoint,
      body
    });

    const response = await fetch(settings.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: abort.signal
    });

    const text = await response.text();
    diag('http.openai.response', { status: response.status, ok: response.ok, bodySize: text.length });
    diagFull('http.openai.response.full', { status: response.status, ok: response.ok, statusText: response.statusText, body: text });
    let parsed: ChatCompletionResponse;
    try {
      parsed = text ? JSON.parse(text) as ChatCompletionResponse : {};
    } catch {
      throw new Error(`Endpoint returned non-JSON response (${response.status}): ${text.slice(0, 500)}`);
    }

    if (!response.ok) {
      const errorMessage = parsed.error?.message ?? text.slice(0, 500) ?? response.statusText;
      throw new Error(`Endpoint returned ${response.status}: ${errorMessage}`);
    }

    if (parsed.error) {
      throw new Error(parsed.error.message ?? JSON.stringify(parsed.error));
    }

    diagFull('http.openai.parsed.full', parsed);
    diagFull('model.openai.httpParsedResponse.full', parsed);

    return parsed;
  } finally {
    disposable.dispose();
  }
}

async function callAnthropicMessages(
  modelInfo: OpenCodeModelInfo,
  settings: BridgeSettings,
  apiKey: string,
  requestMessages: AnthropicRequestMessages,
  tools: Array<{ name: string; description: string; input_schema: unknown }>,
  token: vscode.CancellationToken,
  options: AnthropicMessagesOptions = {}
): Promise<AnthropicResponse> {
  const abort = new AbortController();
  const disposable = token.onCancellationRequested(() => abort.abort());

  try {
    const body: Record<string, unknown> = {
      model: modelInfo.id,
      max_tokens: modelInfo.maxOutputTokens,
      temperature: settings.temperature,
      messages: requestMessages.messages,
      stream: false
    };

    if (requestMessages.system.length) {
      body.system = requestMessages.system.join('\n');
    }

    if (tools.length) {
      body.tools = tools;
      if (options.toolChoice !== undefined) {
        body.tool_choice = options.toolChoice;
      }
    }

    diagFull('http.anthropic.request.full', {
      endpoint: modelInfo.endpoint,
      body
    });

    const response = await fetch(modelInfo.endpoint, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: abort.signal
    });

    const text = await response.text();
    diag('http.anthropic.response', { status: response.status, ok: response.ok, bodySize: text.length });
    diagFull('http.anthropic.response.full', { status: response.status, ok: response.ok, statusText: response.statusText, body: text });
    let parsed: AnthropicResponse;
    try {
      parsed = text ? JSON.parse(text) as AnthropicResponse : {};
    } catch {
      throw new Error(`Endpoint returned non-JSON response (${response.status}): ${text.slice(0, 500)}`);
    }

    if (!response.ok) {
      const errorMessage = parsed.error?.message ?? text.slice(0, 500) ?? response.statusText;
      throw new Error(`Endpoint returned ${response.status}: ${errorMessage}`);
    }

    if (parsed.error) {
      throw new Error(parsed.error.message ?? JSON.stringify(parsed.error));
    }

    diagFull('http.anthropic.parsed.full', parsed);
    diagFull('model.anthropic.httpParsedResponse.full', parsed);

    return parsed;
  } finally {
    disposable.dispose();
  }
}

async function invokeVsCodeTool(
  toolCall: ToolCall,
  tools: ToolInfo[],
  toolInvocationToken: vscode.ChatParticipantToolToken | undefined,
  token: vscode.CancellationToken
): Promise<string> {
  const tool = findToolByCallName(toolCall.function.name, tools);
  if (!tool) {
    return JSON.stringify({ error: `Tool ${toolCall.function.name} is not available.` });
  }

  let input: unknown;
  try {
    input = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
  } catch (error) {
    diagFull('participant.invokeTool.parseError.full', { toolCall, error: error instanceof Error ? error.message : String(error) });
    return JSON.stringify({ error: `Invalid tool arguments JSON: ${error instanceof Error ? error.message : String(error)}` });
  }

  const lmAny = vscode.lm as unknown as {
    invokeTool?: (name: string, options: { input: unknown; toolInvocationToken?: unknown }, token: vscode.CancellationToken) => Thenable<unknown>;
  };

  if (typeof lmAny.invokeTool !== 'function') {
    return JSON.stringify({ error: 'This VS Code build does not expose vscode.lm.invokeTool to extensions.' });
  }

  try {
    diagFull('participant.invokeTool.input.full', { toolName: tool.name, input });
    const result = await lmAny.invokeTool(tool.name, { input, toolInvocationToken }, token);
    const serialized = stringifyToolResult(result);
    diagFull('participant.invokeTool.result.full', { toolName: tool.name, rawResult: result, serializedResult: serialized });
    return serialized;
  } catch (error) {
    diagFull('participant.invokeTool.error.full', { toolName: tool.name, error: error instanceof Error ? error.message : String(error) });
    return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
  }
}

function toOpenAiMessages(message: vscode.LanguageModelChatRequestMessage): OpenAiMessage[] {
  const role: ChatRole = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const toolResults: OpenAiMessage[] = [];

  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      textParts.push(part.value);
      continue;
    }

    if (part instanceof vscode.LanguageModelToolCallPart) {
      diagFull('convert.openai.toolCallPart.full', { callId: part.callId, name: part.name, input: part.input });
      toolCalls.push({
        id: part.callId,
        type: 'function',
        function: {
          name: sanitizeToolName(part.name),
          arguments: safeJsonStringify(part.input ?? {})
        }
      });
      continue;
    }

    if (part instanceof vscode.LanguageModelToolResultPart) {
      const content = stringifyToolResult(part.content);
      diagFull('convert.openai.toolResultPart.full', { callId: part.callId, rawContent: part.content, serializedContent: content });
      toolResults.push({
        role: 'tool',
        tool_call_id: part.callId,
        content
      });
      continue;
    }

    if (part instanceof vscode.LanguageModelDataPart) {
      textParts.push(`[${part.mimeType} data omitted: OpenCode Zen chat completions bridge currently forwards text and tool parts only.]`);
      continue;
    }

    textParts.push(safeJsonStringify(part));
  }

  const result: OpenAiMessage[] = [];

  if (textParts.length || toolCalls.length || !toolResults.length) {
    result.push({
      role,
      content: textParts.join('\n') || (toolCalls.length ? '' : null),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {})
    });
  }

  result.push(...toolResults);
  return result;
}

function toAnthropicMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): AnthropicRequestMessages {
  const system: string[] = [];
  const result: AnthropicMessage[] = [];

  for (const message of messages) {
    const role: 'user' | 'assistant' = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
    const content: AnthropicContentBlock[] = [];
    const toolResults: AnthropicContentBlock[] = [];

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        content.push({ type: 'text', text: part.value });
        continue;
      }

      if (part instanceof vscode.LanguageModelToolCallPart) {
        diagFull('convert.anthropic.toolCallPart.full', { callId: part.callId, name: part.name, input: part.input });
        content.push({
          type: 'tool_use',
          id: part.callId,
          name: sanitizeToolName(part.name),
          input: part.input ?? {}
        });
        continue;
      }

      if (part instanceof vscode.LanguageModelToolResultPart) {
        const content = stringifyToolResult(part.content);
        diagFull('convert.anthropic.toolResultPart.full', { callId: part.callId, rawContent: part.content, serializedContent: content });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: part.callId,
          content
        });
        continue;
      }

      if (part instanceof vscode.LanguageModelDataPart) {
        content.push({ type: 'text', text: `[${part.mimeType} data omitted: OpenCode Go bridge currently forwards text and tool parts only.]` });
        continue;
      }

      content.push({ type: 'text', text: safeJsonStringify(part) });
    }

    if (content.length) {
      if (role === 'user' && isLikelySystemMessage(content)) {
        system.push(...content.filter((part): part is { type: 'text'; text: string } => part.type === 'text').map(part => part.text));
      } else {
        result.push({ role, content });
      }
    }

    if (toolResults.length) {
      const previous = result.at(-1);
      if (previous?.role === 'user') {
        previous.content.push(...toolResults);
      } else {
        result.push({ role: 'user', content: toolResults });
      }
    }
  }

  if (!result.length) {
    result.push({ role: 'user', content: [{ type: 'text', text: '' }] });
  }

  return { system, messages: mergeAdjacentAnthropicMessages(result) };
}

function mergeAdjacentAnthropicMessages(messages: AnthropicMessage[]): AnthropicMessage[] {
  const merged: AnthropicMessage[] = [];

  for (const message of messages) {
    const previous = merged[merged.length - 1];
    if (previous?.role === message.role) {
      previous.content.push(...message.content);
    } else {
      merged.push({ role: message.role, content: [...message.content] });
    }
  }

  return merged;
}

function toAnthropicToolFromLanguageModelTool(tool: vscode.LanguageModelChatTool): { name: string; description: string; input_schema: unknown } {
  return {
    name: sanitizeToolName(tool.name),
    description: tool.description,
    input_schema: normalizeJsonSchema(tool.inputSchema)
  };
}

function isLikelySystemMessage(content: AnthropicContentBlock[]): boolean {
  if (content.length !== 1 || content[0].type !== 'text') {
    return false;
  }

  const text = content[0].text.trim().toLowerCase();
  return text.startsWith('you are ') || text.startsWith('system:');
}

function parseToolInput(value: unknown): object {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as object;
  }

  if (typeof value === 'string') {
    return parseToolArguments(value);
  }

  return { value };
}

function parseToolArguments(value: string): object {
  try {
    const parsed = value ? JSON.parse(value) : {};
    return parsed && typeof parsed === 'object' ? parsed as object : { value: parsed };
  } catch {
    return { value };
  }
}

function estimateTokenCount(text: string | vscode.LanguageModelChatRequestMessage): number {
  const content = typeof text === 'string'
    ? text
    : text.content.map(part => part instanceof vscode.LanguageModelTextPart ? part.value : safeJsonStringify(part)).join('\n');
  return Math.max(1, Math.ceil(content.length / 4));
}

function stringifyToolResult(result: unknown): string {
  if (result === undefined || result === null) {
    return '(tool returned empty result)';
  }

  if (typeof result === 'string') {
    return result.trim() ? result : '(tool returned empty result)';
  }

  if (result && typeof result === 'object') {
    const maybeContent = result as { content?: unknown; value?: unknown };
    if (Array.isArray(maybeContent.content)) {
      const content = maybeContent.content.map(part => stringifyToolResultPart(part)).filter(Boolean).join('\n');
      return content.trim() ? content : '(tool returned empty result)';
    }

    if (maybeContent.value !== undefined) {
      return stringifyToolResult(maybeContent.value);
    }
  }

  const serialized = safeJsonStringify(result);
  return serialized && serialized !== '{}' && serialized !== '[]' ? serialized : '(tool returned empty result)';
}

function stringifyToolResultPart(part: unknown): string {
  if (typeof part === 'string') {
    return part;
  }

  if (part && typeof part === 'object') {
    const candidate = part as { value?: unknown; text?: unknown; content?: unknown };
    if (typeof candidate.value === 'string') {
      return candidate.value;
    }
    if (typeof candidate.text === 'string') {
      return candidate.text;
    }
    if (typeof candidate.content === 'string') {
      return candidate.content;
    }
  }

  return safeJsonStringify(part);
}

function safeJsonStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, null, 2);
    return serialized === undefined ? 'undefined' : serialized;
  } catch {
    return String(value);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
