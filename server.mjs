import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { getBackend, disposeBackend } from './lib/ai-backends/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Timestamp for log lines — returns HH:MM:SS.mmm
function ts() {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

// Abbreviate paths for logging — avoid leaking full host/volume paths
function logPath(p) {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  // For external volumes or long paths, show only the last 2 segments
  const segments = p.split(path.sep).filter(Boolean);
  if (segments.length > 2) return '.../' + segments.slice(-2).join('/');
  return p;
}

const app = express();
const PORT = 3888;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Paths
const SETTINGS_PATH = path.join(__dirname, 'settings.json');
const CHAT_PATH = path.join(__dirname, 'chat-messages.json');


// --- Settings management ---
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    }
  } catch (err) {
    console.warn('Failed to load settings:', err.message);
  }
  return { docsDir: path.join(__dirname, 'documents') };
}

function saveSettings(s) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

let settings = loadSettings();

function getDocsDir() {
  const dir = settings.docsDir || path.join(__dirname, 'documents');
  return path.isAbsolute(dir) ? dir : path.resolve(__dirname, dir);
}

// --- Edit mode + write tracking ---
let editModeEnabled = false;
// Track our own writes so the watcher can distinguish them from external (LLM) edits.
// Maps absolute file path → timestamp of our last write.
const ownWrites = new Map();
const OWN_WRITE_WINDOW_MS = 2000; // ignore watcher events within 2s of our own write

function markOwnWrite(filePath) {
  ownWrites.set(filePath, Date.now());
}

function isOwnWrite(filePath) {
  const ts = ownWrites.get(filePath);
  if (!ts) return false;
  if (Date.now() - ts < OWN_WRITE_WINDOW_MS) return true;
  ownWrites.delete(filePath);
  return false;
}

// Cache of last known good content per doc, used for rollback
const lastKnownContent = new Map();

// --- SSE clients for live reload ---
let sseClients = [];

function broadcastSSE(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(res => {
    try { res.write(msg); return true; } catch { return false; }
  });
}

// --- File watcher ---
let activeWatcher = null;
let watchDebounceTimers = {};

function setupFileWatcher() {
  if (activeWatcher) {
    try { activeWatcher.close(); } catch {}
    activeWatcher = null;
  }
  watchDebounceTimers = {};

  const dir = getDocsDir();
  if (!fs.existsSync(dir)) return;

  try {
    activeWatcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const isMd = filename.endsWith('.md');
      if (!isMd && path.extname(filename)) return;

      const key = filename;
      if (watchDebounceTimers[key]) clearTimeout(watchDebounceTimers[key]);
      watchDebounceTimers[key] = setTimeout(() => {
        delete watchDebounceTimers[key];

        if (isMd) {
          const absPath = path.join(dir, filename);

          // Check if this was our own write
          if (!isOwnWrite(absPath) && !editModeEnabled) {
            // External edit while in read-only mode — revert it
            const parts = filename.split(path.sep);
            let docId;
            if (parts.length === 1) {
              docId = 'file:' + parts[0];
            } else {
              docId = parts[0];
            }

            const cached = lastKnownContent.get(docId);
            if (cached !== undefined) {
              try {
                const currentContent = fs.readFileSync(absPath, 'utf-8');
                if (currentContent !== cached) {
                  console.log(`[ReadOnly ${ts()}] Reverting unauthorized edit to ${filename}`);
                  markOwnWrite(absPath);
                  fs.writeFileSync(absPath, cached, 'utf-8');
                  broadcastSSE('edit-reverted', {
                    docId,
                    message: 'Edit reverted — Read-Only mode is active. Enable AI Edit to allow changes.'
                  });
                  return; // Don't broadcast normal file-changed
                }
              } catch (e) {
                console.warn(`[ReadOnly ${ts()}] Revert failed:`, e.message);
              }
            }
          }

          const parts = filename.split(path.sep);
          if (parts.length === 1) {
            const fileId = 'file:' + parts[0];
            broadcastSSE('file-changed', { docId: fileId, file: parts[0], eventType });
          } else {
            const docId = parts[0];
            const file = parts[parts.length - 1];
            broadcastSSE('file-changed', { docId, file, eventType });
          }
        }
        broadcastSSE('list-changed', { eventType, filename });
      }, 500);
    });

    activeWatcher.on('error', (err) => {
      console.warn('File watcher error:', err.message);
    });

    console.log(`✓ File watcher active on: ${logPath(dir)}`);
  } catch (err) {
    console.warn('Failed to setup file watcher:', err.message);
  }
}

