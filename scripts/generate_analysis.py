"""
generate_analysis.py
Reads data/issues.json, calls OpenRouter to generate an AI health analysis,
and writes data/analysis.json.

Run in CI after fetch_data.py.
Requires: OPENROUTER_KEY environment variable.
"""

import os, sys, json, requests
from datetime import datetime, timezone

OPENROUTER_KEY = os.environ.get("OPENROUTER_KEY", "")
if not OPENROUTER_KEY:
    print("WARNING: OPENROUTER_KEY not set — skipping AI analysis.", file=sys.stderr)
    # Write an empty placeholder so the dashboard doesn't error
    out_path = os.path.join(os.path.dirname(__file__), "..", "data", "analysis.json")
    with open(out_path, "w") as f:
        json.dump({"generated_at": None, "analysis": None}, f)
    sys.exit(0)

OR_URL   = "https://openrouter.ai/api/v1/chat/completions"
OR_MODEL = "meta-llama/llama-3.1-8b-instruct:free"

def build_context(issues):
    now    = datetime.now(timezone.utc)
    all_i  = [i for i in issues if not i.get("pull_request")]
    open_i = [i for i in all_i if i["state"] == "open"]
    closed = [i for i in all_i if i["state"] == "closed"]

    def age(i):
        return (now - datetime.fromisoformat(i["created_at"].replace("Z","+00:00"))).days

    ss = [i for i in open_i if any(l["name"] == "severity/showstopper" for l in i.get("labels", []))]
    stale = [i for i in open_i
             if (now - datetime.fromisoformat(i["updated_at"].replace("Z","+00:00"))).days > 30
             and (i.get("project_status") or "").lower() != "done"]

    status_counts = {}
    for i in open_i:
        s = i.get("project_status") or "No status"
        status_counts[s] = status_counts.get(s, 0) + 1

    ac = {}
    for i in open_i:
        for a in (i.get("assignees") or []):
            ac[a["login"]] = ac.get(a["login"], 0) + 1
    top_assignees = ", ".join(f"{l}({c})" for l, c in sorted(ac.items(), key=lambda x: -x[1])[:10])

    lc = {}
    for i in open_i:
        for l in i.get("labels", []):
            lc[l["name"]] = lc.get(l["name"], 0) + 1
    top_labels = ", ".join(f"{n}({c})" for n, c in sorted(lc.items(), key=lambda x: -x[1])[:15])

    oldest_ss = sorted(ss, key=lambda i: -age(i))[:10]
    oldest_open = sorted([i for i in open_i if i not in ss], key=lambda i: -age(i))[:20]
    newest = sorted(open_i, key=lambda i: i["created_at"], reverse=True)[:30]

    ctx = f"""REPOSITORY: pucardotorg/dristi  (PUCAR v1.0 Court Case Management System)
DATA AS OF: {now.date().isoformat()}

=== AGGREGATE STATS ===
Total issues (excl. PRs): {len(all_i)}
Open: {len(open_i)}  |  Closed: {len(closed)}
Stale (30d+ no update, excl. Done): {len(stale)}  ({round(len(stale)/max(len(open_i),1)*100)}%)
Open Showstoppers: {len(ss)}
  - 30d+ old: {sum(1 for i in ss if age(i) > 30)}
  - 90d+ old: {sum(1 for i in ss if age(i) > 90)}

=== PROJECT STATUS BREAKDOWN (open issues) ===
{chr(10).join(f"  {k}: {v}" for k, v in sorted(status_counts.items(), key=lambda x: -x[1]))}

=== TOP ASSIGNEES (open issues) ===
{top_assignees}

=== TOP LABELS (open issues) ===
{top_labels}

=== OLDEST OPEN SHOWSTOPPERS (top 10) ===
{chr(10).join(f"  #{i['number']} [{age(i)}d] [{i.get('project_status') or 'no status'}] {i['title']}" for i in oldest_ss) or "  (none)"}

=== OLDEST OPEN ISSUES — non-showstopper (top 20) ===
{chr(10).join(f"  #{i['number']} [{age(i)}d] [{i.get('project_status') or 'no status'}] {i['title']}" for i in oldest_open)}

=== 30 NEWEST OPEN ISSUES ===
{chr(10).join(f"  #{i['number']} [{i.get('project_status') or 'no status'}] {i['title']}" for i in newest)}
"""
    return ctx.strip()


def load_previous(out_path):
    """Return the previous analysis.json content, or {} if not available."""
    try:
        with open(out_path) as f:
            return json.load(f)
    except Exception:
        return {}

def main():
    data_dir  = os.path.join(os.path.dirname(__file__), "..", "data")
    in_path   = os.path.join(data_dir, "issues.json")
    out_path  = os.path.join(data_dir, "analysis.json")

    previous = load_previous(out_path)

    with open(in_path) as f:
        payload = json.load(f)

    issues  = payload.get("issues", [])
    context = build_context(issues)

    prompt = f"""You are a senior engineering program manager reviewing GitHub issue health data for an open-source court case management system (PUCAR v1.0).

Here is the current issue health data:

{context}

Please provide:
1. **Overall health assessment** (2–3 sentences)
2. **Top 3 risks** that need immediate attention
3. **Actionable recommendations** (bullet points, specific and concrete)
4. **Positive signals** (what's going well)

Be concise and direct. Focus on what matters most for a small engineering team."""

    try:
        print("Calling OpenRouter for AI analysis…")
        resp = requests.post(
            OR_URL,
            headers={"Authorization": f"Bearer {OPENROUTER_KEY}", "Content-Type": "application/json"},
            json={"model": OR_MODEL, "messages": [{"role": "user", "content": prompt}], "max_tokens": 1200},
            timeout=60,
        )
        resp.raise_for_status()
        analysis_text = resp.json()["choices"][0]["message"]["content"]
        print(f"  Analysis generated ({len(analysis_text)} chars).")

        output = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "model":        OR_MODEL,
            "analysis":     analysis_text,
            "stale":        False,
        }
    except Exception as e:
        print(f"  WARNING: AI analysis failed — {e}", file=sys.stderr)
        print(f"  Preserving previous analysis with stale=true.")
        output = {
            **previous,
            "stale":       True,
            "stale_reason": str(e),
        }

    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)
    print(f"  Written to {out_path}")


if __name__ == "__main__":
    main()
