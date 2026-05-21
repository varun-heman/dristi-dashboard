// ai.js — AI analysis + streaming chat via Cloudflare Worker proxy

// The Worker URL — update this after you deploy the Cloudflare Worker
const WORKER_URL = 'https://dristi-ai.earthdb.workers.dev';
const OR_MODEL   = 'anthropic/claude-3.5-haiku';
const OR_URL     = WORKER_URL;   // all requests go through the proxy

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

// ── Load pre-generated analysis from data/analysis.json ──────
let _aiCtx = '';

async function runAnalysis() {
  const box = document.getElementById('ai-analysis');
  box.innerHTML = '<div style="color:#94a3b8;font-size:13px">⟳ Loading analysis…</div>';

  try {
    const resp = await fetch('data/analysis.json');
    if (!resp.ok) throw new Error(`analysis.json not found (${resp.status})`);
    const payload = await resp.json();

    if (!payload.analysis) {
      box.innerHTML = '<div style="color:#94a3b8;font-size:13px">No analysis available yet — run the workflow to generate it.</div>';
      return;
    }

    const ts = payload.generated_at
      ? `<div style="font-size:11px;color:#94a3b8;margin-bottom:8px">Generated ${new Date(payload.generated_at).toLocaleString('en-GB')} · ${payload.model}</div>`
      : '';
    box.innerHTML = ts + markdownToHtml(payload.analysis);

    // Build context for chat from live issue data
    if (typeof _issuesData !== 'undefined' && _issuesData.length) {
      _aiCtx = buildAIContext(_issuesData);
    }
  } catch (err) {
    box.innerHTML = `<div style="color:#f87171;font-size:13px">Could not load analysis: ${err.message}</div>`;
  }
}

// ── Chat ──────────────────────────────────────────────────────
const _chatHistory = [];   // [{role, content}]

async function sendChat() {
  const input = document.getElementById('chat-input');
  const msg   = input.value.trim();
  if (!msg) return;
  input.value = '';

  if (!WORKER_URL || WORKER_URL.includes('YOUR_SUBDOMAIN')) { appendChat('assistant', '⚠️ Worker URL not configured.'); return; }

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
    headers: { 'Content-Type': 'application/json' },
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
  // 1. Escape HTML special chars
  let html = md
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;');

  // 2. Fenced code blocks (preserve early so inner content isn't processed)
  html = html.replace(/```[\s\S]*?```/g, m => `<pre><code>${m.slice(3,-3).trim()}</code></pre>`);

  // 3. Inline formatting
  html = html
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,     '<em>$1</em>');

  // 4. Headers
  html = html
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm,  '<h3>$1</h3>')
    .replace(/^# (.+)$/gm,   '<h2>$1</h2>');

  // 5. List items
  html = html
    .replace(/^[-*] (.+)$/gm,   '<li>$1</li>')
    .replace(/^\d+\. (.+)$/gm,  '<li>$1</li>');

  // 6. Group consecutive <li> lines into a single <ul>
  html = html.replace(/((?:<li>[^\n]*<\/li>\n?)+)/g,
    m => '<ul>' + m.replace(/\n/g, '') + '</ul>');

  // 7. Split on blank lines and wrap non-block content in <p>
  const BLOCK = /^<(h[1-6]|ul|ol|pre|blockquote)/;
  html = html.split(/\n{2,}/).map(block => {
    block = block.trim();
    if (!block) return '';
    if (BLOCK.test(block)) return block;
    return '<p>' + block.replace(/\n/g, '<br>') + '</p>';
  }).join('');

  return html;
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
