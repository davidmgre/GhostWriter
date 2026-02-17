/**
 * Abstract AI backend. All adapters extend this.
 */
export class AIBackend {
  constructor(settings) {
    this.settings = settings;
  }

  /** Send messages array, return complete response string. */
  async chat(messages, systemPrompt) {
    throw new Error('chat() not implemented');
  }

  /**
   * Send messages, yield streaming chunks as async generator.
   * Chunks: { type: 'token', text } | { type: 'done' } | { type: 'error', text }
   * Default: falls back to non-streaming chat().
   */
  async *chatStream(messages, systemPrompt, imageAttachments, documentResource, fileAttachments) {
    const reply = await this.chat(messages, systemPrompt);
    yield { type: 'token', text: reply };
    yield { type: 'done' };
  }

  /** Test connectivity. Return { ok, model?, error? }. */
  async testConnection() {
    throw new Error('testConnection() not implemented');
  }

  /** Display name for UI. */
  getDisplayName() {
    return 'Unknown';
  }

  /** Clean up resources (child processes, connections). */
  async dispose() {}
}
