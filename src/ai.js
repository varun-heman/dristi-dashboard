// ai.js — AI analysis + streaming chat via OpenRouter

const OR_KEY   = '__OPENROUTER_KEY__';   // replaced at deploy time by GitHub Actions
const OR_MODEL = 'anthropic/claude-3.5-haiku';
const OR_URL   = 'https://openrouter.ai/api/v1/chat/completions';

// ── Build context string from real issue data ─────────────────
function buildAIContext(issues) {
  const now     = new Date();
  const isIssue = i => !i.pull_request;
  const all     = issues.filter(isIssue);
  const open    = all.filter(i => i.state === 'open');
  const closed  = all.filter(i => i.state === 'closed');

  function daysOld(i) { return Math.floor((now - new Date(i.created_at)) / 86400000); }

  // --- Summary stats ---
  const ssOpen    = open.filter(i => i.labels.some(l => l.name === 'severity/showstopper'));
  const stale     = open.filter(i => {
    const d = Math.floor((now - new Date(i.updated_at)) / 86400000);
    return d > 30 && i.project_status?.toLowerCase() !== 'done';
  });

  // --- Status breakdown ---
  const statusCounts = {};
  open.forEach(i => { const s = i.project_status || 'No status'; statusCounts[s] = (statusCounts[s]||0)+1; });

  // --- Top assignees ---
  const ac = {};
  open.forEach(i => (i.assignees||[]).forEach(a => { ac[a.login] = (ac[a.login]||0)+1; }));
  const topAssignees = Object.entries(ac).sort((a,b)=>b[1]-a[1]).slice(0,10)
    .map(([l,c]) => `${l}(${c})`).join(', ');

  // --- Oldest open showstoppers ---
  const oldSS = ssOpen.map(i => ({...i, age:daysOld(i)})).sort((a,b)=>b.age-a.age).slice(0,10)
    .map(i => `  #${i.number} [${i.age}d] [${i.project_status||'no status'}] ${i.title}`).join('\n');

  // --- Oldest open issues (non-showstopper) ---
  const oldOpen = open.filter(i => !i.labels.some(l=>l.name==='severity/showstopper'))
    .map(i=>({...i,age:daysOld(i)})).sort((a,b)=>b.age-a.age).slice(0,20)
    .map(i=>`  #${i.number} [${i.age}d] [${i.project_status||'no status'}] ${i.title}`).join('\n');

  // --- 30 newest open issues ---
  const newest = open.slice().sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,30)
    .map(i=>`  #${i.number} [${i.project_status||'no status'}] ${i.title}`).join('\n');

  // --- 20 recently closed ---
  const recentClosed = closed.filter(i=>i.closed_at).sort((a,b)=>new Date(b.closed_at)-new Date(a.closed_at)).slice(0,20)
    .map(i=>`  #${i.number} ${i.title}`).join('\n');

  // --- Label frequency ---
  const lc = {};
  open.forEach(i=>i.labels.forEach(l=>{lc[l.name]=(lc[l.name]||0)+1;}));
  const topLabels = Object.entries(lc).sort((a,b)=>b[1]-a[1]).slice(0,15)
    .map(([n,c])=>`${n}(${c})`).join(', ');

  return `
REPOSITORY: pucardotorg/dristi  (PUCAR v1.0 Court Case Management System)
DATA AS OF: ${now.toISOString().slice(0,10)}

=== AGGREGATE STATS ===
Total issues (excl. PRs): ${all.length}
Open: ${open.length}  |  Closed: ${closed.length}
Stale (30d+ no update, excl. Done): ${stale.length}  (${Math.round(stale.length/open.length*100)||0}%)
Open Showstoppers: ${ssOpen.length}
  - 30d+ old: ${ssOpen.filter(i=>daysOld(i)>30).length}
  - 90d+ old: ${ssOpen.filter(i=>daysOld(i)>90).length}

=== PROJECT STATUS BREAKDOWN (open issues) ===
${Object.entries(statusCounts).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`  ${k}: ${v}`).join('\n')}

=== TOP ASSIGNEES (open issues) ===
${topAssignees}

=== TOP LABELS (open issues) ===
${topLabels}

=== OLDEST OPEN SHOWSTOPPERS (top 10) ===
${oldSS || '  (none)'}

=== OLDEST OPEN ISSUES — non-showstopper (top 20) ===
${oldOpen}

=== 30 NEWEST OPEN ISSUES ===
${newest}

=== 20 RECENTLY CLOSED ===
${recentClosed}
`.trim();
}

// ── Run analysis on load ──────────────────────────────────────
let _aiCtx = '';

