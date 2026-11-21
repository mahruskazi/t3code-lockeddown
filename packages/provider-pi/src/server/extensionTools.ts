import type { OrchestrationV2WebSearchResult } from "@t3tools/contracts";

// Pi ships no web or background-shell tools, so popular extensions pick their own names.
// Each mapping also checks the argument shape, so an unrelated tool with the name stays generic.
const WEB_SEARCH_TOOLS = new Set(["web_search", "search"]);
const WEB_FETCH_TOOLS = new Set(["web_fetch", "fetch", "scrape"]);
const BACKGROUND_SHELL_TOOL = "background_shell";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function searchResults(output: string): ReadonlyArray<OrchestrationV2WebSearchResult> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  return parsed.flatMap((entry) => {
    const url = text(field(entry, "url"));
    const title = text(field(entry, "title"));
    const snippet = text(field(entry, "description")) ?? text(field(entry, "snippet"));
    if (url === undefined && title === undefined) return [];
    return [
      {
        ...(title === undefined ? {} : { title }),
        ...(url === undefined ? {} : { url }),
        ...(snippet === undefined ? {} : { snippet }),
      },
    ];
  });
}

export function piWebSearchItem(
  toolName: string,
  args: unknown,
  output: string,
): {
  readonly patterns: ReadonlyArray<string>;
  readonly results?: ReadonlyArray<OrchestrationV2WebSearchResult>;
} | null {
  if (WEB_SEARCH_TOOLS.has(toolName)) {
    const query = text(field(args, "query"));
    if (query === undefined || field(args, "path") !== undefined) return null;
    const results = searchResults(output);
    return { patterns: [query], ...(results === undefined ? {} : { results }) };
  }
  if (WEB_FETCH_TOOLS.has(toolName)) {
    const url = text(field(args, "url"));
    if (url === undefined || !/^https?:\/\//i.test(url)) return null;
    return { patterns: [url] };
  }
  return null;
}

/** A background_shell `start` launches a command; its other actions manage the job. */
export function piBackgroundCommand(
  toolName: string,
  args: unknown,
  details: unknown,
): { readonly command: string; readonly exitCode?: number } | null {
  if (toolName !== BACKGROUND_SHELL_TOOL || field(args, "action") !== "start") return null;
  const command = text(field(args, "command"));
  if (command === undefined) return null;
  const exitCode = field(details, "exitCode");
  return {
    command,
    ...(typeof exitCode === "number" && Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}
