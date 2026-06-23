// search.js — Search & Timeline tab logic

let _allIssues  = [];          // full issue list, set by initSearch()
let _filtered   = [];          // currently filtered subset
let _sortKey    = 'number';
let _sortDir    = -1;          // -1 = desc, 1 = asc
let _page       = 1;
const PAGE_SIZE = 50;
let _searchTimer;
let _timelineChart;
let _staleOnly  = false;       // extra stale filter from quick presets

// ── Entry point (called from dashboard.js after data loads) ──
function initSearch(issues) {
  _allIssues = issues;
  _filtered  = [...issues];

  document.getElementById('search-total').textContent = issues.length.toLocaleString();
  populateFilterDropdowns(issues);
  applyFilters();
}

// ── Populate filter <select> options ─────────────────────────
function populateFilterDropdowns(issues) {
  // Statuses
  const statuses = [...new Set(issues.map(i => i.project_status).filter(Boolean))].sort();
  const fStatus = document.getElementById('f-status');
  statuses.forEach(s => {
    const o = document.createElement('option'); o.value = s; o.textContent = s; fStatus.appendChild(o);
  });

  // Labels
  const labelSet = {};
  issues.forEach(i => i.labels.forEach(l => { labelSet[l.name] = true; }));
  const fLabel = document.getElementById('f-label');
  Object.keys(labelSet).sort().forEach(name => {
    const o = document.createElement('option'); o.value = name; o.textContent = name; fLabel.appendChild(o);
  });

  // Assignees — check both assignees[] array and singular assignee field
  const assigneeSet = {};
  issues.forEach(i => {
    (i.assignees || []).forEach(a => { assigneeSet[a.login] = true; });
    if (i.assignee?.login) assigneeSet[i.assignee.login] = true;
  });
  const fAssignee = document.getElementById('f-assignee');
  Object.keys(assigneeSet).sort().forEach(login => {
    const o = document.createElement('option'); o.value = login; o.textContent = login; fAssignee.appendChild(o);
  });
}

// ── Debounced text search ─────────────────────────────────────
function debounceSearch() {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(applyFilters, 200);
}

// ── Apply all filters ─────────────────────────────────────────
function applyFilters() {
  const q        = (document.getElementById('search-q').value || '').toLowerCase().trim();
  const state    = document.getElementById('f-state').value;
  const status   = document.getElementById('f-status').value;
  const severity = document.getElementById('f-severity')?.value || '';
  const label    = document.getElementById('f-label').value;
  const assignee = document.getElementById('f-assignee').value;
  const dateFrom = document.getElementById('f-date-from')?.value;
  const dateTo   = document.getElementById('f-date-to')?.value;
  const fromTs   = dateFrom ? new Date(dateFrom).getTime() : null;
  const toTs     = dateTo   ? new Date(dateTo + 'T23:59:59').getTime() : null;
  const now      = Date.now();

  _filtered = _allIssues.filter(i => {
    if (i.pull_request) return false;
    if (q && !i.title.toLowerCase().includes(q) && !String(i.number).includes(q)) return false;
    if (state && i.state !== state) return false;
    if (status === '__none__') { if (i.project_status) return false; }
    else if (status && i.project_status !== status) return false;
    if (severity && !i.labels.some(l => l.name === severity)) return false;
    if (label && !i.labels.some(l => l.name === label)) return false;
    if (assignee === '__unassigned__') {
      if ((i.assignees||[]).length > 0 || i.assignee?.login) return false;
    } else if (assignee) {
      if (!(i.assignees||[]).some(a => a.login === assignee) && i.assignee?.login !== assignee) return false;
    }
    if (fromTs && new Date(i.created_at).getTime() < fromTs) return false;
    if (toTs   && new Date(i.created_at).getTime() > toTs)   return false;
    if (_staleOnly) {
      const daysSinceUpdate = (now - new Date(i.updated_at).getTime()) / 86400000;
      if (i.state !== 'open' || daysSinceUpdate < 30) return false;
    }
    return true;
  });

  _page = 1;
  document.getElementById('results-count').textContent = `${_filtered.length.toLocaleString()} results`;
  renderActiveFilters(q, state, status, severity, label, assignee, dateFrom, dateTo);
  sortAndRender();
}

