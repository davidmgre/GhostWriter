import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AIBackend } from './base.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(__dirname, '..', '..', '.acp-session.json');

// Timestamp for log lines — returns HH:MM:SS.mmm (same as server.mjs)
function ts() {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

// Abbreviate paths for logging — same logic as server.mjs logPath
function logPath(p) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  const segments = p.split(path.sep).filter(Boolean);
  if (segments.length > 2) return '.../' + segments.slice(-2).join('/');
  return p;
}

// Resolve the user's full PATH including user-installed binaries.
// Under launchd the inherited PATH is minimal (set in plist). We try to
// get the real PATH from the user's shell, and also manually check common
// user binary locations as a fallback.
let _shellPath;
function getShellPath() {
  if (_shellPath !== undefined) return _shellPath;

  // Start with the current PATH
  const parts = new Set((process.env.PATH || '').split(':'));

  // Determine home directory (may not be in env under launchd)
  const home = process.env.HOME || `/Users/${process.env.USER || 'user'}`;

  // Try to get full PATH from user's login+interactive shell
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const shellPath = execFileSync(shell, ['-ilc', 'echo "$PATH"'], {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env, HOME: home, SHELL: shell },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    for (const p of shellPath.split(':')) {
      if (p) parts.add(p);
    }
  } catch {
    // Shell resolution failed — add common user paths manually
  }

  // Always ensure common user binary locations are included
  const commonPaths = [
    `${home}/.local/bin`,
    `${home}/.cargo/bin`,
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  for (const p of commonPaths) {
    parts.add(p);
  }

  _shellPath = [...parts].join(':');
  console.log(`[ACP ${ts()}] Resolved PATH (${parts.size} entries), includes .local/bin: ${_shellPath.includes('.local/bin')}`);
  return _shellPath;
}

/**
 * ACP (Agent Communication Protocol) backend for Kiro.
 * Speaks JSON-RPC 2.0 over stdin/stdout of `kiro-cli acp`.
 *
 * Protocol (verified against kiro-cli 1.25.1):
 *   initialize  → { protocolVersion, clientInfo }
 *   session/new → { cwd, mcpServers: [] }     → { sessionId, modes }
 *   session/prompt → { sessionId, prompt: [{ type:'text', text }] }
 *     Streaming via notifications: method "session/update"
 *       { update: { sessionUpdate: 'agent_message_chunk', content: { type:'text', text } } }
 *     Completion via JSON-RPC response: { stopReason: 'end_turn' }
 */
export class ACPBackend extends AIBackend {
  constructor(settings) {
    super(settings);
    this._process = null;
    this._buffer = '';
    this._requestId = 0;
    this._pending = new Map(); // id → { resolve, reject }
    this._notifications = []; // notification handlers
    this._sessionId = null;
    this._initialized = false;
    this._models = null; // { currentModelId, availableModels } from session/new
    this._modes = null; // { currentModeId, availableModes } from session/new
    this._contextUsage = null; // { percentage } from turn_end updates
    this._compacting = false; // true while context compaction is in progress
    this._commands = null; // slash commands from _kiro.dev/commands/available
    this._sessionLock = null; // mutex for _ensureSession to prevent concurrent setup
    this.editModeEnabled = false; // set by server when user toggles edit mode
  }

  _getCommand() {
    return this.settings.ai_kiro_command || 'kiro-cli';
  }

  _spawn() {
    if (this._process) return;

    const cmd = this._getCommand();
    const shellPath = getShellPath();

    // Check if the command is findable before spawning
    try {
      const which = execFileSync('/usr/bin/which', [cmd], {
        encoding: 'utf-8',
        timeout: 3000,
        env: { ...process.env, PATH: shellPath },
      }).trim();
      console.log(`[ACP ${ts()}] Found ${cmd} at: ${logPath(which)}`);
    } catch {
      console.error(`[ACP ${ts()}] Full PATH (${shellPath.split(':').length} entries): ${shellPath}`);
      const msg = `Cannot find '${cmd}' in PATH. Install Kiro CLI or set the full path in Settings.`;
      console.error(`[ACP ${ts()}] ${msg}`);
      throw new Error(msg);
    }

    const kiroLogFile = '/tmp/kiro-acp-debug.log';
    console.log(`[ACP ${ts()}] Spawning: ${cmd} acp (debug log: ${kiroLogFile})`);
    this._process = spawn(cmd, ['acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: shellPath,
        KIRO_LOG_LEVEL: 'debug',
        KIRO_CHAT_LOG_FILE: kiroLogFile,
      },
    });

    this._process.stdout.on('data', (chunk) => {
      this._buffer += chunk.toString();
      this._processBuffer();
    });

    this._process.stderr.on('data', (chunk) => {
      console.warn(`[ACP ${ts()} stderr]`, chunk.toString().trim());
    });

    this._process.on('error', (err) => {
      console.error(`[ACP ${ts()}] Process error:`, err.message);
      this._cleanup(err);
    });

    this._process.on('close', (code) => {
      console.warn(`[ACP ${ts()}] Process exited with code ${code}`);
      this._cleanup(new Error(`ACP process exited (code ${code})`));
    });
  }

  _processBuffer() {
    const lines = this._buffer.split('\n');
    this._buffer = lines.pop(); // Keep incomplete line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed);

        if (msg.id !== undefined && this._pending.has(msg.id)) {
          // Response to our request
          const { method: reqMethod, resolve, reject } = this._pending.get(msg.id);
          this._pending.delete(msg.id);
          console.log(`[ACP ${ts()}] ← ${reqMethod} ${msg.error ? 'ERROR: ' + (msg.error.message || JSON.stringify(msg.error)) : 'OK'}`);
          if (msg.error) {
            reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            resolve(msg.result);
          }
        }

        // Handle incoming requests from Kiro (has both id and method, id NOT in pending)
        if (msg.id !== undefined && msg.method && !this._pending.has(msg.id)) {
          this._handleIncomingRequest(msg);
        }

        // Notifications (no id) with a method field
        if (msg.id === undefined && msg.method) {
          for (const handler of this._notifications) {
            handler(msg);
          }
        }
      } catch {
        // Ignore malformed lines
      }
    }
  }

  _sendResponse(id, result) {
    if (!this._process || this._process.killed) return;
    const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
    try {
      this._process.stdin.write(msg + '\n');
    } catch (err) {
      console.error(`[ACP ${ts()}] Failed to send response:`, err.message);
    }
  }

  _handleIncomingRequest(msg) {
    const { id, method, params } = msg;

    if (method === 'session/request_permission') {
      // Kiro is asking for permission to use a tool (e.g., file write).
      // Response must follow ACP schema: { outcome: { outcome: "selected", optionId } }
      const options = params?.options || [];
      const toolCall = params?.toolCall || {};
      console.log(`[ACP ${ts()}] Permission request: ${toolCall.title || 'unknown'} (edit mode: ${this.editModeEnabled})`);

      if (this.editModeEnabled) {
        // Auto-approve: pick "allow_once" or first allow option
        const allowOption = options.find(o => o.kind === 'allow_once')
          || options.find(o => o.kind?.startsWith('allow'));
        const optionId = allowOption?.optionId || 'allow_once';
        console.log(`[ACP ${ts()}] Auto-approving: ${optionId}`);
        this._sendResponse(id, { outcome: { outcome: 'selected', optionId } });
      } else {
        // Reject in read-only mode
        const rejectOption = options.find(o => o.kind === 'reject_once')
          || options.find(o => o.kind?.startsWith('reject'));
        const optionId = rejectOption?.optionId || 'reject_once';
        console.log(`[ACP ${ts()}] Rejecting (read-only mode): ${optionId}`);
        this._sendResponse(id, { outcome: { outcome: 'selected', optionId } });
      }
    } else {
      // Unknown incoming request — respond with error
      console.warn(`[ACP ${ts()}] Unhandled incoming request: ${method}`);
      this._sendResponse(id, {});
    }
  }

  _sendRequest(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this._process || this._process.killed) {
        reject(new Error('ACP process not running'));
        return;
      }

      const id = ++this._requestId;
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });

      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`ACP request timed out: ${method}`));
        }
      }, 60000);

      this._pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      try {
        console.log(`[ACP ${ts()}] → ${method}`);
        this._process.stdin.write(msg + '\n');
      } catch (err) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  _cleanup(err) {
    this._sessionId = null;
    this._initialized = false;
    this._models = null;
    this._modes = null;
    this._contextUsage = null;
    this._compacting = false;
    this._commands = null;
    this._sessionLock = null;
    this._process = null;
    this._buffer = '';

    // Clear persisted session — a session from a dead process cannot be
    // reliably resumed on a new kiro-cli instance and may cause prompts
    // to silently hang.
    this._clearSessionId();

    for (const [, { reject }] of this._pending) {
      reject(err || new Error('ACP process terminated'));
    }
    this._pending.clear();
    this._notifications = [];
  }

  async _initialize() {
    if (this._initialized) return;
    this._spawn();
    await this._sendRequest('initialize', {
      protocolVersion: '1.0',
      clientInfo: { name: 'ghostwriter', version: '1.0.0' },
    });
    this._initialized = true;
  }

  _saveSessionId(sessionId) {
    try {
      fs.writeFileSync(SESSION_FILE, JSON.stringify({ sessionId, timestamp: Date.now() }));
    } catch (err) {
      console.warn(`[ACP ${ts()}] Failed to save session ID: ${err.message}`);
    }
  }

  _loadSessionId() {
    try {
      if (fs.existsSync(SESSION_FILE)) {
        const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
        // Only reuse sessions less than 24h old
        if (data.sessionId && data.timestamp && (Date.now() - data.timestamp) < 24 * 60 * 60 * 1000) {
          return data.sessionId;
        }
      }
    } catch {}
    return null;
  }

  _clearSessionId() {
    try {
      if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
    } catch {}
  }

  _getDocsCwd() {
    const docsDir = this.settings?.docsDir;
    return docsDir
      ? (path.isAbsolute(docsDir) ? docsDir : path.resolve(docsDir))
      : process.cwd();
  }

  async _ensureSession() {
    // Serialize concurrent callers — only one session setup at a time
    if (this._sessionLock) {
      return this._sessionLock;
    }
    this._sessionLock = this._doEnsureSession();
    try {
      return await this._sessionLock;
    } finally {
      this._sessionLock = null;
    }
  }

  async _doEnsureSession() {
    await this._initialize();
    if (!this._sessionId) {
      const cwd = this._getDocsCwd();

      // Try to resume a persisted session first
      const savedId = this._loadSessionId();
      if (savedId) {
        try {
          console.log(`[ACP ${ts()}] Attempting to resume session: ${savedId}`);
          const result = await this._sendRequest('session/load', { sessionId: savedId, cwd, mcpServers: [] });
          this._sessionId = result.sessionId || savedId;
          this._cacheModels(result);
          this._cacheModes(result);
          console.log(`[ACP ${ts()}] Resumed session: ${this._sessionId}`);
          return this._sessionId;
        } catch (err) {
          console.log(`[ACP ${ts()}] Could not resume session: ${err.message} — creating new`);
          this._clearSessionId();
        }
      }

      // Use the documents directory as cwd so Kiro has write access to the
      // files being edited, rather than the GhostWriter project directory.
      console.log(`[ACP ${ts()}] Creating session with cwd: ${logPath(cwd)}`);
      const result = await this._sendRequest('session/new', {
        cwd,
        mcpServers: [],
      });
      this._sessionId = result.sessionId;
      this._saveSessionId(this._sessionId);
      this._cacheModels(result);
      this._cacheModes(result);
      if (this._models) {
        console.log(`[ACP ${ts()}] Models: ${this._models.availableModels.map(m => m.id).join(', ')} (current: ${this._models.currentModelId})`);
      }
      console.log(`[ACP ${ts()}] New session: ${this._sessionId}`);
    }
    return this._sessionId;
  }

  _cacheModels(result) {
    if (result.models && result.models.availableModels) {
      this._models = {
        currentModelId: result.models.currentModelId || 'auto',
        availableModels: result.models.availableModels.map(m => ({
          id: m.modelId,
          name: m.name || m.modelId,
          description: m.description || '',
        })),
      };
    }
  }

  _cacheModes(result) {
    if (result.modes && result.modes.availableModes) {
      this._modes = {
        currentModeId: result.modes.currentModeId || null,
        availableModes: result.modes.availableModes.map(m => ({
          id: m.modeId || m.id,
          name: m.name || m.modeId || m.id,
          description: m.description || '',
        })),
      };
      console.log(`[ACP ${ts()}] Modes: ${this._modes.availableModes.map(m => m.id).join(', ')} (current: ${this._modes.currentModeId})`);
    }
  }

  /**
   * Reset the session — drops the current session so the next chat creates a fresh one.
   * The kiro-cli process stays alive (MCP servers remain loaded), only the conversation
   * context is cleared. This is equivalent to starting a new chat in Kiro.
   */
  async resetSession() {
    if (this._sessionId) {
      console.log(`[ACP ${ts()}] Resetting session (was: ${this._sessionId})`);
      this._sessionId = null;
      this._models = null;
      this._modes = null;
      this._clearSessionId();
    }
  }

  /**
   * Returns cached model info from the current session, or null if no session yet.
   */
  getModels() {
    return this._models || null;
  }

  /**
   * Returns cached mode info from the current session, or null if no session yet.
   */
  getModes() {
    return this._modes || null;
  }

  /**
   * Switch the active mode on the current session.
   */
  async setMode(modeId) {
    const sessionId = await this._ensureSession();
    console.log(`[ACP ${ts()}] Set mode: ${modeId}`);
    await this._sendRequest('session/set_mode', { sessionId, modeId });
    if (this._modes) {
      this._modes.currentModeId = modeId;
    }
  }

  /**
   * Returns current context usage info, or null if not available.
   */
  getContextUsage() {
    return this._contextUsage || null;
  }

  /**
   * Returns whether context compaction is in progress.
   */
  isCompacting() {
    return this._compacting;
  }

  /**
   * Switch the active model on the current session.
   */
  async setModel(modelId) {
    const sessionId = await this._ensureSession();
    console.log(`[ACP ${ts()}] Set model: ${modelId}`);
    await this._sendRequest('session/set_model', { sessionId, modelId });
    if (this._models) {
      this._models.currentModelId = modelId;
    }
  }

  /**
   * Cancel the current in-flight prompt via ACP session/cancel.
   * This tells Kiro to stop generating, rather than just dropping the HTTP connection.
   */
  async cancel() {
    if (!this._sessionId) return;
    try {
      console.log(`[ACP ${ts()}] Cancelling session: ${this._sessionId}`);
      await this._sendRequest('session/cancel', { sessionId: this._sessionId });
    } catch (err) {
      // Don't throw — cancellation is best-effort
      console.warn(`[ACP ${ts()}] Cancel failed: ${err.message}`);
    }
  }

  /**
   * Fetch available slash commands from Kiro after session is ready.
   */
  async getCommands() {
    if (this._commands) return this._commands;
    const sessionId = await this._ensureSession();
    try {
      const result = await this._sendRequest('_kiro.dev/commands/available', { sessionId });
      this._commands = (result?.commands || []).map(c => ({
        name: c.name,
        description: c.description || '',
      }));
      console.log(`[ACP ${ts()}] Commands: ${this._commands.map(c => c.name).join(', ')}`);
      return this._commands;
    } catch (err) {
      // "Method not found" is expected for kiro-cli versions without slash command support
      if (!/method not found/i.test(err.message)) {
        console.warn(`[ACP ${ts()}] Failed to fetch commands: ${err.message}`);
      }
      return [];
    }
  }

  /**
   * Get autocomplete options for a partial command input.
   */
  async getCommandOptions(input) {
    const sessionId = await this._ensureSession();
    try {
      const result = await this._sendRequest('_kiro.dev/commands/options', { sessionId, input });
      return result?.options || [];
    } catch (err) {
      console.warn(`[ACP ${ts()}] Command options failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Execute a slash command.
   */
  async executeCommand(command) {
    const sessionId = await this._ensureSession();
    console.log(`[ACP ${ts()}] Executing command: ${command}`);
    const result = await this._sendRequest('_kiro.dev/commands/execute', { sessionId, command });
    return result;
  }

  async chat(messages, systemPrompt) {
    const chunks = [];
    for await (const chunk of this.chatStream(messages, systemPrompt)) {
      if (chunk.type === 'token') chunks.push(chunk.text);
      if (chunk.type === 'error') throw new Error(chunk.text);
    }
    return chunks.join('');
  }

  async *chatStream(messages, systemPrompt, imageAttachments, documentResource, fileAttachments) {
    try {
      const sessionId = await this._ensureSession();

      // Build prompt text from messages
      const parts = [];
      if (systemPrompt) parts.push(`[System] ${systemPrompt}`);
      for (const msg of messages) {
        const prefix = msg.role === 'user' ? 'User' : 'Assistant';
        parts.push(`${prefix}: ${msg.content}`);
      }
      const promptText = parts.join('\n\n');

      // Prompt must be an array of content blocks
      const prompt = [{ type: 'text', text: promptText }];

      // Append document as a resource content block (ACP spec).
      // Sends the file content with URI and MIME type so Kiro treats it as a file.
      // Also embedded as text fallback in the system prompt in case the agent
      // doesn't support resource content blocks.
      if (documentResource) {
        prompt.push({
          type: 'resource',
          resource: {
            uri: documentResource.uri,
            text: documentResource.content,
            mimeType: documentResource.mimeType || 'text/markdown',
          },
        });
      }

      // Append image content blocks if any
      if (imageAttachments && imageAttachments.length > 0) {
        for (const img of imageAttachments) {
          prompt.push({
            type: 'image',
            data: img.data,
            mimeType: img.mimeType || 'image/png',
          });
        }
      }

      // Append file content blocks as resource blocks
      if (fileAttachments && fileAttachments.length > 0) {
        for (const file of fileAttachments) {
          prompt.push({
            type: 'resource',
            resource: {
              uri: `file://attachment/${file.name}`,
              text: file.data,
              mimeType: file.mimeType || 'text/plain',
            },
          });
        }
      }

      // Collect streamed tokens via notification handler
      let resolveNext;
      const queue = [];
      let done = false;

      const enqueue = (item) => {
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r(item);
        } else {
          queue.push(item);
        }
      };

      const handler = (msg) => {
        // Kiro sends streaming chunks as session/update notifications
        if (msg.method === 'session/update') {
          const update = msg.params?.update;
          if (update?.sessionUpdate === 'agent_message_chunk') {
            const text = update.content?.text || '';
            if (text) {
              enqueue({ type: 'token', text });
            }
          } else if (update?.sessionUpdate === 'tool_call') {
            // Tool invocation starting — fields are top-level (title, kind, toolCallId)
            const id = update.toolCallId;
            const title = update.title || update.name || 'Tool call';
            const kind = update.kind; // 'edit', 'read', etc.
            console.log(`[ACP ${ts()}] tool_call: ${title} (${kind || 'unknown'})`);
            enqueue({ type: 'tool_call', id, title, kind, status: 'running' });
          } else if (update?.sessionUpdate === 'tool_call_update') {
            // Progress/completion update — includes status, locations
            const id = update.toolCallId;
            const title = update.title || update.name || 'Tool call';
            const status = update.status || 'running'; // 'completed', etc.
            const locations = update.locations; // [{ path, line }]
            console.log(`[ACP ${ts()}] tool_call_update: ${title} (${status})`);
            enqueue({ type: 'tool_call_update', id, title, status, locations });
          } else if (update?.sessionUpdate === 'tool_result') {
            // Tool call finished
            const id = update.toolCallId;
            const title = update.title || update.name || 'Tool call';
            console.log(`[ACP ${ts()}] tool_result: ${title}`);
            enqueue({ type: 'tool_result', id, title, status: 'done' });
          } else if (update?.sessionUpdate === 'turn_end') {
            // Turn ended — check for context usage info
            if (update.contextUsage) {
              this._contextUsage = update.contextUsage;
            }
          }
          // Log unexpected update types
          if (update?.sessionUpdate &&
              !['agent_message_chunk', 'tool_call', 'tool_call_update', 'tool_result', 'turn_end'].includes(update.sessionUpdate)) {
            console.log(`[ACP ${ts()}] session/update: ${update.sessionUpdate}`, JSON.stringify(update).substring(0, 200));
          }
        }
        // Handle context usage from Kiro extensions
        if (msg.method === '_kiro.dev/compaction/status') {
          const status = msg.params?.status || 'unknown';
          console.log(`[ACP ${ts()}] Compaction status: ${status}`);
          this._compacting = status === 'in_progress';
          enqueue({ type: 'compaction', status });
        }
      };

      this._notifications.push(handler);

      // Send prompt — the JSON-RPC *response* signals completion (stopReason: 'end_turn')
      // So we handle it in .then() rather than via notification
      console.log(`[ACP ${ts()}] Sending prompt (${prompt.length} content blocks, ${prompt[0]?.text?.length || 0} chars)`);
      this._sendRequest('session/prompt', { sessionId, prompt })
        .then((result) => {
          // Capture context usage from the prompt response if present
          if (result?.contextUsage) {
            this._contextUsage = result.contextUsage;
            enqueue({ type: 'context_usage', ...result.contextUsage });
          }
          // Response received = turn complete
          done = true;
          enqueue({ type: 'done' });
        })
        .catch((err) => {
          done = true;
          enqueue({ type: 'error', text: err.message });
        });

      // Yield chunks as they arrive
      while (!done || queue.length > 0) {
        if (queue.length > 0) {
          const item = queue.shift();
          yield item;
          if (item.type === 'done' || item.type === 'error') break;
        } else {
          const item = await new Promise((resolve) => { resolveNext = resolve; });
          yield item;
          if (item.type === 'done' || item.type === 'error') break;
        }
      }

      // Remove handler
      this._notifications = this._notifications.filter(h => h !== handler);
    } catch (err) {
      yield { type: 'error', text: err.message };
    }
  }

  async testConnection() {
    try {
      await this._initialize();
      return { ok: true, model: 'Kiro ACP' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  getDisplayName() {
    return 'Kiro';
  }

  async dispose() {
    if (!this._process) return;

    try {
      await Promise.race([
        this._sendRequest('shutdown', {}),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000)),
      ]);
    } catch {
      // Ignore — will force kill
    }

    if (this._process && !this._process.killed) {
      this._process.kill('SIGTERM');
    }
    this._cleanup();
  }
}
