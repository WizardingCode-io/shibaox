# Channels and Telegram

Channels announce what needs you and, for some, let you answer. They get the command, run, node and role, never file contents, diffs or tool output. Failed deliveries retry with backoff through a persistent outbox.

- **macOS notifications** (`osascript`, or `terminal-notifier` when installed). On by default on macOS.
- **Telegram** with Approve / Deny buttons, reports, and a conversation with the orchestrator.
- **GitHub**: a run asked from an issue (`shibaox run --issue N`) reports back as a comment on it; never asks approvals there (`channels.github.enabled: false` in `daemon.yaml` turns it off).

## Setting up Telegram

1. Create a bot with @BotFather and note its token; find your chat id (message the bot, then read `getUpdates`, or use @userinfobot).
2. Put the token in the vault: `shibaox keys set SHIBAOX_TELEGRAM_TOKEN 123:abc`. The channel starts polling at once; remove the key and it stops; change it and it restarts. No daemon restart.
3. In `~/.shibaox/daemon.yaml`:

```yaml
channels:
  telegram:
    chat_id: 123456789
    org: ./org                 # relative paths resolve next to daemon.yaml
    project: /path/to/project  # with org + project, text messages talk to the orchestrator
    workflow: chat             # default
    # adapter: claude-code
    # bot_token_env: SHIBAOX_TELEGRAM_TOKEN   # default
```

`shibaox doctor` checks the token with `getMe`.

## Approvals

Every human node and tool approval arrives as a message with Approve and Deny. The first answer wins; the message is edited to say who answered and how.

## Talking from your phone

Any text you send the bot from your **private** chat (groups are ignored: the orchestrator writes to the project) is a turn for the orchestrator, one at a time; texts sent while it answers wait their turn. The reply comes back to the chat, and workflows it dispatches report their end there too. `/status` answers with the daemon, its runs and what needs you; `/help` lists this.

The thread lives in memory (a restart forgets it; the orchestrator's `remember` notes do not) and is compacted like any long conversation. Messages that piled up while the daemon was down: only the last one is answered, and the chat is told how many were skipped.