// Ensure directories exist
if (!fs.existsSync(getDocsDir())) {
  fs.mkdirSync(getDocsDir(), { recursive: true });
}
if (!fs.existsSync(CHAT_PATH)) {
  fs.writeFileSync(CHAT_PATH, JSON.stringify([], null, 2));
}

// --- Document helpers ---
// Documents can be:
//   - "subfolder" type: id = folder name, content in folder/draft.md, versions in folder/versions/
//   - "file" type: id = "file:filename.md", content is the .md file directly, no versions

function isFileId(id) {
  return id.startsWith('file:');
}

function getDocPath(id) {
  const dir = getDocsDir();
  if (isFileId(id)) {
    return path.join(dir, id.slice(5)); // strip "file:" prefix
  }
  return path.join(dir, id, 'draft.md');
}

function getVersionsDir(id) {
  if (isFileId(id)) return null; // loose files don't have versions
  return path.join(getDocsDir(), id, 'versions');
}

function createVersionSnapshot(id, content) {
  const versionsDir = getVersionsDir(id);
  if (!versionsDir) return null;

  if (!fs.existsSync(versionsDir)) {
    fs.mkdirSync(versionsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
  const versionPath = path.join(versionsDir, `${timestamp}.md`);
  fs.writeFileSync(versionPath, content, 'utf-8');
  return timestamp;
}

function extractTitle(content) {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : 'Untitled';
}

// Version cleanup: delete versions older than 30 days, keep minimum 10
function cleanupVersions(id) {
  const versionsDir = getVersionsDir(id);
  if (!versionsDir || !fs.existsSync(versionsDir)) return { deleted: 0, remaining: 0 };

  const files = fs.readdirSync(versionsDir)
    .filter(f => f.endsWith('.md'))
    .sort((a, b) => b.localeCompare(a)); // newest first

  const MIN_KEEP = 10;
  const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const now = Date.now();
  let deleted = 0;

  files.forEach((filename, index) => {
    if (index < MIN_KEEP) return; // always keep newest 10

    const filePath = path.join(versionsDir, filename);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > MAX_AGE_MS) {
        fs.unlinkSync(filePath);
        deleted++;
      }
    } catch {}
  });

  return { deleted, remaining: files.length - deleted };
}

