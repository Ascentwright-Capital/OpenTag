#!/bin/sh
# Claude Code PreToolUse hook: refuses a commit, pull request, issue or comment that credits an AI.
# Copy to .claude/hooks/block-ai-credit.sh; templates/claude-settings.json wires it up.
# The rule is in standards.md: Ken is the sole author.
#
# Blocked: Co-Authored-By an AI tool, "Generated with/by <AI tool>", Claude-Session lines, Claude
# session and product links, noreply@anthropic.com (also as commit author), and "Requested by" lines.
# Exit 2 refuses the tool call and hands the message on stderr back to the agent.

payload=$(cat)

ai='claude|anthropic|copilot|chatgpt|openai|codex|cursor|gemini|devin|aider'
credit="co-authored-by:[^\"\\\\]*($ai)|(generated|written|authored|created|built|made) (with|by)[^\"\\\\]*($ai)|claude-session:|claude\\.ai/code/session|claude\\.com/claude-code|noreply@anthropic\\.com"

# The same patterns, anchored inside the JSON string fields that become commit or pull request text.
field='"(command|title|body|message|commit_title|commit_message)"[[:space:]]*:[[:space:]]*"'
inside='([^"\\]|\\.)*'
lead='[>*_[:space:]-]*requested[- ]by'
# "Requested by" counts at the start of a line or of a quoted argument, not in the middle of a sentence.
requested="$field($inside(\\\\n|\\\\\"|'))?$lead"

has() { printf '%s' "$payload" | grep -Eqi -e "$1"; }

refuse() {
  echo "Blocked: $1 credits an AI or names a requester. Ken is the sole author (agent-harness standards.md)." >&2
  echo "Remove every Co-Authored-By, Generated with, Claude-Session and Requested by line, and any Claude link, then retry." >&2
  exit 2
}

if has '"tool_name"[[:space:]]*:[[:space:]]*"Bash"'; then
  # Shell commands: only the ones that write commit, tag, pull request or issue text.
  has "git[[:space:]]([^;&|]*[[:space:]])?(commit|merge|tag|notes|revert|cherry-pick)|gh[[:space:]]+(pr|issue|release|api)" &&
    { has "$field$inside($credit)" || has "$requested"; } &&
    refuse "this command"
else
  { has "$field$inside($credit)" || has "$requested"; } && refuse "this text"
fi

# Before a push or a new pull request, check the commits that are not on any remote yet. This
# catches a message that came from a file or an editor, and a commit authored as an AI.
if has 'git[[:space:]]([^;&|]*[[:space:]])?push|gh[[:space:]]+pr[[:space:]]+create|"tool_name"[[:space:]]*:[[:space:]]*"mcp__github__create_pull_request"'; then
  if git rev-parse --git-dir >/dev/null 2>&1; then
    bad=$(git log HEAD --not --remotes --format='%h author %an <%ae>, committer %cn <%ce>%n%s%n%b' 2>/dev/null |
      grep -Ei -e "$credit" -e "^$lead" | head -5)
    if [ -n "$bad" ]; then
      echo "$bad" >&2
      echo "If the author or committer is an AI, set git user.name and user.email to the person you work for and re-author the commit: GitHub turns other authors into Co-authored-by lines on a squash merge." >&2
      refuse "an unpushed commit"
    fi
  fi
fi

exit 0
