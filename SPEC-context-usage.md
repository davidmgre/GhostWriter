# Spec: Real-Time Context Usage

**Status:** Ready for implementation
**Priority:** Medium
**Files:** `lib/ai-backends/acp.js`, `server.mjs`, `src/components/ChatPanel.jsx`

## Background

GhostWriter captures context usage from two sources (`turn_end` notification and
`session/prompt` response), but only at the **end** of a turn. The Kiro ACP
protocol also emits `kiro.dev/metadata` notifications **during** a turn with
live `contextUsagePercentage`. We don't subscribe to these, so the context bar
stays stale while the AI is streaming.

Additionally, we poll `/api/ai/context-usage` every 30 seconds on a timer, which
is wasteful — the data arrives inline via SSE when we subscribe to the right
notification.

Reference implementation: `/Users/greendm/Documents/code/PdebieDesktopAgentDemo`
(Tauri app that subscribes to `kiro.dev/metadata` and uses event-driven fetching).

---

## Task 1: Subscribe to `kiro.dev/metadata` in ACP backend

**File:** `lib/ai-backends/acp.js`
**Lines:** ~657 (notification handler inside `chatStream`)

Add a handler for `kiro.dev/metadata` alongside the existing
`_kiro.dev/compaction/status` handler. Extract `contextUsagePercentage` and
update `_contextUsage` + enqueue a `context_usage` event to the SSE stream.

```javascript
// After the existing _kiro.dev/compaction/status handler:
if (msg.method === 'kiro.dev/metadata') {
  const pct = msg.params?.contextUsagePercentage;
  if (pct != null) {
    this._contextUsage = { percentage: pct };
    enqueue({ type: 'context_usage', percentage: pct });
  }
}
```

**Also:** Update `_contextUsage` storage outside of `chatStream` — add a
persistent notification listener in `_initialize()` so context usage updates
even when no prompt is active (e.g., during compaction or background processing).

**Acceptance criteria:**
- `kiro.dev/metadata` notifications update `_contextUsage` in real time
- `context_usage` events are emitted to the SSE stream during active prompts
- `getContextUsage()` returns fresh data even between prompts
- Existing `turn_end` and `session/prompt` capture still works as fallback

---

## Task 2: Remove 30-second polling interval

**File:** `src/components/ChatPanel.jsx`
**Lines:** ~237 (the `setInterval(fetchContextUsage, 30000)` block)

With Task 1 providing inline SSE events, the 30s polling is redundant. Remove
the interval and keep only:
1. Initial fetch on connection (already exists)
2. SSE `context_usage` events during streaming (already handled at line ~382)
3. Post-turn fetch (already exists at line ~439) as a safety net

```diff
- const interval = setInterval(fetchContextUsage, 30000);
- ...
- return () => clearInterval(interval);
+ // Context usage now arrives inline via SSE from kiro.dev/metadata.
+ // Initial fetch on mount + post-turn fetch provide fallback.
```

**Acceptance criteria:**
- No more 30-second polling
- Context bar still updates on connection, during streaming, and after turns
- Network tab shows no periodic `/ai/context-usage` requests

---

## Task 3: Extract ContextUsageBar component

**File:** New: `src/components/ContextUsageBar.jsx`
**File:** `src/components/ChatPanel.jsx` (lines ~722-742)

Extract the inline progress bar into a dedicated component. ChatPanel is 1000+
lines; this is a small step toward decomposition.

```jsx
// src/components/ContextUsageBar.jsx
export default function ContextUsageBar({ percentage }) {
  if (percentage == null) return null;

  const clamped = Math.min(100, Math.max(0, percentage));
  const rounded = Math.round(clamped);
  const color =
    clamped >= 80 ? 'bg-red-500' :
    clamped >= 50 ? 'bg-yellow-500' :
    'bg-emerald-500';

  return (
    <div className="px-4 py-1 border-b border-[#262626] flex items-center gap-2"
         title={`Context window ${rounded}% used`}>
      <span className="text-[10px] text-neutral-500 shrink-0">ctx</span>
      <div className="flex-1 h-1.5 bg-[#1a1a1a] rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="text-[10px] text-neutral-500 tabular-nums">{rounded}%</span>
    </div>
  );
}
```

Then in ChatPanel, replace the inline block with:
```jsx
<ContextUsageBar percentage={contextUsage?.percentage} />
```

**Acceptance criteria:**
- Visual output is identical to current implementation
- Color thresholds match demo app: green <50%, yellow 50-79%, red 80%+
- `transition-all duration-500` for smooth bar animation on updates
- Tooltip shows "Context window X% used"
- Component returns null when percentage is null (no empty bar)

---

## Task 4: Add context usage test coverage

**File:** `tests/acp-backend.test.js`

Add tests for the new `kiro.dev/metadata` handler:

1. **Captures context usage from metadata notification** — simulate a
   `kiro.dev/metadata` notification with `contextUsagePercentage: 42.5`,
   verify `getContextUsage()` returns `{ percentage: 42.5 }`
2. **Emits context_usage event during streaming** — simulate metadata
   notification during an active `chatStream`, verify a `context_usage`
   chunk is yielded with the correct percentage
3. **Metadata updates don't overwrite richer turn_end data** — if `turn_end`
   provides additional fields beyond percentage, verify they're preserved

**Acceptance criteria:**
- All existing 24 tests still pass
- New tests cover the `kiro.dev/metadata` notification path
- Tests run in < 1 second

---

## Task order

Tasks 1 and 3 are independent and can be done in parallel.
Task 2 depends on Task 1 (need inline events before removing polling).
Task 4 should run last to verify everything.

```
Task 1 (metadata listener) ──→ Task 2 (remove polling)
Task 3 (extract component)  ──→ (independent)
                               ──→ Task 4 (tests)
```

---

## Out of scope

- Token count breakdown (input/output) — Kiro only sends percentage today
- Cost estimation — no pricing data available from ACP
- Session state store pattern (Tauri-specific, not needed for Express/SSE)
- Compaction-triggered context reset — already handled separately