// ── Active filter chips ────────────────────────────────────────
function renderActiveFilters(q, state, status, severity, label, assignee, dateFrom, dateTo) {
  const bar = document.getElementById('active-filters');
  if (!bar) return;
  const chips = [];
  if (q)        chips.push([`"${q}"`,     () => { document.getElementById('search-q').value = ''; applyFilters(); }]);
  if (state)    chips.push([state,         () => { document.getElementById('f-state').value = ''; applyFilters(); }]);
  if (status === '__none__') chips.push(['No Status', () => { document.getElementById('f-status').value = ''; applyFilters(); }]);
  else if (status) chips.push([status,    () => { document.getElementById('f-status').value = ''; applyFilters(); }]);
  if (severity) chips.push([severity.replace('severity/',''), () => { document.getElementById('f-severity').value = ''; applyFilters(); }]);
  if (label)    chips.push([label,        () => { document.getElementById('f-label').value = ''; applyFilters(); }]);
  if (assignee === '__unassigned__') chips.push(['Unassigned', () => { document.getElementById('f-assignee').value = ''; applyFilters(); }]);
  else if (assignee) chips.push([assignee, () => { document.getElementById('f-assignee').value = ''; applyFilters(); }]);
  if (dateFrom) chips.push([`from ${dateFrom}`, () => { document.getElementById('f-date-from').value = ''; applyFilters(); }]);
  if (dateTo)   chips.push([`to ${dateTo}`,    () => { document.getElementById('f-date-to').value = ''; applyFilters(); }]);
  if (_staleOnly) chips.push(['Stale 30d+', () => { _staleOnly = false; setActiveQuickBtn('all'); applyFilters(); }]);
  if (chips.length === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  bar.innerHTML = '<span style="font-size:11px;color:#94a3b8;margin-right:2px;white-space:nowrap">Active:</span>' +
    chips.map((c, idx) =>
      `<button class="af-chip" onclick="_afRemove(${idx})">${escHtml(c[0])} ×</button>`
    ).join('');
  bar._removers = chips.map(c => c[1]);
}

function _afRemove(idx) {
  const bar = document.getElementById('active-filters');
  if (bar && bar._removers && bar._removers[idx]) bar._removers[idx]();
}

// ── Quick filter presets ───────────────────────────────────────
function quickFilter(preset) {
  document.getElementById('search-q').value   = '';
  document.getElementById('f-state').value    = '';
  document.getElementById('f-status').value   = '';
  const fs = document.getElementById('f-severity'); if (fs) fs.value = '';
  document.getElementById('f-label').value    = '';
  document.getElementById('f-assignee').value = '';
  const df = document.getElementById('f-date-from'); if (df) df.value = '';
  const dt = document.getElementById('f-date-to');   if (dt) dt.value = '';
  _staleOnly = false;

  if (preset === 'showstoppers') {
    document.getElementById('f-state').value    = 'open';
    if (document.getElementById('f-severity')) document.getElementById('f-severity').value = 'severity/showstopper';
  } else if (preset === 'stale') {
    _staleOnly = true;
  } else if (preset === 'unassigned') {
    document.getElementById('f-state').value    = 'open';
    document.getElementById('f-assignee').value = '__unassigned__';
  } else if (preset === 'nostatus') {
    document.getElementById('f-state').value  = 'open';
    document.getElementById('f-status').value = '__none__';
  }

  setActiveQuickBtn(preset);
  applyFilters();
}

function setActiveQuickBtn(preset) {
  ['all','showstoppers','stale','unassigned','nostatus'].forEach(id => {
    const el = document.getElementById(`qf-${id}`);
    if (el) el.classList.toggle('qf-active', id === preset);
  });
}

function clearFilters() {
  _staleOnly = false;
  document.getElementById('search-q').value   = '';
  document.getElementById('f-state').value    = '';
  document.getElementById('f-status').value   = '';
  const fs = document.getElementById('f-severity'); if (fs) fs.value = '';
  document.getElementById('f-label').value    = '';
  document.getElementById('f-assignee').value = '';
  const df = document.getElementById('f-date-from'); if (df) df.value = '';
  const dt = document.getElementById('f-date-to');   if (dt) dt.value = '';
  setActiveQuickBtn('all');
  applyFilters();
}

// ── Sort ──────────────────────────────────────────────────────
function sortBy(key) {
  if (_sortKey === key) { _sortDir *= -1; }
  else { _sortKey = key; _sortDir = -1; }
  sortAndRender();
}

function sortAndRender() {
  const sorted = [..._filtered].sort((a, b) => {
    let av = a[_sortKey] ?? '';
    let bv = b[_sortKey] ?? '';
    if (_sortKey === 'assignee') { av = a.assignee?.login ?? ''; bv = b.assignee?.login ?? ''; }
    if (typeof av === 'number') return (av - bv) * _sortDir;
    return String(av).localeCompare(String(bv)) * _sortDir;
  });

  renderTable(sorted);
  renderPagination(sorted.length);

  const view = document.getElementById('view-timeline').style.display;
  if (view !== 'none') renderTimeline(sorted);
}

// ── Table ─────────────────────────────────────────────────────
function renderTable(sorted) {
  const start  = (_page - 1) * PAGE_SIZE;
  const page   = sorted.slice(start, start + PAGE_SIZE);
  const tbody  = document.getElementById('issues-tbody');

  tbody.innerHTML = page.map(i => {
    const created = new Date(i.created_at).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'2-digit'});
    const updated = new Date(i.updated_at).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'2-digit'});
    const assignees = (i.assignees||[]).map(a=>a.login).join(', ') || '—';
    const stateTag = i.state === 'open'
      ? `<span class="state-open">open</span>`
      : `<span class="state-closed">closed</span>`;
    return `<tr>
      <td class="num-col"><a href="https://github.com/pucardotorg/dristi/issues/${i.number}" target="_blank">#${i.number}</a></td>
      <td class="title-col">${escHtml(i.title.slice(0,80))}${i.title.length>80?'…':''}</td>
      <td>${statusPill(i.project_status)}</td>
      <td>${stateTag}</td>
      <td class="date-col">${created}</td>
      <td class="date-col">${updated}</td>
      <td class="assignee-col">${escHtml(assignees)}</td>
    </tr>`;
  }).join('');
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Pagination ────────────────────────────────────────────────
function renderPagination(total) {
  const pages = Math.ceil(total / PAGE_SIZE);
  const pg    = document.getElementById('pagination');
  if (pages <= 1) { pg.innerHTML = ''; return; }

  const btns = [];
  if (_page > 1) btns.push(`<button onclick="goPage(${_page-1})">‹ Prev</button>`);

  // Show up to 7 page numbers
  let lo = Math.max(1, _page - 3), hi = Math.min(pages, lo + 6);
  lo = Math.max(1, hi - 6);
  if (lo > 1) btns.push(`<button onclick="goPage(1)">1</button><span>…</span>`);
  for (let p = lo; p <= hi; p++) {
    btns.push(`<button class="${p===_page?'active':''}" onclick="goPage(${p})">${p}</button>`);
  }
  if (hi < pages) btns.push(`<span>…</span><button onclick="goPage(${pages})">${pages}</button>`);

  if (_page < pages) btns.push(`<button onclick="goPage(${_page+1})">Next ›</button>`);
  pg.innerHTML = btns.join('');
}

