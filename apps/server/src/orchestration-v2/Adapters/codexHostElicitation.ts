import type { V2TurnStartParams__AskForApproval } from "effect-codex-app-server/schema";

export function withHostElicitation(policy: V2TurnStartParams__AskForApproval, needed: boolean) {
  if (!needed) return policy;
  if (policy === "never")
    return {
      granular: {
        mcp_elicitations: true,
        rules: false,
        sandbox_approval: false,
        request_permissions: false,
        skill_approval: false,
      },
    };
  return typeof policy === "object"
    ? { granular: { ...policy.granular, mcp_elicitations: true } }
    : policy;
}
// An unset policy takes the runtime mode default, and every default asks for MCP elicitations.
export function permitsOrdinaryElicitation(policy: unknown) {
  if (policy === "never") return false;
  return !(
    typeof policy === "object" &&
    policy !== null &&
    "granular" in policy &&
    typeof policy.granular === "object" &&
    policy.granular !== null &&
    "mcp_elicitations" in policy.granular &&
    policy.granular.mcp_elicitations === false
  );
}
