import { toastManager } from "@/components/ui/toast";

// DESIGN.md toasts: an outcome closes after 5 seconds. An error, or a toast with an action such as
// Undo, stays until the viewer closes it, so nobody misses what went wrong or what they can undo.
export type Notice =
  | { kind: "done"; title: string }
  | { kind: "failed"; title: string; description?: string }
  | { kind: "action"; title: string; action: { label: string; onClick: () => void } };

const CLOSE_AFTER_MS = 5000;
const STAY = 0;

// SHL-FR-13: every v2 outcome goes through here, never through a browser alert.
export function notify(notice: Notice): string {
  switch (notice.kind) {
    case "done":
      return toastManager.add({ title: notice.title, type: "success", timeout: CLOSE_AFTER_MS });
    case "failed":
      return toastManager.add({ title: notice.title, description: notice.description, type: "error", timeout: STAY });
    case "action":
      return toastManager.add({
        title: notice.title,
        type: "info",
        timeout: STAY,
        actionProps: { children: notice.action.label, onClick: notice.action.onClick },
      });
    default: {
      const unhandled: never = notice;
      return unhandled;
    }
  }
}
