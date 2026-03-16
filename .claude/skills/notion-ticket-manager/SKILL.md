---
name: notion-ticket-manager
description: Manage Notion tasks and tickets via the Notion API. Use this skill whenever the user wants to create, view, update, delete, or organize tasks/tickets in Notion — including creating new tasks with priorities/labels/due dates, listing or filtering tasks by status, updating ticket status or assignee, searching for tasks by keyword, or building any Notion-based project management workflow. Trigger on phrases like "create a Notion task", "add a ticket", "update my task", "show my Notion todos", "mark as done", "what's in my backlog", "move task to in progress", or any request involving task/project management in Notion. Also trigger when the user wants to bulk-manage, query, or report on their Notion task database. When in doubt, use this skill — it covers the full CRUD lifecycle for Notion tasks.
---

# Notion Ticket Manager Skill

A skill for creating, reading, updating, and managing tasks/tickets in a Notion database via the Notion REST API.

---

## Setup & Authentication

Before any operation, Claude must ensure the user has:

1. **Notion Integration Token** — from https://www.notion.so/my-integrations
   - Create an integration, copy the "Internal Integration Token" (starts with `secret_`)
2. **Database ID** — the 32-char ID from the Notion database URL:
   - URL format: `https://www.notion.so/{workspace}/{DATABASE_ID}?v=...`
   - Extract the ID between the last `/` and `?`
3. **Database shared with integration** — in Notion, open the database → `...` menu → `Add connections` → select your integration

If the user hasn't provided these, ask for them before proceeding. Store them as variables for the session.

**Base headers for all requests:**
```javascript
const headers = {
  "Authorization": `Bearer ${NOTION_TOKEN}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json"
};
```

---

## Database Schema

A standard task database should have these properties. When creating a new database or helping the user set one up, use this schema:

| Property Name | Type        | Notes                                      |
|--------------|-------------|---------------------------------------------|
| Name/Title   | title       | Task name (required)                        |
| Status       | select      | Options: `Backlog`, `Todo`, `In Progress`, `In Review`, `Done`, `Blocked` |
| Priority     | select      | Options: `P0 - Critical`, `P1 - High`, `P2 - Medium`, `P3 - Low` |
| Tags         | multi_select| e.g. `Smart Contract`, `Frontend`, `Bug`, `Feature`, `Audit`, `EVM`, `NEAR`, `Stellar` |
| Due Date     | date        | ISO 8601 date                               |
| Assignee     | people      | Notion user(s)                              |
| Description  | rich_text   | Task details/notes                          |
| Created      | created_time| Auto-populated                              |
| URL          | url         | Link to PR, issue, or external resource     |

> If the user's database has different property names, adapt the payload keys accordingly. Always ask the user to confirm property names on first use if they're uncertain.

---

## Local-First Rule

**All tasks MUST be created as a local markdown file in `tasks/` before syncing to Notion.**

When creating a task:
1. Write the task to `tasks/<filename>.md` first (use kebab-case, e.g. `tasks/audit-morpho-vault.md`)
2. Use this frontmatter format in the local file:
   ```markdown
   ---
   title: "Task title"
   status: Todo
   priority: P2 - Medium
   tags: [EVM, NEAR]
   due: 2026-03-20
   notion_id: ""
   ---

   Task description here.
   ```
3. Then create the corresponding Notion page via API
4. Update the local file's `notion_id` field with the returned page ID

When updating a task, update BOTH the local file and Notion. The `tasks/` folder is the source of truth.

For bulk task lists (like `tasks/demo.md`), these serve as project-level overviews and do not need individual Notion pages unless the user requests it.

---

## Core Operations

### 1. CREATE a Task

**Endpoint:** `POST https://api.notion.com/v1/pages`

```javascript
const payload = {
  parent: { database_id: DATABASE_ID },
  properties: {
    "Name": {
      title: [{ text: { content: taskName } }]
    },
    "Status": {
      select: { name: status }  // e.g. "Todo"
    },
    "Priority": {
      select: { name: priority }  // e.g. "P1 - High"
    },
    "Tags": {
      multi_select: tags.map(t => ({ name: t }))
    },
    "Due Date": {
      date: { start: dueDate }  // "YYYY-MM-DD"
    },
    "Description": {
      rich_text: [{ text: { content: description } }]
    },
    "URL": {
      url: url || null
    }
  }
};
```

After creation, return the page URL: `response.url`

---

### 2. LIST / QUERY Tasks

**Endpoint:** `POST https://api.notion.com/v1/databases/{DATABASE_ID}/query`

Use filters to narrow results. Combine filters with `and`/`or`.

**Filter by status:**
```javascript
{
  filter: {
    property: "Status",
    select: { equals: "In Progress" }
  }
}
```

**Filter by priority:**
```javascript
{
  filter: {
    property: "Priority",
    select: { equals: "P0 - Critical" }
  }
}
```

**Multiple filters (AND):**
```javascript
{
  filter: {
    and: [
      { property: "Status", select: { does_not_equal: "Done" } },
      { property: "Priority", select: { equals: "P1 - High" } }
    ]
  }
}
```

**Sort by due date:**
```javascript
{
  sorts: [{ property: "Due Date", direction: "ascending" }]
}
```

