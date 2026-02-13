import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getBackend, createBackend, disposeBackend } from './lib/ai-backends/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
          const parts = filename.split(path.sep);
          // Could be a loose file (parts.length===1) or subfolder file
          if (parts.length === 1) {
            // Loose .md file changed
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

    console.log(`✓ File watcher active on: ${dir}`);
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

  router.post('/settings', (req, res) => {
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
        fs.writeFileSync(filePath, content, 'utf-8');
        res.json({ success: true, timestamp: new Date().toISOString() });
      } else {
        // Subfolder project — write + version snapshot
        const docDir = path.join(getDocsDir(), id);
        if (!fs.existsSync(docDir)) {
          fs.mkdirSync(docDir, { recursive: true });
        }

        const docPath = getDocPath(id);
        fs.writeFileSync(docPath, content, 'utf-8');
        const versionTimestamp = createVersionSnapshot(id, content);

        res.json({ success: true, timestamp: new Date().toISOString(), versionTimestamp });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Create new document (subfolder type) ---
  router.post('/documents', (req, res) => {
    try {
      const { slug } = req.body;
      const date = new Date().toISOString().split('T')[0];
      const docId = `${date}-${slug || 'untitled'}`;
      const docDir = path.join(getDocsDir(), docId);

      if (fs.existsSync(docDir)) {
        return res.status(400).json({ error: 'Document already exists' });
      }

      // Derive a readable title from the slug
      const title = (slug || 'Untitled').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

      fs.mkdirSync(docDir, { recursive: true });
      fs.mkdirSync(path.join(docDir, 'versions'), { recursive: true });
      fs.writeFileSync(
        path.join(docDir, 'draft.md'),
        `# ${title}\n\nStart writing here...`,
        'utf-8'
      );

      res.json({ id: docId });
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

      fs.writeFileSync(docPath, content, 'utf-8');
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
      const testSettings = { ...settings, ...req.body };
      console.log('[AI Test] backend=kiro');
      const backend = createBackend(testSettings);
      try {
        const start = Date.now();
        const result = await backend.testConnection();
        const latency = Date.now() - start;
        console.log(`[AI Test] ${result.ok ? '✓' : '✗'} ${result.ok ? result.model : result.error} (${latency}ms)`);
        res.json({ ...result, latency_ms: latency });
      } finally {
        await backend.dispose();
      }
    } catch (err) {
      console.error(`[AI Test] ✗ exception: ${err.message}`);
      res.json({ ok: false, error: err.message });
    }
  });

  router.post('/ai/reset', async (req, res) => {
    try {
      const backend = await getBackend(settings);
      if (backend.resetSession) {
        await backend.resetSession();
        console.log('[AI Reset] ✓ session reset');
        res.json({ ok: true });
      } else {
        res.json({ ok: true, note: 'Backend does not support session reset' });
      }
    } catch (err) {
      console.error(`[AI Reset] ✗ ${err.message}`);
      res.json({ ok: false, error: err.message });
    }
  });

  router.post('/ai/chat', async (req, res) => {
    const { message, history = [], context } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    console.log(`[AI Chat] backend=kiro message="${message.substring(0, 80)}"`);

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    try {
      const backend = await getBackend(settings);
      console.log(`[AI Chat] backend instance: ${backend.getDisplayName()}`);

      // Build system prompt
      let systemPrompt = settings.ai_system_prompt || '';
      if (context && settings.ai_include_context !== 'false') {
        const contextParts = [];
        if (context.page) contextParts.push(`User is on the "${context.page}" page.`);
        if (context.documentTitle) contextParts.push(`Currently editing: "${context.documentTitle}"`);
        if (context.documentExcerpt) contextParts.push(`Document excerpt:\n${context.documentExcerpt}`);
        if (contextParts.length > 0) {
          systemPrompt = (systemPrompt ? systemPrompt + '\n\n' : '') +
            'Context:\n' + contextParts.join('\n');
        }
      }

      // Build messages array with history
      const maxHistory = parseInt(settings.ai_max_history || '20', 10);
      const messages = [...history.slice(-maxHistory), { role: 'user', content: message }];

      // Stream
      let chunkCount = 0;
      for await (const chunk of backend.chatStream(messages, systemPrompt || undefined)) {
        chunkCount++;
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        if (chunk.type === 'done') {
          console.log(`[AI Chat] ✓ done (${chunkCount} chunks)`);
          break;
        }
        if (chunk.type === 'error') {
          console.error(`[AI Chat] ✗ error from backend: ${chunk.text}`);
          break;
        }
      }
      if (chunkCount === 0) {
        console.warn('[AI Chat] ✗ backend yielded zero chunks');
        res.write(`data: ${JSON.stringify({ type: 'error', text: 'Backend returned no response. Check settings and try again.' })}\n\n`);
      }
    } catch (err) {
      console.error(`[AI Chat] ✗ exception: ${err.message}`);
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
  console.log(`Documents directory: ${getDocsDir()}`);
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
