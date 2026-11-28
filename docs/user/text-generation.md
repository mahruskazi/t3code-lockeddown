# Text generation models

T3 Code uses an LLM for lightweight background text tasks: thread titles, branch names, commit messages, PR titles/descriptions, and voice transcript cleanup. Configure the default in **Settings → Threads → Text generation model** (overridable separately in **Settings → Source control & issues** and **Settings → Voice**).

A coding agent such as Codex or Claude writes this text, starting a session for each request.

This build does not send text to model APIs directly, because the input can include your code, such
as the staged diff for a commit message. **Settings → Providers → Text generators** is still shown,
but every generator fails its connection check, so keep each text task on a coding agent. The rest
of this page describes the feature as it works elsewhere.

## Add a text generator

Open **Settings → Providers → Text generators → Add generator** (stored per environment; API keys support [Secrets](./secrets.md)):

- **OpenAI** or **Anthropic**: Enter an API key.
- **OpenRouter**: Enter an OpenRouter API key to use any model it serves.
- **Custom (OpenAI-compatible)**: Enter a base URL (e.g. Ollama at `http://localhost:11434/v1` or LM Studio—`localhost` resolves on the environment's server).

Click **Test** beside a model picker to verify the key works, or **Show models** to refresh the catalog. Disabling or removing a generator falls back to the environment's default text generation model.

## Limitations

- **Review guides** always require a coding agent (Codex or Claude), not a text generator—choose one under **Settings → Source control & issues → Review guide model**.
- A [managed policy](./managed-policy.md) that restricts providers also disables text generators.
