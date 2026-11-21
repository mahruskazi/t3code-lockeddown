import type { OrchestrationV2PlanStep } from "@t3tools/contracts";

// Pi has no built-in checklist. Extensions that offer one use Claude's TodoWrite
// shape under this name: `{ todos: [{ content, status }] }`, replacing the list each call.
export const PI_TODO_TOOL = "todo_write";

export function piTodoSteps(args: unknown): ReadonlyArray<OrchestrationV2PlanStep> | null {
  const todos = typeof args === "object" && args !== null ? Reflect.get(args, "todos") : undefined;
  if (!Array.isArray(todos)) return null;
  return todos.flatMap((todo, index) => {
    if (typeof todo !== "object" || todo === null) return [];
    const content = Reflect.get(todo, "content");
    const text = typeof content === "string" ? content.trim() : "";
    if (text.length === 0) return [];
    const status = Reflect.get(todo, "status");
    return [
      {
        id: `todo-${index}`,
        text,
        status:
          status === "completed" ? "completed" : status === "in_progress" ? "running" : "pending",
      },
    ];
  });
}
