// dashboard.js — metrics, charts, data loading

let _issuesData = [];
let _fetchedAt  = null;
let trendChart, ageChart, labelChart, statusChart;

// ── Tab switching ─────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach((b,i) => b.classList.toggle('active', ['dashboard','search'][i] === name));
  document.querySelectorAll('.tab-content').forEach(el => el.classList.toggle('active', el.id === 'tab-' + name));
}

// ── Boot — load pre-fetched JSON ──────────────────────────────
(async function boot() {
  showLoader('Loading dashboard data…', '');
  try {
    const resp = await fetch('data/issues.json');
    if (!resp.ok) throw new Error(`data/issues.json not found (${resp.status}). Has the GitHub Action run yet?`);
    const payload = await resp.json();
    _issuesData = payload.issues || [];
    _fetchedAt  = payload.fetched_at;
    hideLoader();
    renderDashboard(_issuesData);
    initSearch(_issuesData);             // hand off to search.js
    setTimeout(runAnalysis, 500);        // kick off AI
  } catch(err) {
    hideLoader();
    showError(err.message);
  }
})();

// ── Loader helpers ────────────────────────────────────────────
function showLoader(msg, sub) {
  document.getElementById('loader').style.display = 'flex';
  document.getElementById('loader-msg').textContent = msg;
  document.getElementById('loader-sub').textContent = sub;
}
function hideLoader() { document.getElementById('loader').style.display = 'none'; }
function showError(msg) {
  const b = document.getElementById('err-banner');
  b.style.display = 'block';
  document.getElementById('err-msg').textContent = msg;
}

// ── Utils ─────────────────────────────────────────────────────
function daysBetween(a, b) { return Math.floor((new Date(b) - new Date(a)) / 86400000); }
function median(arr) { if (!arr.length) return 0; const s = [...arr].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; }
function ageBadge(d) {
  if (d > 90) return `<span class="badge crit">${d}d</span>`;
  if (d > 30) return `<span class="badge warn">${d}d</span>`;
  return `<span class="badge ok">${d}d</span>`;
}
function statusPill(s) {
  if (!s) return `<span class="status-pill status-unknown">—</span>`;
  const key = s.toLowerCase().replace(/\s+/g,'');
  const cls = key.includes('done') ? 'status-done'
    : key.includes('progress') ? 'status-inprogress'
    : key.includes('review')   ? 'status-inreview'
    : key.includes('block')    ? 'status-blocked'
    : key.includes('todo') || key.includes('backlog') ? 'status-todo'
    : 'status-unknown';
  return `<span class="status-pill ${cls}">${s}</span>`;
}
function monthLabel(m) {
  const [y, mo] = m.split('-');
  return `${['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+mo]} '${y.slice(2)}`;
}

