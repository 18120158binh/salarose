"use server";

import { revalidatePath } from "next/cache";
import * as db from "@/lib/db";
import { assertAdmin } from "@/shared/auth/session";
import { DuplicateEventNameError, parseEventStatus } from "shared/lib/eventCatalog";
import { UserFacingError, userFacingMessage } from "shared/lib/userFacingError";

// The event catalog's changes in studio v2 (CAT-FR-10, DHL-FR-12). Each one checks the session and
// the admin role itself, parses what the browser sent, and reports a failure as { error } with the
// catalog's own message, so a refusal names its uses (CAT-FR-11, CAT-FR-12).

type Failed = { error: string };
type Done = { done: true };

type NewAttribute = { field_path: string; display_name: string; data_type: string; example_value?: string };

async function run<T>(action: string, work: () => Promise<T>): Promise<T | Failed> {
  try {
    await assertAdmin();
    const result = await work();
    revalidatePath("/v2/data/events", "layout");
    return result;
  } catch (error) {
    console.error(`Failed to ${action}:`, error);
    return { error: userFacingMessage(error, `Failed to ${action}.`) };
  }
}

function string(value: unknown, what: string): string {
  if (typeof value !== "string") throw new UserFacingError(`The ${what} is missing.`);
  return value;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function bool(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw new UserFacingError(`The ${what} must be on or off.`);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function attributes(value: unknown): NewAttribute[] {
  if (!Array.isArray(value)) throw new UserFacingError("The attributes are missing.");
  return value.map((item) => {
    const input = record(item);
    return {
      field_path: string(input.path, "attribute path"),
      display_name: optionalString(input.label),
      data_type: string(input.type, "attribute type"),
      example_value: optionalString(input.example),
    };
  });
}

/** CAT-FR-01, CAT-FR-02, CAT-FR-18: studio v2 creates person events only, whatever the browser sends. */
/** A name the catalog already has, with the event that holds it, so the form can link to it. */
export type DuplicateName = Failed & { existing: { id: string; label: string; name: string } };

export async function createEventAction(input: unknown): Promise<{ eventId: string } | Failed | DuplicateName> {
  return run("create the event", async () => {
    const event = record(input);
    try {
      const eventId = await db.createUserEventWithFields(
        string(event.name, "system name"),
        optionalString(event.displayName),
        optionalString(event.description),
        { kind: "person" },
        attributes(event.attributes),
      );
      return { eventId };
    } catch (error) {
      if (!(error instanceof DuplicateEventNameError)) throw error;
      const existing = await db.findUserEventByName(error.eventName);
      if (existing === null) throw error;
      return { error: error.message, existing: { ...existing, name: error.eventName } };
    }
  });
}

/** CAT-FR-05: the display name and the description. The kind and the system name stay. */
export async function updateEventDetailsAction(id: unknown, displayName: unknown, description: unknown): Promise<Done | Failed> {
  return run("save the event", async () => {
    await db.updateUserEventDetails(string(id, "event"), string(displayName, "display name"), optionalString(description));
    return { done: true } as const;
  });
}

export async function setEventStatusAction(id: unknown, status: unknown): Promise<Done | Failed> {
  return run("change the event status", async () => {
    await db.setUserEventStatus(string(id, "event"), parseEventStatus(status));
    return { done: true } as const;
  });
}

/** CAT-FR-13. */
export async function setEventGateAction(id: unknown, on: unknown): Promise<Done | Failed> {
  return run("change the schema gate", async () => {
    await db.setUserEventSchemaEnforcement(string(id, "event"), bool(on, "schema gate"));
    return { done: true } as const;
  });
}

/** CAT-FR-14. */
export async function setAttributeRequiredAction(id: unknown, path: unknown, required: unknown): Promise<Done | Failed> {
  return run("change whether the attribute is required", async () => {
    await db.setUserEventFieldRequired(string(id, "event"), string(path, "attribute path"), bool(required, "Required box"));
    return { done: true } as const;
  });
}

/** CAT-FR-03: one attribute, or the ones a sample payload gives. A path the event has is refused. */
export async function addAttributesAction(id: unknown, input: unknown): Promise<Done | Failed> {
  return run("add the attributes", async () => {
    await db.addUserEventFields(string(id, "event"), attributes(input));
    return { done: true } as const;
  });
}

/** CAT-FR-04, CAT-FR-06, CAT-FR-11: a rename of an attribute in use is refused with its uses. */
export async function updateAttributeAction(id: unknown, originalPath: unknown, changes: unknown): Promise<Done | Failed> {
  return run("save the attribute", async () => {
    const input = record(changes);
    await db.updateUserEventField(
      string(id, "event"),
      string(originalPath, "attribute path"),
      string(input.path, "attribute path"),
      optionalString(input.label),
      string(input.type, "attribute type"),
      optionalString(input.example),
      optionalString(input.defaultValue),
    );
    return { done: true } as const;
  });
}

/** CAT-FR-12: the attribute and its subtree, refused with its uses while any exists. */
export async function deleteAttributeAction(id: unknown, path: unknown): Promise<Done | Failed> {
  return run("delete the attribute", async () => {
    await db.deleteUserEventField(string(path, "attribute path"), string(id, "event"));
    return { done: true } as const;
  });
}

/** CAT-FR-08: the page lists the uses in its confirmation before it calls this. */
export async function deleteEventAction(id: unknown): Promise<Done | Failed> {
  return run("delete the event", async () => {
    await db.deleteUserEvent(string(id, "event"));
    return { done: true } as const;
  });
}
