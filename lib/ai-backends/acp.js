import { spawn, execFileSync } from 'child_process';
import { AIBackend } from './base.js';

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
  console.log(`[ACP] Resolved PATH (${parts.size} entries), includes .local/bin: ${_shellPath.includes('.local/bin')}`);
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
      console.log(`[ACP] Found ${cmd} at: ${which}`);
    } catch {
      console.error(`[ACP] Full PATH (${shellPath.split(':').length} entries): ${shellPath}`);
      const msg = `Cannot find '${cmd}' in PATH. Install Kiro CLI or set the full path in Settings.`;
      console.error(`[ACP] ${msg}`);
      throw new Error(msg);
    }

    console.log(`[ACP] Spawning: ${cmd} acp`);
    this._process = spawn(cmd, ['acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: shellPath },
    });

    this._process.stdout.on('data', (chunk) => {
      this._buffer += chunk.toString();
      this._processBuffer();
    });

    this._process.stderr.on('data', (chunk) => {
      console.warn('[ACP stderr]', chunk.toString().trim());
    });

    this._process.on('error', (err) => {
      console.error('[ACP] Process error:', err.message);
      this._cleanup(err);
    });

    this._process.on('close', (code) => {
      console.warn(`[ACP] Process exited with code ${code}`);
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
          const { resolve, reject } = this._pending.get(msg.id);
          this._pending.delete(msg.id);
          if (msg.error) {
            reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            resolve(msg.result);
          }
        }

        // Notifications (no id, or id not in pending) with a method field
        if (msg.method) {
          for (const handler of this._notifications) {
            handler(msg);
          }
        }
      } catch {
        // Ignore malformed lines
      }
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
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      try {
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
    this._process = null;
    this._buffer = '';

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

  async _ensureSession() {
    await this._initialize();
    if (!this._sessionId) {
      const result = await this._sendRequest('session/new', {
        cwd: process.cwd(),
        mcpServers: [],
      });
      this._sessionId = result.sessionId;
      console.log(`[ACP] New session: ${this._sessionId}`);
    }
    return this._sessionId;
  }

  /**
   * Reset the session — drops the current session so the next chat creates a fresh one.
   * The kiro-cli process stays alive (MCP servers remain loaded), only the conversation
   * context is cleared. This is equivalent to starting a new chat in Kiro.
   */
  async resetSession() {
    if (this._sessionId) {
      console.log(`[ACP] Resetting session (was: ${this._sessionId})`);
      this._sessionId = null;
    }
  }

  async chat(messages, systemPrompt) {
    const chunks = [];
    for await (const chunk of this.chatStream(messages, systemPrompt)) {
      if (chunk.type === 'token') chunks.push(chunk.text);
      if (chunk.type === 'error') throw new Error(chunk.text);
    }
    return chunks.join('');
  }

  async *chatStream(messages, systemPrompt) {
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

      // Collect streamed tokens via notification handler
      let resolveNext;
      const queue = [];
      let done = false;

      const handler = (msg) => {
        // Kiro sends streaming chunks as session/update notifications
        if (msg.method === 'session/update') {
          const update = msg.params?.update;
          if (update?.sessionUpdate === 'agent_message_chunk') {
            const text = update.content?.text || '';
            if (text) {
              const item = { type: 'token', text };
              if (resolveNext) {
                const r = resolveNext;
                resolveNext = null;
                r(item);
              } else {
                queue.push(item);
              }
            }
          }
          // Other update types (tool_call, etc.) are ignored for now
        }
      };

      this._notifications.push(handler);

      // Send prompt — the JSON-RPC *response* signals completion (stopReason: 'end_turn')
      // So we handle it in .then() rather than via notification
      this._sendRequest('session/prompt', { sessionId, prompt })
        .then(() => {
          // Response received = turn complete
          done = true;
          const item = { type: 'done' };
          if (resolveNext) {
            const r = resolveNext;
            resolveNext = null;
            r(item);
          } else {
            queue.push(item);
          }
        })
        .catch((err) => {
          done = true;
          const item = { type: 'error', text: err.message };
          if (resolveNext) {
            const r = resolveNext;
            resolveNext = null;
            r(item);
          } else {
            queue.push(item);
          }
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
