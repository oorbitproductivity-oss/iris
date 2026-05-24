# Skills

Iris Code learns *skills* — procedural recipes that the agent can recall
later when it sees a similar problem. They are stored under
`<userData>/iris-code/skills/<slug>.md` and follow the
[agentskills.io](https://agentskills.io) open format so they can be
shared with other Hermes-compatible runtimes.

## File format

```markdown
---
name: refactor-react-component
description: Split a fat React component into smaller pieces.
tags: [react, refactor]
created: 2026-05-19T10:23:45Z
---

1. Identify state that doesn't need to live at the top.
2. Extract a child component for each visual region.
3. Pass props down explicitly; no context shortcuts.
4. Verify with a render test.
```

The body is plain markdown — there are no required headings. The agent
loads it verbatim into the system prompt under `<context>` when the
skill is matched.

## How matching works

When Hermes mode is active for a turn (slash `/hermes`, flag
`--hermes`, or the router picked `agentic`), `Skills.match(userText)`
scores every skill's `name + description + tags + body` against the
tokens in the user's message and returns the top three.

You can narrow the pool with `--skills <pattern>` on the CLI, which
filters by substring against the skill name and tags.

## Writing skills by hand

```bash
mkdir -p ~/.config/iris-code/skills    # or %APPDATA%\iris-code\skills on Windows
$EDITOR ~/.config/iris-code/skills/my-skill.md
```

That's it — drop the YAML frontmatter at the top and Iris will pick the
file up on next launch. No restart needed if you're using the CLI; the
GUI reloads on next agent session.

## Auto-learning (the reflection pass)

After a completed agentic turn, `Skills.reflect({userText, assistantText})`
scans the assistant's reply for a "numbered procedure" shape (≥3
numbered or bulleted steps and a non-trivial user ask). If it finds one,
it proposes a candidate skill named `learned-<slugified user ask>` and
shows the user:

```
Hermes proposes a new skill: learned-split-a-react-component — accept? [y/N]
```

Accepting writes it to disk; rejecting drops it. You can edit or delete
skills any time — the matching pass always reads the on-disk version,
so there's no separate "rebuild" step.

## Inspecting

CLI:

```bash
iris chat
> /skills              # list loaded skills
> /memory              # show recent memory records
```

GUI: open the **Skill browser** pane in the sidebar.

## Why files, not a database

Skills are deliberately stored as standalone markdown files so:

1. You can `cat`, `grep`, `diff`, and version-control them.
2. You can move them between machines with `rsync` or git.
3. You can share a `.md` with someone else's Hermes-compatible agent.
4. There is no migration when the skill format evolves — just edit the
   files.

The memory log uses JSONL for the same reason.