function goPage(p) {
  _page = p;
  const sorted = [..._filtered].sort((a, b) => {
    let av = a[_sortKey] ?? '';
    let bv = b[_sortKey] ?? '';
    if (_sortKey === 'assignee') { av = a.assignee?.login ?? ''; bv = b.assignee?.login ?? ''; }
    if (typeof av === 'number') return (av - bv) * _sortDir;
    return String(av).localeCompare(String(bv)) * _sortDir;
  });
  renderTable(sorted);
  renderPagination(sorted.length);
  document.getElementById('view-table').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── View toggle (table / timeline) ───────────────────────────
function setView(v) {
  document.getElementById('view-table').style.display   = v === 'table'    ? 'block' : 'none';
  document.getElementById('view-timeline').style.display = v === 'timeline' ? 'block' : 'none';
  document.getElementById('view-table-btn').classList.toggle('active',    v === 'table');
  document.getElementById('view-timeline-btn').classList.toggle('active', v === 'timeline');
  if (v === 'timeline') {
    const sorted = [..._filtered].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    renderTimeline(sorted);
  }
}

// ── Timeline ──────────────────────────────────────────────────
function renderTimeline(sorted) {
  // Volume chart (created per week)
  const wc = {}, wcl = {};
  sorted.forEach(i => {
    const w = weekLabel(i.created_at);
    wc[w] = (wc[w]||0) + 1;
    if (i.closed_at) { const wl = weekLabel(i.closed_at); wcl[wl] = (wcl[wl]||0) + 1; }
  });
  const weeks = [...new Set([...Object.keys(wc),...Object.keys(wcl)])].sort().slice(-26);

  if (_timelineChart) _timelineChart.destroy();
  _timelineChart = new Chart(document.getElementById('timelineChart'), {
    data: {
      labels: weeks,
      datasets: [
        { type:'bar',  label:'Created', data:weeks.map(w=>wc[w]||0),  backgroundColor:'#f87171', borderRadius:3 },
        { type:'bar',  label:'Closed',  data:weeks.map(w=>wcl[w]||0), backgroundColor:'#4ade80', borderRadius:3 },
        { type:'line', label:'Net +/-', data:weeks.map(w=>(wc[w]||0)-(wcl[w]||0)), borderColor:'#f59e0b', backgroundColor:'transparent', tension:0.3, pointRadius:2 }
      ]
    },
    options:{
      responsive:true, maintainAspectRatio:true,
      plugins:{legend:{labels:{font:{size:11}}}},
      scales:{y:{grid:{color:'#f1f5f9'},ticks:{font:{size:10}}},x:{grid:{display:false},ticks:{font:{size:9},maxRotation:45}}}
    }
  });

  // Individual issue rows (show newest 100 in filter)
  const show = sorted.slice(0, 100);
  const now  = new Date();
  const wrap = document.getElementById('timeline-items');
  wrap.innerHTML = show.map(i => {
    const created  = new Date(i.created_at);
    const ended    = i.closed_at ? new Date(i.closed_at) : now;
    const age      = Math.ceil((ended - created) / 86400000);
    const stateTag = i.state === 'open'
      ? `<span class="state-open">open</span>`
      : `<span class="state-closed">closed</span>`;
    const barPct   = Math.min(100, Math.round(age / 365 * 100));
    return `<div class="tl-row">
      <div class="tl-left">
        <a href="https://github.com/pucardotorg/dristi/issues/${i.number}" target="_blank" class="tl-num">#${i.number}</a>
        ${stateTag}
        ${statusPill(i.project_status)}
      </div>
      <div class="tl-mid">
        <span class="tl-title">${escHtml(i.title.slice(0,70))}${i.title.length>70?'…':''}</span>
        <span class="tl-created">${created.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}</span>
      </div>
      <div class="tl-right">
        <div class="tl-track"><div class="tl-fill ${i.state==='open'?'tl-open':'tl-closed'}" style="width:${barPct}%;min-width:4px" title="${age} days"></div></div>
        <span class="tl-age">${age}d</span>
      </div>
    </div>`;
  }).join('');

  if (show.length < sorted.length) {
    wrap.innerHTML += `<div style="text-align:center;color:#94a3b8;font-size:12px;padding:12px">Showing ${show.length} of ${sorted.length} issues. Refine your filters to see more.</div>`;
  }
}

function weekLabel(iso) {
  const d = new Date(iso);
  // Monday of that week
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - day + 1);
  return d.toISOString().slice(0, 10);
}
