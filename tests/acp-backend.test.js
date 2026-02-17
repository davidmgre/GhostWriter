import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { Writable, Readable } from 'stream';

/**
 * Tests for ACPBackend.
 *
 * Strategy: Rather than mocking child_process at the module level (fragile with ESM
 * caching), we create a real backend instance and then inject a mock process into its
 * internals. This tests the actual JSON-RPC handling, notification routing, and state
 * management without requiring a real kiro-cli.
 */

// Import the class — we'll bypass _spawn/_initialize by injecting state directly
const { ACPBackend } = await import('../lib/ai-backends/acp.js');

/** Helper: create a mock child process with piped stdin/stdout/stderr */
function createMockProcess() {
  const proc = new EventEmitter();
  proc.stdin = new Writable({
    write(chunk, enc, cb) {
      proc._stdinData = (proc._stdinData || '') + chunk.toString();
      proc.emit('stdin-data', chunk.toString());
      cb();
    },
  });
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.killed = false;
  proc.kill = vi.fn(() => { proc.killed = true; });
  proc._stdinData = '';
  return proc;
}

/** Inject a mock process and mark as initialized with a session */
function injectMockSession(backend, proc, sessionId = 'test-session-123') {
  backend._process = proc;
  backend._initialized = true;
  backend._sessionId = sessionId;
  backend._buffer = '';
  backend._models = {
    currentModelId: 'claude-sonnet',
    availableModels: [
      { id: 'claude-sonnet', name: 'Claude Sonnet', description: '' },
      { id: 'claude-opus', name: 'Claude Opus', description: '' },
    ],
  };

  // Wire up stdout processing
  proc.stdout.on('data', (chunk) => {
    backend._buffer += chunk.toString();
    backend._processBuffer();
  });

  // Register persistent metadata listener (mirrors what _initialize does)
  backend._notifications.push((msg) => {
    if (msg.method === 'kiro.dev/metadata') {
      const pct = msg.params?.contextUsagePercentage;
      if (pct != null) {
        backend._contextUsage = { percentage: pct };
      }
    }
  });
}