**Display results as a table** in chat using markdown. Show: Name, Status, Priority, Due Date, Tags.

---

### 3. UPDATE a Task

**Endpoint:** `PATCH https://api.notion.com/v1/pages/{PAGE_ID}`

To update properties, send only the changed fields:

```javascript
// Update status only
const payload = {
  properties: {
    "Status": { select: { name: "Done" } }
  }
};
```

**Getting the page ID:**
- From a previous query response: `page.id`
- From a Notion URL: the UUID after the last `-` in the page URL
- Ask the user for the task name, then query to find it first

---

### 4. SEARCH Tasks by Name

**Endpoint:** `POST https://api.notion.com/v1/search`

```javascript
const payload = {
  query: searchTerm,
  filter: { property: "object", value: "page" },
  sort: { direction: "descending", timestamp: "last_edited_time" }
};
```

---

### 5. DELETE / ARCHIVE a Task

Notion doesn't hard-delete pages via API — it archives them.

**Endpoint:** `PATCH https://api.notion.com/v1/pages/{PAGE_ID}`

```javascript
const payload = { archived: true };
```

---

### 6. GET Task Details

**Endpoint:** `GET https://api.notion.com/v1/pages/{PAGE_ID}`

For page content/body blocks:
**Endpoint:** `GET https://api.notion.com/v1/blocks/{PAGE_ID}/children`

---

## Workflow Patterns

### "Create a task from a conversation"
When the user describes work they need to do, extract:
- Title (concise imperative: "Audit ERC-4626 vault contract")
- Status → default `Todo`
- Priority → infer from urgency language ("critical", "asap" → P0; "soon" → P1; default → P2)
- Tags → infer from tech mentions (EVM, NEAR, Stellar, Solidity, etc.)
- Due date → parse relative dates ("by Friday", "next week") to ISO format
- Description → summarize the full context

Show a preview and ask for confirmation before creating.

### "Show my tasks"
Default view: query all non-Done tasks, sort by Priority then Due Date. Display as table.

### "What's blocking me?"
Query Status = `Blocked`. Show with Description field included.

### "Daily standup view"
Query: Status in [`In Progress`, `In Review`] + due within 7 days. Format as:
- 🔄 In Progress: [task list]
- 👀 In Review: [task list]
- 📅 Due soon: [overdue/this week]

### "Move task to done" / "Close ticket"
Search by name → PATCH Status to `Done`.

### "Bulk update"
For multiple tasks matching a filter (e.g., all `Backlog` P3 tasks), confirm with user before batch-patching.

---

## Error Handling

| HTTP Code | Meaning                        | Action                                      |
|-----------|--------------------------------|---------------------------------------------|
| 401       | Invalid token                  | Ask user to re-check integration token      |
| 403       | Database not shared            | Remind user to add integration to database  |
| 404       | Page/DB not found              | Verify DATABASE_ID or page ID               |
| 400       | Bad request / wrong property   | Check property names match database schema  |
| 429       | Rate limited                   | Wait and retry after a moment               |

Always show the `message` field from Notion's error response to help debug.

---

## Artifact Pattern

When building an interactive UI (e.g., user asks for a "task dashboard" or "kanban board"), generate a React or HTML artifact that:
1. Accepts the Notion token + database ID as inputs
2. Calls the Notion API from the browser via `fetch` to `https://api.notion.com/v1/...`
3. Renders tasks in a kanban-style board or table
4. Supports drag-to-update-status or inline editing

**CORS note:** Notion's API does NOT support browser-side CORS requests directly. For browser-based artifacts, route through a proxy or instruct the user to use a server-side approach. Alternatively, generate a Node.js script they can run locally.

For in-chat operations (no artifact needed), Claude executes API calls via `bash_tool` using `curl` or a Node.js/Python script.

---

## Quick Reference: Bash/curl Examples

```bash
# List all tasks
curl -s -X POST "https://api.notion.com/v1/databases/$DB_ID/query" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{}' | python3 -m json.tool

# Create a task
curl -s -X POST "https://api.notion.com/v1/pages" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{
    "parent": { "database_id": "'"$DB_ID"'" },
    "properties": {
      "Name": { "title": [{ "text": { "content": "My Task" } }] },
      "Status": { "select": { "name": "Todo" } }
    }
  }'

# Update status to Done
curl -s -X PATCH "https://api.notion.com/v1/pages/$PAGE_ID" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{ "properties": { "Status": { "select": { "name": "Done" } } } }'
```

---

## Notes for Smart Contract Engineers

Pre-suggested tags relevant to the user's workflow:
- `EVM`, `Solidity`, `NEAR`, `Stellar`, `Audit`, `Security`, `Gas Optimization`
- `Smart Contract`, `Frontend`, `Integration`, `Testing`, `Deploy`, `Bug`, `Feature`

Common task templates to offer:
- **Audit task**: `Audit [ContractName] for [vuln class]` | Priority P0-P1 | Tag: Audit, Security
- **Feature task**: `Implement [feature]` | Tag: Smart Contract + chain tag
- **Bug task**: `Fix [bug description]` | Priority inferred from severity
- **Review task**: `Review PR #[N] - [description]` | Status: In Review