// ── Main render ───────────────────────────────────────────────
function renderDashboard(raw) {
  const now    = new Date();
  const issues = raw.filter(i => !i.pull_request);
  const open   = issues.filter(i => i.state === 'open');
  const closed = issues.filter(i => i.state === 'closed');

  // Sync badge
  if (_fetchedAt) {
    const d = new Date(_fetchedAt);
    document.getElementById('cache-badge').innerHTML = `<span class="cache-badge">✓ Data from ${d.toLocaleDateString('en-GB',{day:'numeric',month:'short'})}</span>`;
    document.getElementById('sync-detail').textContent = `Fetched at ${d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})} UTC · refreshed nightly`;
  }

  // Stale — exclude issues whose project status is "Done"
  const stale    = open.filter(i => daysBetween(i.updated_at, now) > 30 && i.project_status?.toLowerCase() !== 'done');
  const stalePct = Math.round(stale.length / open.length * 100) || 0;

  // Age buckets
  const ab = {lt30:0, d30_90:0, d90_180:0, gt180:0};
  open.forEach(i => {
    const d = daysBetween(i.created_at, now);
    if      (d <  30) ab.lt30++;
    else if (d <  90) ab.d30_90++;
    else if (d < 180) ab.d90_180++;
    else              ab.gt180++;
  });

  // Showstoppers
  const ss    = open.filter(i => i.labels.some(l => l.name === 'severity/showstopper'));
  const ss30  = ss.filter(i => daysBetween(i.created_at, now) > 30).length;
  const ss90  = ss.filter(i => daysBetween(i.created_at, now) > 90).length;
  const oldSS = ss.map(i => ({number:i.number, title:i.title, days:daysBetween(i.created_at,now), status:i.project_status}))
                  .sort((a,b)=>b.days-a.days).slice(0,5);

  // Median close time
  const ttc = closed.filter(i=>i.closed_at).map(i=>daysBetween(i.created_at,i.closed_at));
  const med = median(ttc);

  // Monthly trend
  const mc={}, mcl={};
  issues.forEach(i=>{ const m=i.created_at.slice(0,7); mc[m]=(mc[m]||0)+1; });
  closed.forEach(i=>{ if(i.closed_at){ const m=i.closed_at.slice(0,7); mcl[m]=(mcl[m]||0)+1; } });
  const allM  = [...new Set([...Object.keys(mc),...Object.keys(mcl)])].sort();
  const trend = allM.slice(-10).map(m=>({month:m, created:mc[m]||0, closed:mcl[m]||0}));

  // Labels
  const lc = {};
  open.forEach(i=>i.labels.forEach(l=>{lc[l.name]=(lc[l.name]||0)+1;}));
  const topLabels = Object.entries(lc).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([name,count])=>({name,count}));

  // Assignees
  const ac = {};
  open.forEach(i=>(i.assignees||[]).forEach(a=>{ac[a.login]=(ac[a.login]||0)+1;}));
  const topA = Object.entries(ac).sort((a,b)=>b[1]-a[1]).slice(0,8);
  const maxA = topA[0]?.[1]||1;

  const noLabels   = open.filter(i=>i.labels.length===0).length;
  const unassigned = open.filter(i=>!i.assignee&&(!i.assignees||!i.assignees.length)).length;
  const avgNet     = Math.round(trend.slice(0,-1).reduce((s,t)=>s+t.created-t.closed,0)/Math.max(trend.length-1,1));

  // Project status breakdown
  const statusCounts = {};
  open.forEach(i => {
    const s = i.project_status || 'No status';
    statusCounts[s] = (statusCounts[s]||0)+1;
  });
  const hasStatus = Object.keys(statusCounts).some(k => k !== 'No status');

  // ── DOM updates ──
  document.getElementById('alert-banner').style.display = ss.length ? 'flex' : 'none';
  document.getElementById('alert-text').innerHTML = `<strong>${ss.length} severity/showstopper issues are open</strong> — ${ss30} open 30+ days, ${ss90} open 90+ days.`;

  document.getElementById('v-open').textContent     = open.length;
  document.getElementById('v-open-sub').textContent  = `of ${issues.length} total issues`;
  document.getElementById('v-stale').textContent    = stale.length;
  document.getElementById('v-stale-sub').textContent = `${stalePct}% (excl. Done in project)`;
  document.getElementById('v-ss').textContent       = ss.length;
  document.getElementById('v-ss-sub').textContent   = `${ss30} open 30+ days`;
  document.getElementById('v-close').textContent    = med + 'd';

  document.getElementById('ss-list').innerHTML = oldSS.length
    ? oldSS.map(s=>`
        <div class="ss-item">
          <div class="t">
            <a href="https://github.com/pucardotorg/dristi/issues/${s.number}" target="_blank">#${s.number} ${s.title.slice(0,50)}${s.title.length>50?'…':''}</a>
            <div style="margin-top:3px">${statusPill(s.status)}</div>
          </div>
          ${ageBadge(s.days)}
        </div>`).join('')
    : '<div style="color:#64748b;font-size:12px;padding:8px 0">No open showstoppers 🎉</div>';

  document.getElementById('assignee-list').innerHTML = topA.map(([name,count])=>`
    <div class="abar">
      <div class="ar"><span class="an">${name}</span><span class="ac">${count}</span></div>
      <div class="atrack"><div class="afill ${count===maxA?'hi':''}" style="width:${Math.round(count/maxA*100)}%"></div></div>
    </div>`).join('');

  document.getElementById('scorecard').innerHTML = `
    <tr><td><span class="dot ${avgNet>20?'r':avgNet>0?'o':'g'}"></span> Volume mgmt</td><td>${avgNet>20?'Poor':avgNet>0?'Fair':'Good'}</td><td>+${avgNet} net/mo avg</td></tr>
    <tr><td><span class="dot ${stalePct>60?'r':stalePct>30?'o':'g'}"></span> Closure discipline</td><td>${stalePct>60?'Poor':stalePct>30?'Fair':'Good'}</td><td>${stalePct}% stale open</td></tr>
    <tr><td><span class="dot ${med<=3?'g':med<=10?'o':'r'}"></span> Closure speed</td><td>${med<=3?'Good':med<=10?'Fair':'Poor'}</td><td>Median ${med}d</td></tr>
    <tr><td><span class="dot ${ss.length>20?'r':ss.length>5?'o':'g'}"></span> Critical issues</td><td>${ss.length>20?'Poor':ss.length>5?'Fair':'Good'}</td><td>${ss.length} showstoppers</td></tr>
    <tr><td><span class="dot ${noLabels>30?'r':noLabels>10?'o':'g'}"></span> Triage</td><td>${noLabels>30?'Poor':noLabels>10?'Fair':'Good'}</td><td>${noLabels} no labels</td></tr>
    <tr><td><span class="dot ${unassigned>30?'r':unassigned>10?'o':'g'}"></span> Assignment</td><td>${unassigned>30?'Poor':unassigned>10?'Fair':'Good'}</td><td>${unassigned} unassigned</td></tr>
    <tr><td><span class="dot ${maxA>80?'o':'g'}"></span> Workload balance</td><td>${maxA>80?'Fair':'Good'}</td><td>Top: ${maxA} issues</td></tr>`;

  // Status breakdown
  if (hasStatus) {
    document.getElementById('status-row').style.display = 'grid';
    renderStatusChart(statusCounts, open.length);
  }

  buildCharts(trend, ab, topLabels);
  renderLatestBugs(issues, '');
  document.getElementById('ai-section').style.display = 'block';
}