/** Simulate Kiro sending a JSON-RPC response */
function sendResponse(proc, id, result) {
  proc.stdout.push(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

/** Simulate Kiro sending a notification (no id) */
function sendNotification(proc, method, params) {
  proc.stdout.push(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

/** Simulate Kiro sending an incoming request (has both id and method) */
function sendIncomingRequest(proc, id, method, params) {
  proc.stdout.push(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
}

/** Parse the last JSON-RPC message written to stdin */
function getLastSentMessage(proc) {
  const lines = proc._stdinData.trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

/** Get all JSON-RPC messages written to stdin */
function getAllSentMessages(proc) {
  return proc._stdinData.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

/** Wait for a message to be written to stdin */
function waitForStdin(proc) {
  return new Promise(resolve => proc.once('stdin-data', resolve));
}

describe('ACPBackend', () => {
  let backend;
  let proc;

  beforeEach(() => {
    proc = createMockProcess();
    backend = new ACPBackend({});
    injectMockSession(backend, proc);
  });

  afterEach(() => {
    // Clean up any lingering timers/promises
    backend._cleanup();
  });

  // --------------------------------------------------
  // P0: session/cancel
  // --------------------------------------------------
  describe('session/cancel', () => {
    it('sends session/cancel to Kiro when cancel() is called', async () => {
      // Set up listener BEFORE calling cancel (cancel writes synchronously)
      const stdinPromise = waitForStdin(proc);
      const cancelPromise = backend.cancel();
      await stdinPromise;

      const msg = getLastSentMessage(proc);
      expect(msg.method).toBe('session/cancel');
      expect(msg.params.sessionId).toBe('test-session-123');

      sendResponse(proc, msg.id, {});
      await cancelPromise;
    });

    it('does nothing when no session exists', async () => {
      backend._sessionId = null;
      await backend.cancel();
      // No message should have been sent
      expect(proc._stdinData).toBe('');
    });

    it('does not throw when cancel fails', async () => {
      // Auto-respond with error to any request
      proc.on('stdin-data', () => {
        const msg = getLastSentMessage(proc);
        if (msg.method === 'session/cancel') {
          proc.stdout.push(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            error: { message: 'nothing to cancel' },
          }) + '\n');
        }
      });

      // Should not throw
      await backend.cancel();
    });
  });

  // --------------------------------------------------
  // P0: Tool call progress streaming
  // --------------------------------------------------
  describe('tool call streaming', () => {
    it('yields tool_call, tool_call_update, and tool_result events', async () => {
      const chunks = [];
      const streamPromise = (async () => {
        for await (const chunk of backend.chatStream(
          [{ role: 'user', content: 'hello' }], 'system'
        )) {
          chunks.push(chunk);
          if (chunk.type === 'done' || chunk.type === 'error') break;
        }
      })();

      await waitForStdin(proc);
      const promptMsg = getLastSentMessage(proc);
      expect(promptMsg.method).toBe('session/prompt');

      // Simulate tool_call (Kiro sends fields at top level of update)
      sendNotification(proc, 'session/update', {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-123',
          title: 'Editing test.md',
          kind: 'edit',
        },
      });

      // Simulate tool_call_update
      sendNotification(proc, 'session/update', {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-123',
          title: 'Editing test.md',
          status: 'completed',
          locations: [{ path: '/test.md', line: 1 }],
        },
      });

      // Simulate tool_result
      sendNotification(proc, 'session/update', {
        update: { sessionUpdate: 'tool_result', toolCallId: 'tc-123', title: 'Editing test.md' },
      });

      // Simulate text response
      sendNotification(proc, 'session/update', {
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } },
      });

      // Complete prompt
      sendResponse(proc, promptMsg.id, { stopReason: 'end_turn' });
      await streamPromise;

      const types = chunks.map(c => c.type);
      expect(types).toContain('tool_call');
      expect(types).toContain('tool_call_update');
      expect(types).toContain('tool_result');
      expect(types).toContain('token');
      expect(types).toContain('done');

      expect(chunks.find(c => c.type === 'tool_call').title).toBe('Editing test.md');
      expect(chunks.find(c => c.type === 'tool_call').kind).toBe('edit');
      expect(chunks.find(c => c.type === 'tool_call').status).toBe('running');
      expect(chunks.find(c => c.type === 'tool_call_update').status).toBe('completed');
      expect(chunks.find(c => c.type === 'tool_call_update').locations).toEqual([{ path: '/test.md', line: 1 }]);
      expect(chunks.find(c => c.type === 'tool_result').status).toBe('done');
    });

    it('yields text tokens from agent_message_chunk', async () => {
      const chunks = [];
      const streamPromise = (async () => {
        for await (const chunk of backend.chatStream(
          [{ role: 'user', content: 'hi' }], null
        )) {
          chunks.push(chunk);
          if (chunk.type === 'done' || chunk.type === 'error') break;
        }
      })();

      await waitForStdin(proc);
      const msg = getLastSentMessage(proc);

      sendNotification(proc, 'session/update', {
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello!' } },
      });
      sendResponse(proc, msg.id, { stopReason: 'end_turn' });

      await streamPromise;
      expect(chunks.find(c => c.type === 'token').text).toBe('Hello!');
    });
  });

  // --------------------------------------------------
  // P1: Image input
  // --------------------------------------------------
  describe('image attachments', () => {
    it('includes image content blocks in prompt when provided', async () => {
      const images = [
        { data: 'base64data==', mimeType: 'image/png' },
        { data: 'another==', mimeType: 'image/jpeg' },
      ];

      const streamPromise = (async () => {
        for await (const chunk of backend.chatStream(
          [{ role: 'user', content: 'describe this' }], null, images
        )) {
          if (chunk.type === 'done' || chunk.type === 'error') break;
        }
      })();

      await waitForStdin(proc);
      const promptMsg = getLastSentMessage(proc);

      // Prompt should have text + 2 image blocks
      const prompt = promptMsg.params.prompt;
      expect(prompt).toHaveLength(3);
      expect(prompt[0].type).toBe('text');
      expect(prompt[1]).toEqual({ type: 'image', data: 'base64data==', mimeType: 'image/png' });
      expect(prompt[2]).toEqual({ type: 'image', data: 'another==', mimeType: 'image/jpeg' });

      sendResponse(proc, promptMsg.id, { stopReason: 'end_turn' });
      await streamPromise;
    });

    it('sends only text when no images provided', async () => {
      const streamPromise = (async () => {
        for await (const chunk of backend.chatStream(
          [{ role: 'user', content: 'hello' }], 'sys'
        )) {
          if (chunk.type === 'done' || chunk.type === 'error') break;
        }
      })();

      await waitForStdin(proc);
      const prompt = getLastSentMessage(proc).params.prompt;
      expect(prompt).toHaveLength(1);
      expect(prompt[0].type).toBe('text');

      sendResponse(proc, getLastSentMessage(proc).id, { stopReason: 'end_turn' });
      await streamPromise;
    });
  });

  // --------------------------------------------------
  // P2: Context usage
  // --------------------------------------------------
  describe('context usage', () => {
    it('starts with null context usage', () => {
      expect(backend.getContextUsage()).toBeNull();
    });

    it('captures context usage from prompt response', async () => {
      const chunks = [];
      const streamPromise = (async () => {
        for await (const chunk of backend.chatStream(
          [{ role: 'user', content: 'hi' }], null
        )) {
          chunks.push(chunk);
          if (chunk.type === 'done' || chunk.type === 'error') break;
        }
      })();

      await waitForStdin(proc);
      const msg = getLastSentMessage(proc);

      sendResponse(proc, msg.id, {
        stopReason: 'end_turn',
        contextUsage: { percentage: 42 },
      });

      await streamPromise;
      expect(backend.getContextUsage()).toEqual({ percentage: 42 });

      const usageChunk = chunks.find(c => c.type === 'context_usage');
      expect(usageChunk).toBeTruthy();
      expect(usageChunk.percentage).toBe(42);
    });

    it('captures context usage from turn_end notification', async () => {
      const streamPromise = (async () => {
        for await (const chunk of backend.chatStream(
          [{ role: 'user', content: 'hi' }], null
        )) {
          if (chunk.type === 'done' || chunk.type === 'error') break;
        }
      })();

      await waitForStdin(proc);
      const msg = getLastSentMessage(proc);

      sendNotification(proc, 'session/update', {
        update: { sessionUpdate: 'turn_end', contextUsage: { percentage: 78 } },
      });

      sendResponse(proc, msg.id, { stopReason: 'end_turn' });
      await streamPromise;

      expect(backend.getContextUsage()).toEqual({ percentage: 78 });
    });
  });

  // --------------------------------------------------
  // P2: kiro.dev/metadata (real-time context usage)
  // --------------------------------------------------
  describe('kiro.dev/metadata notifications', () => {
    it('captures context usage from metadata notification during streaming', async () => {
      const chunks = [];
      const streamPromise = (async () => {
        for await (const chunk of backend.chatStream(
          [{ role: 'user', content: 'hi' }], null
        )) {
          chunks.push(chunk);
          if (chunk.type === 'done' || chunk.type === 'error') break;
        }
      })();

      await waitForStdin(proc);
      const msg = getLastSentMessage(proc);

      // Simulate kiro.dev/metadata notification mid-stream
      sendNotification(proc, 'kiro.dev/metadata', { contextUsagePercentage: 42.5 });
      await new Promise(r => setTimeout(r, 10));

      // Backend state should be updated
      expect(backend.getContextUsage()).toEqual({ percentage: 42.5 });

      // SSE stream should contain a context_usage event
      const usageChunk = chunks.find(c => c.type === 'context_usage');
      expect(usageChunk).toBeTruthy();
      expect(usageChunk.percentage).toBe(42.5);

      sendResponse(proc, msg.id, { stopReason: 'end_turn' });
      await streamPromise;
    });

    it('updates context usage progressively as metadata arrives', async () => {
      const chunks = [];
      const streamPromise = (async () => {
        for await (const chunk of backend.chatStream(
          [{ role: 'user', content: 'hi' }], null
        )) {
          chunks.push(chunk);
          if (chunk.type === 'done' || chunk.type === 'error') break;
        }
      })();

      await waitForStdin(proc);
      const msg = getLastSentMessage(proc);

      // Multiple metadata updates during a single turn
      sendNotification(proc, 'kiro.dev/metadata', { contextUsagePercentage: 30 });
      await new Promise(r => setTimeout(r, 10));
      expect(backend.getContextUsage()).toEqual({ percentage: 30 });

      sendNotification(proc, 'kiro.dev/metadata', { contextUsagePercentage: 45 });
      await new Promise(r => setTimeout(r, 10));
      expect(backend.getContextUsage()).toEqual({ percentage: 45 });

      sendResponse(proc, msg.id, { stopReason: 'end_turn' });
      await streamPromise;

      // Should have emitted two context_usage events
      const usageChunks = chunks.filter(c => c.type === 'context_usage');
      expect(usageChunks).toHaveLength(2);
      expect(usageChunks[0].percentage).toBe(30);
      expect(usageChunks[1].percentage).toBe(45);
    });

    it('updates context via persistent listener outside chatStream', async () => {
      // Simulate metadata notification without an active chatStream
      // The persistent listener in _initialize should still update _contextUsage
      sendNotification(proc, 'kiro.dev/metadata', { contextUsagePercentage: 67 });
      await new Promise(r => setTimeout(r, 10));

      expect(backend.getContextUsage()).toEqual({ percentage: 67 });
    });

    it('ignores metadata notification without contextUsagePercentage', async () => {
      const chunks = [];
      const streamPromise = (async () => {
        for await (const chunk of backend.chatStream(
          [{ role: 'user', content: 'hi' }], null
        )) {
          chunks.push(chunk);
          if (chunk.type === 'done' || chunk.type === 'error') break;
        }
      })();

      await waitForStdin(proc);
      const msg = getLastSentMessage(proc);

      // Metadata without contextUsagePercentage should be ignored
      sendNotification(proc, 'kiro.dev/metadata', { someOtherField: 'value' });
      await new Promise(r => setTimeout(r, 10));

      expect(backend.getContextUsage()).toBeNull();
      expect(chunks.filter(c => c.type === 'context_usage')).toHaveLength(0);

      sendResponse(proc, msg.id, { stopReason: 'end_turn' });
      await streamPromise;
    });
  });

  // --------------------------------------------------
  // P2: Compaction status
  // --------------------------------------------------
  describe('compaction status', () => {
    it('starts as not compacting', () => {
      expect(backend.isCompacting()).toBe(false);
    });

    it('tracks compaction state from notifications', async () => {
      const chunks = [];
      const streamPromise = (async () => {
        for await (const chunk of backend.chatStream(
          [{ role: 'user', content: 'hi' }], null
        )) {
          chunks.push(chunk);
          if (chunk.type === 'done' || chunk.type === 'error') break;
        }
      })();

      await waitForStdin(proc);
      const msg = getLastSentMessage(proc);

      // Compaction starts
      sendNotification(proc, '_kiro.dev/compaction/status', { status: 'in_progress' });
      await new Promise(r => setTimeout(r, 10));
      expect(backend.isCompacting()).toBe(true);

      // Compaction ends
      sendNotification(proc, '_kiro.dev/compaction/status', { status: 'complete' });
      await new Promise(r => setTimeout(r, 10));
      expect(backend.isCompacting()).toBe(false);

      sendResponse(proc, msg.id, { stopReason: 'end_turn' });
      await streamPromise;

      const compactionChunks = chunks.filter(c => c.type === 'compaction');
      expect(compactionChunks).toHaveLength(2);
      expect(compactionChunks[0].status).toBe('in_progress');
      expect(compactionChunks[1].status).toBe('complete');
    });
  });

  // --------------------------------------------------
  // P2: Slash commands
  // --------------------------------------------------
  describe('slash commands', () => {
    it('fetches available commands from Kiro', async () => {
      const commandsPromise = backend.getCommands();
      await waitForStdin(proc);

      const msg = getLastSentMessage(proc);
      expect(msg.method).toBe('_kiro.dev/commands/available');

      sendResponse(proc, msg.id, {
        commands: [
          { name: 'agent swap', description: 'Switch agent mode' },
          { name: 'clear', description: 'Clear context' },
        ],
      });

      const commands = await commandsPromise;
      expect(commands).toHaveLength(2);
      expect(commands[0]).toEqual({ name: 'agent swap', description: 'Switch agent mode' });
      expect(commands[1]).toEqual({ name: 'clear', description: 'Clear context' });
    });

    it('caches commands after first fetch', async () => {
      // First fetch
      const p1 = backend.getCommands();
      await waitForStdin(proc);
      sendResponse(proc, getLastSentMessage(proc).id, {
        commands: [{ name: 'test', description: '' }],
      });
      const cmds1 = await p1;

      // Second fetch — should return cached
      const msgsBefore = getAllSentMessages(proc).length;
      const cmds2 = await backend.getCommands();
      const msgsAfter = getAllSentMessages(proc).length;

      expect(cmds2).toEqual(cmds1);
      expect(msgsAfter).toBe(msgsBefore); // no new message sent
    });

    it('executes a slash command', async () => {
      const execPromise = backend.executeCommand('/agent swap');
      await waitForStdin(proc);

      const msg = getLastSentMessage(proc);
      expect(msg.method).toBe('_kiro.dev/commands/execute');
      expect(msg.params.command).toBe('/agent swap');

      sendResponse(proc, msg.id, { success: true });
      const result = await execPromise;
      expect(result.success).toBe(true);
    });

    it('returns empty array when commands request fails', async () => {
      const commandsPromise = backend.getCommands();
      await waitForStdin(proc);

      const msg = getLastSentMessage(proc);
      proc.stdout.push(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        error: { message: 'not supported' },
      }) + '\n');

      const commands = await commandsPromise;
      expect(commands).toEqual([]);
    });
  });

  // --------------------------------------------------
  // Permission handling (existing, verify not broken)
  // --------------------------------------------------
  describe('permission handling', () => {
    it('auto-approves in edit mode', async () => {
      backend.editModeEnabled = true;

      sendIncomingRequest(proc, 999, 'session/request_permission', {
        toolCall: { title: 'Write file' },
        options: [
          { kind: 'allow_once', optionId: 'allow-1' },
          { kind: 'reject_once', optionId: 'reject-1' },
        ],
      });

      await new Promise(r => setTimeout(r, 50));

      const response = getAllSentMessages(proc).find(m => m.id === 999);
      expect(response).toBeTruthy();
      expect(response.result.outcome.outcome).toBe('selected');
      expect(response.result.outcome.optionId).toBe('allow-1');
    });

    it('auto-rejects in read-only mode', async () => {
      backend.editModeEnabled = false;

      sendIncomingRequest(proc, 888, 'session/request_permission', {
        toolCall: { title: 'Write file' },
        options: [
          { kind: 'allow_once', optionId: 'allow-1' },
          { kind: 'reject_once', optionId: 'reject-1' },
        ],
      });

      await new Promise(r => setTimeout(r, 50));

      const response = getAllSentMessages(proc).find(m => m.id === 888);
      expect(response).toBeTruthy();
      expect(response.result.outcome.optionId).toBe('reject-1');
    });
  });

  // --------------------------------------------------
  // Model selection
  // --------------------------------------------------
  describe('model selection', () => {
    it('returns cached models', () => {
      const models = backend.getModels();
      expect(models.currentModelId).toBe('claude-sonnet');
      expect(models.availableModels).toHaveLength(2);
    });

    it('sends session/set_model when setModel() is called', async () => {
      const setPromise = backend.setModel('claude-opus');
      await waitForStdin(proc);

      const msg = getLastSentMessage(proc);
      expect(msg.method).toBe('session/set_model');
      expect(msg.params.modelId).toBe('claude-opus');

      sendResponse(proc, msg.id, {});
      await setPromise;

      expect(backend.getModels().currentModelId).toBe('claude-opus');
    });
  });

  // --------------------------------------------------
  // Cleanup
  // --------------------------------------------------
  describe('cleanup', () => {
    it('clears all state on cleanup', () => {
      expect(backend.getModels()).not.toBeNull();

      backend._cleanup(new Error('test'));

      expect(backend.getModels()).toBeNull();
      expect(backend.getContextUsage()).toBeNull();
      expect(backend.isCompacting()).toBe(false);
      expect(backend._sessionId).toBeNull();
      expect(backend._initialized).toBe(false);
    });

    it('rejects all pending requests on cleanup', async () => {
      const promise = backend._sendRequest('test/method', {});

      backend._cleanup(new Error('crash'));

      await expect(promise).rejects.toThrow('crash');
    });
  });

  // --------------------------------------------------
  // _processBuffer (JSON-RPC parsing)
  // --------------------------------------------------
  describe('buffer processing', () => {
    it('handles partial messages across chunks', async () => {
      const stdinPromise = waitForStdin(proc);
      const promise = backend._sendRequest('test', {});
      await stdinPromise;
      const msg = getLastSentMessage(proc);

      // Send response in two parts
      const response = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
      const mid = Math.floor(response.length / 2);
      proc.stdout.push(response.slice(0, mid));
      proc.stdout.push(response.slice(mid) + '\n');

      const result = await promise;
      expect(result.ok).toBe(true);
    });

    it('ignores malformed lines', () => {
      // Should not throw
      proc.stdout.push('this is not json\n');
      proc.stdout.push('{incomplete\n');
    });
  });
});
