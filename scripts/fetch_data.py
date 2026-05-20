"""
fetch_data.py
Fetches all issues (REST) + PUCAR project status (GraphQL) from GitHub,
merges them, and writes data/issues.json.

Run locally:  GH_TOKEN=your_token python scripts/fetch_data.py
Run in CI:    Uses the GH_TOKEN environment variable set by GitHub Actions.
"""

import os, sys, json, time, requests
from datetime import datetime, timezone

GH_TOKEN = os.environ.get("GH_TOKEN", "")
if not GH_TOKEN:
    print("ERROR: GH_TOKEN environment variable is not set.", file=sys.stderr)
    sys.exit(1)

REPO  = "pucardotorg/dristi"
ORG   = "pucardotorg"
PROJECT_NAME = "PUCAR v1.0 Court Case Management System"

REST_HEADERS    = {"Authorization": f"token {GH_TOKEN}", "Accept": "application/vnd.github.v3+json"}
GRAPHQL_HEADERS = {"Authorization": f"token {GH_TOKEN}", "Content-Type": "application/json"}
GRAPHQL_URL     = "https://api.github.com/graphql"


# ── REST: fetch all issues ────────────────────────────────────

def fetch_all_issues():
    issues, page = [], 1
    while True:
        print(f"  REST page {page} ({len(issues)} so far)…")
        r = requests.get(
            f"https://api.github.com/repos/{REPO}/issues",
            headers=REST_HEADERS,
            params={"state": "all", "per_page": 100, "page": page},
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        issues.extend(batch)
        if len(batch) < 100:
            break
        page += 1
        time.sleep(0.1)   # be polite to the API
    return issues


def slim_issue(i):
    """Keep only the fields the dashboard needs — saves ~90% storage."""
    return {
        "id":          i["id"],
        "number":      i["number"],
        "title":       i["title"],
        "state":       i["state"],
        "created_at":  i["created_at"],
        "updated_at":  i["updated_at"],
        "closed_at":   i.get("closed_at"),
        "comments":    i.get("comments", 0),
        "pull_request": bool(i.get("pull_request")),
        "labels":      [{"name": l["name"]} for l in i.get("labels", [])],
        "assignee":    {"login": i["assignee"]["login"]} if i.get("assignee") else None,
        "assignees":   [{"login": a["login"]} for a in i.get("assignees", [])],
    }


# ── GraphQL: fetch project status ────────────────────────────

FIND_PROJECT_QUERY = """
query($org: String!) {
  organization(login: $org) {
    projectsV2(first: 20) {
      nodes { id title }
    }
  }
}
"""

PROJECT_ITEMS_QUERY = """
query($projectId: ID!, $cursor: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          content {
            ... on Issue { number }
          }
          fieldValues(first: 20) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2SingleSelectField { name } }
              }
              ... on ProjectV2ItemFieldIterationValue {
                title
                field { ... on ProjectV2IterationField { name } }
              }
            }
          }
        }
      }
    }
  }
}
"""


def graphql(query, variables):
    r = requests.post(GRAPHQL_URL, headers=GRAPHQL_HEADERS,
                      json={"query": query, "variables": variables})
    r.raise_for_status()
    data = r.json()
    if "errors" in data:
        raise RuntimeError(f"GraphQL errors: {data['errors']}")
    return data["data"]


def find_project_id():
    data = graphql(FIND_PROJECT_QUERY, {"org": ORG})
    projects = data["organization"]["projectsV2"]["nodes"]
    for p in projects:
        if PROJECT_NAME.lower() in p["title"].lower():
            print(f"  Found project: '{p['title']}' (id={p['id']})")
            return p["id"]
    print(f"  WARNING: project '{PROJECT_NAME}' not found. Available: {[p['title'] for p in projects]}")
    return None


def fetch_project_status(project_id):
    """Returns dict: issue_number (int) -> {status, sprint, ...}"""
    status_map = {}
    cursor = None
    page = 1
    while True:
        print(f"  GraphQL project items page {page} ({len(status_map)} items so far)…")
        data = graphql(PROJECT_ITEMS_QUERY, {"projectId": project_id, "cursor": cursor})
        items_data = data["node"]["items"]
        for item in items_data["nodes"]:
            content = item.get("content") or {}
            number = content.get("number")
            if not number:
                continue
            fields = {}
            for fv in (item.get("fieldValues") or {}).get("nodes", []):
                field_name = (fv.get("field") or {}).get("name", "")
                value = fv.get("name") or fv.get("title") or ""
                if field_name and value:
                    fields[field_name] = value
            if fields:
                status_map[number] = fields
        page_info = items_data["pageInfo"]
        if not page_info["hasNextPage"]:
            break
        cursor = page_info["endCursor"]
        page += 1
        time.sleep(0.1)
    return status_map


# ── Main ──────────────────────────────────────────────────────

def main():
    out_path = os.path.join(os.path.dirname(__file__), "..", "data", "issues.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    print("Fetching issues via REST…")
    raw_issues = fetch_all_issues()
    print(f"  Total items fetched: {len(raw_issues)}")

    print("Fetching project status via GraphQL…")
    project_id = find_project_id()
    status_map = {}
    if project_id:
        status_map = fetch_project_status(project_id)
        print(f"  Project items with fields: {len(status_map)}")
    else:
        print("  Skipping project status fetch.")

    print("Merging and slimming data…")
    issues = []
    for i in raw_issues:
        slim = slim_issue(i)
        # Merge in project fields (Status, Sprint, etc.)
        project_fields = status_map.get(slim["number"], {})
        if project_fields:
            slim["project_status"] = project_fields.get("Status") or project_fields.get("status")
            slim["project_sprint"] = project_fields.get("Sprint") or project_fields.get("Iteration")
            slim["project_fields"] = project_fields  # keep all fields for the AI
        else:
            slim["project_status"] = None
            slim["project_sprint"] = None
            slim["project_fields"] = {}
        issues.append(slim)

    output = {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "repo": REPO,
        "project": PROJECT_NAME,
        "total": len(issues),
        "issues": issues,
    }

    with open(out_path, "w") as f:
        json.dump(output, f, separators=(",", ":"))

    size_kb = os.path.getsize(out_path) // 1024
    print(f"Done. Wrote {len(issues)} issues to {out_path} ({size_kb} KB)")


if __name__ == "__main__":
    main()