// ── Latest bugs ───────────────────────────────────────────────
let _allIssuesForBugs = [];
function renderLatestBugs(issues, severityFilter) {
  _allIssuesForBugs = issues;
  const now  = new Date();
  const bugs = issues
    .filter(i => !i.pull_request && i.labels.some(l => l.name.toLowerCase().includes('bug') || l.name.toLowerCase().includes('severity')))
    .filter(i => !severityFilter || i.labels.some(l => l.name === severityFilter))
    .sort((a,b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 10);

  const SMAP = {
    'severity/showstopper': ['sev-chip sev-ss-chip','🔴 Showstopper'],
    'severity/high':        ['sev-chip sev-hi-chip','🟠 High'],
    'severity/medium':      ['sev-chip sev-md-chip','🟡 Medium'],
    'severity/low':         ['sev-chip sev-lo-chip','🟢 Low'],
  };

  document.getElementById('latest-bugs').innerHTML = bugs.length ? bugs.map(i => {
    const sevLabel = i.labels.find(l => SMAP[l.name]);
    const sevChip  = sevLabel ? `<span class="${SMAP[sevLabel.name][0]}">${SMAP[sevLabel.name][1]}</span>` : '';
    const age  = daysBetween(i.created_at, now);
    const stateTag = i.state === 'open'
      ? `<span class="state-open">open</span>`
      : `<span class="state-closed">closed</span>`;
    return `<div class="bug-row">
      <div class="bug-left">
        <a href="https://github.com/pucardotorg/dristi/issues/${i.number}" target="_blank" class="bug-num">#${i.number}</a>
        ${sevChip}
        ${stateTag}
      </div>
      <div class="bug-mid">
        <span class="bug-title">${i.title.slice(0,70)}${i.title.length>70?'…':''}</span>
        <div class="bug-meta">${statusPill(i.project_status)} <span class="bug-age">${age}d ago</span></div>
      </div>
    </div>`;
  }).join('') : '<div style="color:#94a3b8;font-size:13px;padding:8px 0">No bugs found for this filter.</div>';
}

function setSeverity(sev) {
  document.querySelectorAll('.sev-btn').forEach(b => b.classList.remove('active'));
  const match = [...document.querySelectorAll('.sev-btn')].find(b => b.getAttribute('onclick')?.includes(`'${sev}'`));
  if (match) match.classList.add('active');
  renderLatestBugs(_allIssuesForBugs, sev);
}

// ── Charts ────────────────────────────────────────────────────
function buildCharts(trend, ab, topLabels) {
  if (trendChart) trendChart.destroy();
  trendChart = new Chart(document.getElementById('trendChart'), {
    data: { labels: trend.map(t=>monthLabel(t.month)), datasets: [
      {type:'bar',  label:'Created', data:trend.map(t=>t.created), backgroundColor:'#f87171', borderRadius:4},
      {type:'bar',  label:'Closed',  data:trend.map(t=>t.closed),  backgroundColor:'#4ade80', borderRadius:4},
      {type:'line', label:'Net +/-', data:trend.map(t=>t.created-t.closed), borderColor:'#f59e0b', backgroundColor:'transparent', pointBackgroundColor:'#f59e0b', tension:0.3}
    ]},
    options: { responsive:true, maintainAspectRatio:true, plugins:{legend:{labels:{font:{size:11}}}}, scales:{y:{grid:{color:'#f1f5f9'},ticks:{font:{size:11}}},x:{grid:{display:false},ticks:{font:{size:11}}}} }
  });

  if (ageChart) ageChart.destroy();
  ageChart = new Chart(document.getElementById('ageChart'), {
    type:'doughnut',
    data:{labels:['< 30d','30–90d','90–180d','180d+'],datasets:[{data:[ab.lt30,ab.d30_90,ab.d90_180,ab.gt180],backgroundColor:['#4ade80','#facc15','#fb923c','#f87171'],borderWidth:2,borderColor:'#fff'}]},
    options:{responsive:true,maintainAspectRatio:true,cutout:'60%',plugins:{legend:{position:'bottom',labels:{font:{size:11},padding:8}}}}
  });

  const colours=['#f87171','#60a5fa','#a78bfa','#dc2626','#fb923c','#fbbf24','#34d399','#f472b6','#94a3b8','#6ee7b7'];
  if (labelChart) labelChart.destroy();
  labelChart = new Chart(document.getElementById('labelChart'), {
    type:'bar',
    data:{labels:topLabels.map(l=>l.name),datasets:[{label:'Open',data:topLabels.map(l=>l.count),backgroundColor:colours,borderRadius:4}]},
    options:{responsive:true,maintainAspectRatio:true,indexAxis:'y',plugins:{legend:{display:false}},scales:{x:{grid:{color:'#f1f5f9'},ticks:{font:{size:11}}},y:{grid:{display:false},ticks:{font:{size:11}}}}}
  });
}

function renderStatusChart(statusCounts, total) {
  const entries = Object.entries(statusCounts).sort((a,b)=>b[1]-a[1]);
  const colourMap = {
    'done':'#4ade80','in progress':'#60a5fa','in review':'#a78bfa',
    'blocked':'#f87171','todo':'#94a3b8','backlog':'#cbd5e1','no status':'#e2e8f0'
  };
  const colours = entries.map(([k]) => colourMap[k.toLowerCase()] || '#fb923c');

  if (statusChart) statusChart.destroy();
  statusChart = new Chart(document.getElementById('statusChart'), {
    type:'bar',
    data:{labels:entries.map(([k])=>k),datasets:[{data:entries.map(([,v])=>v),backgroundColor:colours,borderRadius:4}]},
    options:{responsive:true,maintainAspectRatio:true,indexAxis:'y',plugins:{legend:{display:false}},scales:{x:{grid:{color:'#f1f5f9'},ticks:{font:{size:11}}},y:{grid:{display:false},ticks:{font:{size:11}}}}}
  });

  const doneCount = statusCounts['Done'] || statusCounts['done'] || 0;
  const inProg    = Object.entries(statusCounts).filter(([k])=>k.toLowerCase().includes('progress')).reduce((s,[,v])=>s+v,0);
  const blocked   = Object.entries(statusCounts).filter(([k])=>k.toLowerCase().includes('block')).reduce((s,[,v])=>s+v,0);
  const noStatus  = statusCounts['No status'] || 0;

  document.getElementById('status-summary').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:4px;font-size:13px">
      ${entries.map(([k,v])=>`
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span>${statusPill(k)}</span>
          <span style="font-weight:700;color:#0f172a">${v} <span style="font-weight:400;color:#94a3b8">(${Math.round(v/total*100)}%)</span></span>
        </div>`).join('')}
      ${doneCount > 0 ? `<div style="margin-top:8px;padding:8px 10px;background:#f0fdf4;border-radius:6px;font-size:12px;color:#166534">
        ⚡ ${doneCount} open issues are marked <strong>Done</strong> in the project — they'll auto-close once Ramu's bulk update runs.
      </div>` : ''}
    </div>`;
}