// API routes
function registerApi(router) {
  // --- Settings ---
  const AI_SETTING_KEYS = [
    'ai_kiro_command',
    'ai_system_prompt', 'ai_include_context', 'ai_max_history',
  ];

  router.get('/settings', (req, res) => {
    const result = {
      docsDir: settings.docsDir || path.join(__dirname, 'documents'),
      resolvedDir: getDocsDir(),
    };
    // Include all ai_* settings
    for (const key of AI_SETTING_KEYS) {
      if (settings[key] !== undefined) result[key] = settings[key];
    }
    res.json(result);
  });

  router.post('/settings', async (req, res) => {
    try {
      const body = req.body;

      // Handle docsDir
      if (body.docsDir !== undefined) {
        const docsDir = body.docsDir;
        if (!docsDir) return res.status(400).json({ error: 'docsDir cannot be empty' });
        const resolved = path.isAbsolute(docsDir)
          ? docsDir
          : path.resolve(__dirname, docsDir);
        if (!fs.existsSync(resolved)) {
          fs.mkdirSync(resolved, { recursive: true });
        }
        settings.docsDir = docsDir;
      }

      // Handle ai_* settings (allowlist)
      for (const key of AI_SETTING_KEYS) {
        if (body[key] !== undefined) {
          settings[key] = body[key];
        }
      }

      saveSettings(settings);

      if (body.docsDir !== undefined) {
        setupFileWatcher();
        // Reset ACP session so it picks up the new cwd
        try {
          const backend = await getBackend(settings);
          if (backend.resetSession) await backend.resetSession();
        } catch { /* backend may not be initialized yet */ }
      }

      res.json({
        success: true,
        docsDir: settings.docsDir,
        resolvedDir: getDocsDir(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- File/folder picker (macOS native dialog via osascript + JXA) ---
  router.post('/pick-folder', (req, res) => {
    // Only attempt native picker on macOS
    if (process.platform !== 'darwin') {
      return res.json({ unsupported: true });
    }

    const defaultPath = getDocsDir().replace(/'/g, "\\'");
    const script = `
      ObjC.import('Cocoa');
      var app = $.NSApplication.sharedApplication;
      app.setActivationPolicy($.NSApplicationActivationPolicyRegular);
      app.activateIgnoringOtherApps(true);
      var panel = $.NSOpenPanel.openPanel;
      panel.setCanChooseFiles(true);
      panel.setCanChooseDirectories(true);
      panel.setAllowsMultipleSelection(false);
      panel.setAllowedFileTypes($(['md', 'markdown']));
      panel.setMessage($('Select a documents folder or markdown file'));
      panel.setPrompt($('Open'));
      panel.setDirectoryURL($.NSURL.fileURLWithPath($('${defaultPath}')));
      var result = panel.runModal;
      if (result === $.NSModalResponseOK) {
        ObjC.unwrap(panel.URL.path);
      } else {
        'CANCELLED';
      }`;
    execFile('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 120000 }, (err, stdout) => {
      if (err) {
        // If osascript fails (e.g. no GUI session on remote), signal unsupported
        if (err.killed || err.signal || err.code === 127 || /execution error|not allowed/i.test(err.message)) {
          return res.json({ unsupported: true });
        }
        return res.json({ cancelled: true });
      }
      const picked = stdout.trim();
      if (picked === 'CANCELLED') {
        return res.json({ cancelled: true });
      }
      try {
        const stat = fs.statSync(picked);
        if (stat.isFile()) {
          const parentDir = path.dirname(picked);
          const filename = path.basename(picked);
          res.json({ path: parentDir, isFile: true, filename });
        } else {
          res.json({ path: picked, isFile: false });
        }
      } catch (e) {
        res.json({ cancelled: true, error: e.message });
      }
    });
  });

  // --- Server-side directory browser (remote-compatible fallback) ---
  router.post('/browse-dir', (req, res) => {
    try {
      const requestedPath = req.body.path || getDocsDir() || process.env.HOME || '/';
      const resolved = path.resolve(requestedPath);

      if (!fs.existsSync(resolved)) {
        return res.status(400).json({ error: 'Path does not exist' });
      }

      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: 'Path is not a directory' });
      }

      const parentDir = path.dirname(resolved);
      const rawEntries = fs.readdirSync(resolved, { withFileTypes: true });

      const entries = [];
      for (const entry of rawEntries) {
        // Skip hidden files/directories
        if (entry.name.startsWith('.')) continue;

        if (entry.isDirectory()) {
          entries.push({ name: entry.name, type: 'dir' });
        } else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) {
          entries.push({ name: entry.name, type: 'file' });
        }
      }

      // Sort: directories first, then files, alphabetically within each group
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      res.json({
        current: resolved,
        parent: resolved !== parentDir ? parentDir : null,
        entries,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- SSE endpoint ---
  router.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('event: connected\ndata: {}\n\n');
    sseClients.push(res);
    req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
  });

  // --- List all documents (subfolders + loose .md files) ---
  router.get('/documents', (req, res) => {
    try {
      const dir = getDocsDir();
      if (!fs.existsSync(dir)) return res.json({ documents: [] });

      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const documents = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Subfolder project — must have draft.md
          const draftPath = path.join(dir, entry.name, 'draft.md');
          const content = fs.existsSync(draftPath) ? fs.readFileSync(draftPath, 'utf-8') : '';
          if (!fs.existsSync(draftPath)) continue; // skip folders without draft.md (e.g. random folders)

          const title = extractTitle(content);
          const match = entry.name.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
          const date = match ? match[1] : 'unknown';
          const slug = match ? match[2] : entry.name;

          const vDir = path.join(dir, entry.name, 'versions');
          const versionCount = fs.existsSync(vDir)
            ? fs.readdirSync(vDir).filter(f => f.endsWith('.md')).length
            : 0;

          documents.push({
            id: entry.name,
            title,
            date,
            slug,
            versionCount,
            type: 'project', // has versions
          });
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          // Loose .md file
          const filePath = path.join(dir, entry.name);
          const content = fs.readFileSync(filePath, 'utf-8');
          const title = extractTitle(content);
          const stat = fs.statSync(filePath);
          const date = stat.mtime.toISOString().split('T')[0];

          documents.push({
            id: 'file:' + entry.name,
            title,
            date,
            slug: entry.name.replace(/\.md$/, ''),
            versionCount: 0,
            type: 'file', // no versions
            filename: entry.name,
          });
        }
      }

      // Sort: projects first (by date desc), then files (by date desc)
      documents.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'project' ? -1 : 1;
        return b.date.localeCompare(a.date);
      });

      res.json({ documents: documents });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Get document content ---
  router.get('/documents/:id', (req, res) => {
    try {
      const id = decodeURIComponent(req.params.id);
      const docPath = getDocPath(id);

      const content = fs.existsSync(docPath)
        ? fs.readFileSync(docPath, 'utf-8')
        : '# Untitled\n\nStart writing here...';

      lastKnownContent.set(id, content);
      res.json({ content, type: isFileId(id) ? 'file' : 'project' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Save document content ---
  router.post('/documents/:id', (req, res) => {
    try {
      const id = decodeURIComponent(req.params.id);
      const { content } = req.body;

      if (isFileId(id)) {
        // Loose file — just write directly, no versions
        const filePath = getDocPath(id);
        markOwnWrite(filePath);
        fs.writeFileSync(filePath, content, 'utf-8');
        lastKnownContent.set(id, content);
        res.json({ success: true, timestamp: new Date().toISOString() });
      } else {
        // Subfolder project — write + version snapshot
        const docDir = path.join(getDocsDir(), id);
        if (!fs.existsSync(docDir)) {
          fs.mkdirSync(docDir, { recursive: true });
        }

        const docPath = getDocPath(id);
        markOwnWrite(docPath);
        fs.writeFileSync(docPath, content, 'utf-8');
        lastKnownContent.set(id, content);
        const versionTimestamp = createVersionSnapshot(id, content);

        res.json({ success: true, timestamp: new Date().toISOString(), versionTimestamp });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Create new document (simple .md file) ---
  router.post('/documents', (req, res) => {
    try {
      const { slug } = req.body;
      const filename = (slug || 'untitled') + '.md';
      const filePath = path.join(getDocsDir(), filename);

      if (fs.existsSync(filePath)) {
        return res.status(400).json({ error: 'A file with that name already exists' });
      }

      // Derive a readable title from the slug
      const title = (slug || 'Untitled').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

      fs.writeFileSync(filePath, `# ${title}\n\nStart writing here...`, 'utf-8');
      broadcastSSE('list-changed', {});

      res.json({ id: 'file:' + filename });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Rename document ---
  router.post('/documents/:id/rename', (req, res) => {
    try {
      const id = decodeURIComponent(req.params.id);
      const { newName } = req.body;
      if (!newName || !newName.trim()) {
        return res.status(400).json({ error: 'Name is required' });
      }

      const dir = getDocsDir();
      const slug = newName.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      if (!slug) {
        return res.status(400).json({ error: 'Invalid name' });
      }

      if (isFileId(id)) {
        // File type: rename the .md file
        const oldFilename = id.slice(5); // strip "file:"
        const newFilename = slug + '.md';
        if (oldFilename === newFilename) {
          return res.json({ newId: id });
        }
        const oldPath = path.join(dir, oldFilename);
        const newPath = path.join(dir, newFilename);
        if (fs.existsSync(newPath)) {
          return res.status(400).json({ error: 'A file with that name already exists' });
        }
        fs.renameSync(oldPath, newPath);
        // Update tracking caches
        const oldContent = lastKnownContent.get(id);
        if (oldContent !== undefined) {
          lastKnownContent.delete(id);
          lastKnownContent.set('file:' + newFilename, oldContent);
        }
        broadcastSSE('list-changed', {});
        res.json({ newId: 'file:' + newFilename });
      } else {
        // Project type: rename the folder, keeping the date prefix
        const match = id.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
        const datePrefix = match ? match[1] : '';
        const newFolderId = datePrefix ? `${datePrefix}-${slug}` : slug;
        if (id === newFolderId) {
          return res.json({ newId: id });
        }
        const oldDir = path.join(dir, id);
        const newDir = path.join(dir, newFolderId);
        if (fs.existsSync(newDir)) {
          return res.status(400).json({ error: 'A document with that name already exists' });
        }
        fs.renameSync(oldDir, newDir);
        // Update tracking caches
        const oldContent = lastKnownContent.get(id);
        if (oldContent !== undefined) {
          lastKnownContent.delete(id);
          lastKnownContent.set(newFolderId, oldContent);
        }
        broadcastSSE('list-changed', {});
        res.json({ newId: newFolderId });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Version history ---
  router.get('/documents/:id/versions', (req, res) => {
    try {
      const id = decodeURIComponent(req.params.id);
      const versionsDir = getVersionsDir(id);

      if (!versionsDir || !fs.existsSync(versionsDir)) {
        return res.json({ versions: [] });
      }

      const versions = fs.readdirSync(versionsDir)
        .filter(f => f.endsWith('.md'))
        .map(filename => {
          const timestamp = filename.replace('.md', '');
          const filePath = path.join(versionsDir, filename);
          const content = fs.readFileSync(filePath, 'utf-8');
          return { timestamp, filename, preview: content.substring(0, 200) };
        })
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

      res.json({ versions });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get version content
  router.get('/documents/:id/versions/:timestamp', (req, res) => {
    try {
      const id = decodeURIComponent(req.params.id);
      const versionsDir = getVersionsDir(id);
      if (!versionsDir) return res.status(404).json({ error: 'No versions for this file type' });

      const versionPath = path.join(versionsDir, `${req.params.timestamp}.md`);
      if (!fs.existsSync(versionPath)) return res.status(404).json({ error: 'Version not found' });

      const content = fs.readFileSync(versionPath, 'utf-8');
      res.json({ content });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Restore version
  router.post('/documents/:id/restore/:timestamp', (req, res) => {
    try {
      const id = decodeURIComponent(req.params.id);
      const versionsDir = getVersionsDir(id);
      if (!versionsDir) return res.status(400).json({ error: 'No versions for this file type' });

      const versionPath = path.join(versionsDir, `${req.params.timestamp}.md`);
      if (!fs.existsSync(versionPath)) return res.status(404).json({ error: 'Version not found' });

      const content = fs.readFileSync(versionPath, 'utf-8');
      const docPath = getDocPath(id);

      // Snapshot current before restoring
      const currentContent = fs.readFileSync(docPath, 'utf-8');
      createVersionSnapshot(id, currentContent);

      markOwnWrite(docPath);
      fs.writeFileSync(docPath, content, 'utf-8');
      lastKnownContent.set(id, content);
      res.json({ success: true, timestamp: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Version cleanup ---
  router.post('/documents/:id/cleanup', (req, res) => {
    try {
      const id = decodeURIComponent(req.params.id);
      if (isFileId(id)) return res.json({ deleted: 0, remaining: 0, message: 'No versions for loose files' });

      const result = cleanupVersions(id);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Cleanup all document versions
  router.post('/cleanup-versions', (req, res) => {
    try {
      const dir = getDocsDir();
      if (!fs.existsSync(dir)) return res.json({ totalDeleted: 0 });

      let totalDeleted = 0;
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const result = cleanupVersions(entry.name);
          totalDeleted += result.deleted;
        }
      }

      res.json({ totalDeleted });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Export to HTML
  router.get('/export-html', (req, res) => {
    try {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'Document id required' });

      const docPath = getDocPath(id);
      const content = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf-8') : '';
      res.json({ markdown: content });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- AI Chat ---
  router.post('/ai/test', async (req, res) => {
    try {
      console.log(`[AI Test ${ts()}] backend=kiro`);
      const backend = await getBackend(settings);
      const start = Date.now();
      const result = await backend.testConnection();
      const latency = Date.now() - start;
      console.log(`[AI Test ${ts()}] ${result.ok ? '✓' : '✗'} ${result.ok ? result.model : result.error} (${latency}ms)`);
      res.json({ ...result, latency_ms: latency });
    } catch (err) {
      console.error(`[AI Test ${ts()}] ✗ exception: ${err.message}`);
      res.json({ ok: false, error: err.message });
    }
  });

  router.post('/ai/cancel', async (req, res) => {
    try {
      const backend = await getBackend(settings);
      if (backend.cancel) {
        await backend.cancel();
        console.log(`[AI Cancel ${ts()}] ✓ cancel sent`);
      }
      res.json({ ok: true });
    } catch (err) {
      console.error(`[AI Cancel ${ts()}] ✗ ${err.message}`);
      res.json({ ok: false, error: err.message });
    }
  });

  router.post('/ai/reset', async (req, res) => {
    try {
      const backend = await getBackend(settings);
      if (backend.resetSession) {
        await backend.resetSession();
        console.log(`[AI Reset ${ts()}] ✓ session reset`);
        res.json({ ok: true });
      } else {
        res.json({ ok: true, note: 'Backend does not support session reset' });
      }
    } catch (err) {
      console.error(`[AI Reset ${ts()}] ✗ ${err.message}`);
      res.json({ ok: false, error: err.message });
    }
  });

  // --- AI Model selection ---
  router.get('/ai/models', async (req, res) => {
    try {
      const backend = await getBackend(settings);
      if (backend.getModels) {
        const models = backend.getModels();
        if (models) {
          return res.json(models);
        }
        // No session yet — trigger one so models get cached
        await backend._ensureSession();
        const fresh = backend.getModels();
        return res.json(fresh || { currentModelId: null, availableModels: [] });
      }
      res.json({ currentModelId: null, availableModels: [] });
    } catch (err) {
      console.error(`[AI Models ${ts()}] ✗ ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/ai/model', async (req, res) => {
    try {
      const { modelId } = req.body;
      if (!modelId) return res.status(400).json({ error: 'modelId is required' });

      const backend = await getBackend(settings);
      if (!backend.setModel) {
        return res.status(400).json({ error: 'Backend does not support model switching' });
      }
      await backend.setModel(modelId);
      res.json({ ok: true, modelId });
    } catch (err) {
      console.error(`[AI Model ${ts()}] ✗ ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // --- AI Mode selection ---
  router.get('/ai/modes', async (req, res) => {
    try {
      const backend = await getBackend(settings);
      if (backend.getModes) {
        const modes = backend.getModes();
        if (modes) {
          return res.json(modes);
        }
        // No session yet — trigger one so modes get cached
        await backend._ensureSession();
        const fresh = backend.getModes();
        return res.json(fresh || { currentModeId: null, availableModes: [] });
      }
      res.json({ currentModeId: null, availableModes: [] });
    } catch (err) {
      console.error(`[AI Modes ${ts()}] ✗ ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/ai/mode', async (req, res) => {
    try {
      const { modeId } = req.body;
      if (!modeId) return res.status(400).json({ error: 'modeId is required' });

      const backend = await getBackend(settings);
      if (!backend.setMode) {
        return res.status(400).json({ error: 'Backend does not support mode switching' });
      }
      await backend.setMode(modeId);
      res.json({ ok: true, modeId });
    } catch (err) {
      console.error(`[AI Mode ${ts()}] ✗ ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // --- Slash commands ---
  router.get('/ai/commands', async (req, res) => {
    try {
      const backend = await getBackend(settings);
      const commands = backend.getCommands ? await backend.getCommands() : [];
      res.json({ commands });
    } catch (err) {
      console.error(`[AI Commands ${ts()}] ✗ ${err.message}`);
      res.json({ commands: [] });
    }
  });

  router.post('/ai/commands/execute', async (req, res) => {
    try {
      const { command } = req.body;
      if (!command) return res.status(400).json({ error: 'command is required' });

      const backend = await getBackend(settings);
      if (!backend.executeCommand) {
        return res.status(400).json({ error: 'Backend does not support commands' });
      }
      const result = await backend.executeCommand(command);
      res.json({ ok: true, result });
    } catch (err) {
      console.error(`[AI Command ${ts()}] ✗ ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // --- Context usage ---
  router.get('/ai/context-usage', async (req, res) => {
    try {
      const backend = await getBackend(settings);
      const usage = backend.getContextUsage ? backend.getContextUsage() : null;
      const compacting = backend.isCompacting ? backend.isCompacting() : false;
      res.json({ usage, compacting });
    } catch (err) {
      res.json({ usage: null, compacting: false });
    }
  });

  // --- Edit mode control ---
  router.post('/edit-mode', async (req, res) => {
    const { enabled } = req.body;
    editModeEnabled = !!enabled;
    console.log(`[EditMode ${ts()}] ${editModeEnabled ? 'ENABLED' : 'DISABLED (read-only)'}`);
    // Sync to ACP backend so it can auto-approve/reject tool permission requests
    try {
      const backend = await getBackend(settings);
      if (backend.editModeEnabled !== undefined) {
        backend.editModeEnabled = editModeEnabled;
      }
      // Also switch ACP mode so Kiro changes its behavior at the source
      if (backend.setMode && backend.getModes) {
        const modes = backend.getModes();
        if (modes && modes.availableModes && modes.availableModes.length > 0) {
          const targetMode = editModeEnabled
            ? modes.availableModes.find(m => /agent/i.test(m.id) || /agent/i.test(m.name))
            : modes.availableModes.find(m => /chat/i.test(m.id) || /chat/i.test(m.name));
          if (targetMode) {
            try {
              await backend.setMode(targetMode.id);
              console.log(`[EditMode ${ts()}] Switched ACP mode to: ${targetMode.id}`);
            } catch (modeErr) {
              console.warn(`[EditMode ${ts()}] Failed to switch ACP mode: ${modeErr.message}`);
            }
          }
        }
      }
    } catch {}
    res.json({ editMode: editModeEnabled });
  });

  router.get('/edit-mode', (req, res) => {
    res.json({ editMode: editModeEnabled });
  });

  router.post('/ai/chat', async (req, res) => {
    const { message, history = [], context, images = [], files = [] } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    console.log(`[AI Chat ${ts()}] backend=kiro message="${message.substring(0, 80)}"`);

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    try {
      const backend = await getBackend(settings);
      console.log(`[AI Chat ${ts()}] backend instance: ${backend.getDisplayName()}`);

      // Build system prompt — appended as additional context, not replacing Kiro's own config
      let systemPrompt = settings.ai_system_prompt || '';
      let documentResource = null;
      if (context && settings.ai_include_context !== 'false') {
        const contextParts = [];
        contextParts.push('You are operating inside GhostWriter, a markdown document editor. The user has a .md file open and is working on it right now.');

        // Document resource — sent as a separate ACP resource content block, not in system prompt text
        if (context.documentTitle) {
          const docId = context.documentId || context.documentTitle;
          const filePath = getDocPath(docId);
          contextParts.push(`\nActive document: "${context.documentTitle}"`);
          contextParts.push(`File path: ${filePath}`);

          // Include version history path for project-type docs
          const versionsDir = getVersionsDir(docId);
          if (versionsDir) {
            contextParts.push(`Version history directory: ${versionsDir}`);
          }

          // Document content — sent both as ACP resource block (typed file) and as
          // text in the system prompt (fallback if agent ignores resource blocks).
          // Budget: 100K chars ≈ 25K tokens — fits comfortably in all supported models.
          const MAX_DOC_CHARS = 100_000;
          const docContent = context.documentContent || '';
          if (docContent) {
            const truncated = docContent.length > MAX_DOC_CHARS;
            const includedContent = truncated ? docContent.slice(0, MAX_DOC_CHARS) : docContent;

            // ACP resource block — Kiro sees this as a typed file with URI
            documentResource = {
              uri: `file://${filePath}`,
              content: includedContent,
              mimeType: 'text/markdown',
            };

            // Text fallback — included in system prompt for agents that don't support resource blocks
            if (truncated) {
              contextParts.push(`\nDocument content (first ${MAX_DOC_CHARS.toLocaleString()} of ${docContent.length.toLocaleString()} chars — read the full file from disk if needed):\n${includedContent}`);
            } else {
              contextParts.push(`\nCurrent document content:\n${includedContent}`);
            }
          }
        }

        // Edit mode instructions
        if (context.editMode) {
          contextParts.push('\n--- AI EDIT MODE ENABLED ---');
          contextParts.push('You MUST write your changes directly to the file path above. Do not just show content in chat — use your file write tool to update the document.');
          contextParts.push('When the user asks you to write, draft, rewrite, or create content, write it into the document file.');
          contextParts.push('The editor has automatic version history, so all changes can be rolled back safely.');
          contextParts.push('After writing, briefly explain what you changed in your chat reply.');
        } else {
          contextParts.push('\n--- READ-ONLY MODE ---');
          contextParts.push('Do not modify the document file. Only suggest changes in your response text.');
          contextParts.push('When suggesting changes, show the content as plain text, not wrapped in code blocks (unless the content itself is code).');
          contextParts.push('If the user asks you to make edits, let them know they can switch to AI Edit mode using the toggle at the bottom of the chat panel, and you will apply the changes directly to the file.');
        }
        if (contextParts.length > 0) {
          systemPrompt = (systemPrompt ? systemPrompt + '\n\n' : '') +
            contextParts.join('\n');
        }
      }

      // Build messages array with history
      const maxHistory = parseInt(settings.ai_max_history || '20', 10);
      const messages = [...history.slice(-maxHistory), { role: 'user', content: message }];

      // Stream (pass image attachments, document resource, and file attachments)
      let chunkCount = 0;
      for await (const chunk of backend.chatStream(messages, systemPrompt || undefined, images.length > 0 ? images : undefined, documentResource, files.length > 0 ? files : undefined)) {
        chunkCount++;
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        if (chunk.type === 'done') {
          console.log(`[AI Chat ${ts()}] ✓ done (${chunkCount} chunks)`);
          break;
        }
        if (chunk.type === 'error') {
          console.error(`[AI Chat ${ts()}] ✗ error from backend: ${chunk.text}`);
          break;
        }
      }
      if (chunkCount === 0) {
        console.warn(`[AI Chat ${ts()}] ✗ backend yielded zero chunks`);
        res.write(`data: ${JSON.stringify({ type: 'error', text: 'Backend returned no response. Check settings and try again.' })}\n\n`);
      }
    } catch (err) {
      console.error(`[AI Chat ${ts()}] ✗ exception: ${err.message}`);
      res.write(`data: ${JSON.stringify({ type: 'error', text: err.message })}\n\n`);
    }

    res.end();
  });

  // --- Legacy Chat (kept for backward compat) ---
  router.get('/chat', (req, res) => {
    try {
      const messages = JSON.parse(fs.readFileSync(CHAT_PATH, 'utf-8'));
      res.json({ messages, connected: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/chat/status', (req, res) => {
    try {
      const messages = JSON.parse(fs.readFileSync(CHAT_PATH, 'utf-8'));
      let lastUserMsgTime = 0, lastAssistantMsgTime = 0;
      for (const msg of messages) {
        const t = new Date(msg.timestamp).getTime();
        if (msg.sender?.toLowerCase() === 'assistant') lastAssistantMsgTime = Math.max(lastAssistantMsgTime, t);
        else lastUserMsgTime = Math.max(lastUserMsgTime, t);
      }
      const thinking = lastUserMsgTime > lastAssistantMsgTime && (Date.now() - lastUserMsgTime) < 5 * 60 * 1000;
      res.json({ thinking });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/chat', (req, res) => {
    try {
      const { sender, text } = req.body;
      const messages = JSON.parse(fs.readFileSync(CHAT_PATH, 'utf-8'));
      const newMessage = { id: Date.now().toString(), sender: sender || 'User', text, timestamp: new Date().toISOString() };
      messages.push(newMessage);
      fs.writeFileSync(CHAT_PATH, JSON.stringify(messages, null, 2));
      res.json({ message: newMessage });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

// Mount API at both paths
app.use('/api', registerApi(express.Router()));
app.use('/editor/api', registerApi(express.Router()));

// Serve static files
const distPath = path.join(__dirname, 'dist');
app.use('/', express.static(distPath));
app.use('/editor', express.static(distPath));

app.get(/^\/editor\/.*/, (req, res) => {
  const indexPath = path.join(distPath, 'index.html');
  if (fs.existsSync(indexPath)) res.sendFile(indexPath);
  else res.status(404).send('Run: npm run build');
});

app.get(/^\/(?!api|editor).*/, (req, res) => {
  const indexPath = path.join(distPath, 'index.html');
  if (fs.existsSync(indexPath)) res.sendFile(indexPath);
  else res.status(404).send('Run: npm run build');
});

const server = app.listen(PORT, () => {
  console.log(`GhostWriter running at http://localhost:${PORT}`);
  console.log(`Documents directory: ${logPath(getDocsDir())}`);
  setupFileWatcher();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use.`);
  else console.error('Server error:', err);
  process.exit(1);
});
// Graceful shutdown — dispose AI backend (important for ACP child process)
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    console.log(`\n${sig} received — shutting down...`);
    await disposeBackend();
    process.exit(0);
  });
}

process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err); process.exit(1); });
process.on('unhandledRejection', (err) => { console.error('Unhandled rejection:', err); process.exit(1); });
