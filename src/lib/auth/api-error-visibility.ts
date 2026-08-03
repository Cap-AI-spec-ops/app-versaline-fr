export type WorkspaceRole = "agent" | "team_lead" | "owner" | "super_admin";

export function buildRoleAwareApiError(options: {
  role: WorkspaceRole | null | undefined;
  technicalMessage: string;
  fallbackMessage: string;
}) {
  if (options.role === "super_admin") {
    return options.technicalMessage;
  }

  return options.fallbackMessage;
}
