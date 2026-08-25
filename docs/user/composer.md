# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, T3 Code keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

On desktop, press `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux from a new thread to
start it in the background. T3 Code opens another new thread and shows an **Open** action for the
thread that started. The new thread keeps the selected workspace mode and base branch. If **New
worktree** is selected, each background thread creates its own worktree.

## Rewinding a conversation

Type `/tree` in the composer to rewind a thread to an earlier message. The picker lists each
message you have sent, newest first, along with how many turns and files that point discards.
Choosing one removes every message after it from the thread.

Two options control what else the rewind takes with it. Both start off, so a rewind touches only
the conversation unless you say otherwise:

- **Also restore code changes** returns the working tree to how it looked at that point. Leave it
  off to rewind only the conversation and keep your current files.
- **Keep a summary of the discarded work** leaves the agent a short note listing the prompts that
  were undone and the files each one touched. The note travels with your next message, so the
  agent knows what was already tried instead of repeating it.

Rewinding cannot be undone, and it is unavailable while a turn is running — interrupt the turn
first. Threads in a project that is not a Git repository cannot restore code changes, since there
are no checkpoints to restore from.
