import { ACPBackend } from './acp.js';

/**
 * Create a backend instance from settings.
 * @param {object} settings - All ai_* settings
 */
export function createBackend(settings) {
  return new ACPBackend(settings);
}

/** Singleton backend instance. */
let _currentBackend = null;

/**
 * Get or create the singleton backend.
 * Manages Kiro CLI process lifecycle — reuses the same child process across requests.
 */
export async function getBackend(settings) {
  if (_currentBackend) {
    // Update settings reference in case they changed
    _currentBackend.settings = settings;
    return _currentBackend;
  }

  _currentBackend = createBackend(settings);
  return _currentBackend;
}

/**
 * Dispose the current backend. Called on server shutdown.
 */
export async function disposeBackend() {
  if (_currentBackend) {
    await _currentBackend.dispose();
    _currentBackend = null;
  }
}
