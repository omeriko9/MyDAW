/**
 * Browser tab / window title for the main app window (owned by U2).
 *
 * "ProjectName — MyDAW" with a leading "● " while there are unsaved changes, so the
 * project (and its dirty state) is readable from the taskbar / tab strip — matching
 * what native DAWs put in their title bar. No project → plain "MyDAW".
 */

export const APP_NAME = "MyDAW";

export function windowTitle(projectName: string | null | undefined, dirty: boolean): string {
  const name = (projectName ?? "").trim();
  const body = name.length > 0 ? `${name} — ${APP_NAME}` : APP_NAME;
  return dirty ? `● ${body}` : body;
}