async function runAnalysis() {
  if (!OR_KEY || OR_KEY === '__OPENROUTER_KEY__') {
    document.getElementById('ai-analysis').innerHTML =
      '<div style="color:#f59e0b;font-size:13px">⚠️ OpenRouter key not set — AI analysis unavailable in this build.</div>';
    return;
  }

  // Build context from live data
  // _issuesData is defined in dashboard.js and is in scope
  if (typeof _issuesData === 'undefined' || !_issuesData.length) {
    document.getElementById('ai-analysis').innerHTML =
      '<div style="color:#94a3b8;font-size:13px">No data loaded yet.</div>';
    return;
  }

  _aiCtx = buildAIContext(_issuesData);

  const box = document.getElementById('ai-analysis');
  box.innerHTML = '<div style="color:#94a3b8;font-size:13px">⟳ Analysing…</div>';

  const prompt = `You are a senior engineering program manager reviewing GitHub issue health data for an open-source court case management system (PUCAR v1.0).

Here is the current issue health data:

${_aiCtx}

Please provide:
1. **Overall health assessment** (2–3 sentences)
2. **Top 3 risks** that need immediate attention
3. **Actionable recommendations** (bullet points, specific and concrete)
4. **Positive signals** (what's going well)

Be concise and direct. Focus on what matters most for a small engineering team.`;

  try {
    const text = await streamCompletion(prompt, box);
    box.innerHTML = markdownToHtml(text);
  } catch (err) {
    box.innerHTML = `<div style="color:#f87171;font-size:13px">AI error: ${err.message}</div>`;
  }
}

// ── Chat ──────────────────────────────────────────────────────
const _chatHistory = [];   // [{role, content}]

async function sendChat() {
  const input = document.getElementById('chat-input');
  const msg   = input.value.trim();
  if (!msg) return;
  input.value = '';

  if (!OR_KEY || OR_KEY === '__OPENROUTER_KEY__') { appendChat('assistant', '⚠️ OpenRouter key not set.'); return; }

  // Show user message
  appendChat('user', msg);

  // Build messages list
  const sysPrompt = `You are a helpful assistant with access to real-time GitHub issue data for the PUCAR v1.0 court case management system. Answer questions using the data below.

${_aiCtx || 'Data not yet loaded — please wait for the page to fully load.'}`;

  const messages = [
    { role: 'system', content: sysPrompt },
    ..._chatHistory.slice(-20),
    { role: 'user', content: msg }
  ];

  // Placeholder for streaming response
  const placeholder = appendChat('assistant', '⟳ Thinking…');
  _chatHistory.push({ role: 'user', content: msg });

  try {
    const text = await streamCompletion(null, placeholder, messages);
    placeholder.innerHTML = markdownToHtml(text);
    _chatHistory.push({ role: 'assistant', content: text });
  } catch (err) {
    placeholder.innerHTML = `<span style="color:#f87171">Error: ${err.message}</span>`;
  }
}

function appendChat(role, html) {
  const hist = document.getElementById('chat-history');
  const div  = document.createElement('div');
  div.className = `chat-msg chat-${role}`;
  div.innerHTML = role === 'assistant' ? html : escChatHtml(html);
  hist.appendChild(div);
  hist.scrollTop = hist.scrollHeight;
  return div;
}

function escChatHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Streaming completion ──────────────────────────────────────
async function streamCompletion(prompt, targetEl, messagesOverride) {
  const messages = messagesOverride || [{ role: 'user', content: prompt }];

  const resp = await fetch(OR_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OR_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OR_MODEL, messages, stream: true, max_tokens: 1200 })
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenRouter ${resp.status}: ${err.slice(0,200)}`);
  }

  const reader  = resp.body.getReader();
  const decoder = new TextDecoder();
  let   full    = '';
  let   buffer  = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();   // keep incomplete line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') break;
      try {
        const chunk = JSON.parse(raw);
        const delta = chunk.choices?.[0]?.delta?.content || '';
        full += delta;
        if (targetEl) targetEl.innerHTML = markdownToHtml(full) + '<span class="cursor">▌</span>';
      } catch { /* ignore parse errors */ }
    }
  }

  if (targetEl) {
    const cursors = targetEl.querySelectorAll('.cursor');
    cursors.forEach(c => c.remove());
  }
  return full;
}

// ── Minimal markdown renderer ─────────────────────────────────
function markdownToHtml(md) {
  return md
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    // Code blocks
    .replace(/```[\s\S]*?```/g, m => `<pre><code>${m.slice(3,-3).trim()}</code></pre>`)
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Headers
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm,  '<h3>$1</h3>')
    .replace(/^# (.+)$/gm,   '<h2>$1</h2>')
    // Bullet points
    .replace(/^- (.+)$/gm,   '<li>$1</li>')
    .replace(/(<li>[\s\S]+?<\/li>)/g, '<ul>$1</ul>')
    // Numbered lists
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    // Line breaks
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>')
    // Wrap in paragraph
    .replace(/^(.)/,'<p>$1')
    + '</p>';
}

// ── Enter key in chat input ───────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('chat-input');
  if (input) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    });
  }
});
