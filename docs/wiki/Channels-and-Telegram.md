# Channels and Telegram

Channels announce what needs you and, for some, let you answer. They get the command, run, node and role, never file contents, diffs or tool output. Failed deliveries retry with backoff through a persistent outbox.

- **macOS notifications** (`osascript`, or `terminal-notifier` when installed). On by default on macOS.
- **Telegram** with Approve / Deny buttons, reports, and a conversation with the orchestrator.
- **GitHub**: a run asked from an issue (`shibaox run --issue N`) reports back as a comment on it; never asks approvals there (`channels.github.enabled: false` in `daemon.yaml` turns it off).

## Setting up Telegram

### From the app

1. Create a bot with @BotFather (Customize → Plugins → Telegram → **Create a bot**) and note its token.
2. Paste the token on the Telegram card (or `shibaox keys set SHIBAOX_TELEGRAM_TOKEN 123:abc`): it goes to the vault.
3. Click **Pair with my Telegram**, then open your bot in Telegram and send `/start` within a minute. The daemon long polls the Bot API for that message, writes its chat to `channels.telegram.chat_id` in `~/.shibaox/daemon.yaml` (comments and the other keys kept) and starts the channel on it at once: no restart. The card says **Paired with chat <id>**, or why not (no message arrived in 60 s, Telegram refused the token…). Messages the bot received before the pairing are consumed, never answered later; a `/start` is preferred when several arrive together. One pairing at a time.
4. **Send a test message** checks the whole path: the bot writes "Shibaox ✓ test message from the app" to the paired chat.

The card is **Ready** only when the token is saved, a chat is paired and the channel is running. Pairing writes `daemon.yaml`, so it works from the daemon's own machine only (see [Security](Security)); the test message works from any client.

Same thing over the API: `POST /plugins/telegram/actions/pair` (optional `{ "timeoutMs": … }`, up to 120 000) answers `{ paired: true, chatId, from? }` or `{ paired: false, reason }`; `POST /plugins/telegram/actions/test` answers `{ sent: true, chatId }`, or 409 `not_paired` / `no_token`.

### By hand

The chat id can still be written yourself (message the bot, then read `getUpdates`, or use @userinfobot):

1. Put the token in the vault: `shibaox keys set SHIBAOX_TELEGRAM_TOKEN 123:abc`. The channel starts polling at once; remove the key and it stops; change it and it restarts. No daemon restart.
2. In `~/.shibaox/daemon.yaml`:

```yaml
channels:
  telegram:
    chat_id: 123456789
    org: ./org                 # relative paths resolve next to daemon.yaml
    project: /path/to/project  # optional: pin text messages to this org and project
    workflow: chat             # default
    # adapter: claude-code
    # bot_token_env: SHIBAOX_TELEGRAM_TOKEN   # default
```

`org` and `project` are not written by the pairing and are optional: without them a text message runs on the daemon's home org and home workspace (the same place a new chat without a project uses); set them to pin the chat to one org and project.

`shibaox doctor` checks the token with `getMe`.

## Sending from a conversation

Roles with `telegram` in their `tools` get the daemon's `telegram_send(text)` tool (the scaffold's `assistant` has it): "send me a Telegram when the build is done" works. The text goes to the paired chat as plain text (escaped, split under Telegram's limit) through the daemon; the bot token never reaches the model. When nothing is paired the tool says "Telegram is not paired: Customize → Plugins → Telegram → Pair". An org created before this release adds `telegram` to `org/roles/assistant.yaml` `tools` by hand.

## Approvals

Every human node and tool approval arrives as a message with Approve and Deny. The first answer wins; the message is edited to say who answered and how.

## Talking from your phone

Any text you send the bot from your **private** chat (groups are ignored: the orchestrator writes to the project) is a turn for the orchestrator, one at a time; texts sent while it answers wait their turn. The reply comes back to the chat, and workflows it dispatches report their end there too. `/status` answers with the daemon, its runs and what needs you; `/help` lists this.

The thread lives in memory (a restart forgets it; the orchestrator's `remember` notes do not) and is compacted like any long conversation. Messages that piled up while the daemon was down: only the last one is answered, and the chat is told how many were skipped.
