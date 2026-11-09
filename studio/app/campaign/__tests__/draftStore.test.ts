import { cloneAsDraft, loadDrafts, saveDrafts } from "../draftStore";
import type { Campaign } from "@/entities/journey/model/types";

const draft: Campaign = {
  id: "CAMP-00000000000000a1",
  name: "Cart recovery",
  description: "",
  status: "draft",
  root: {
    type: "setup",
    id: "setup-1",
    label: "Trigger",
    description: "Define journey settings",
    triggerType: "user",
    triggerEventName: "add_to_cart",
    next: { type: "end", goalId: "goal_default" },
  },
  created_at: "2026-10-18T00:00:00.000Z",
  updated_at: "2026-10-18T00:00:00.000Z",
};

beforeEach(() => {
  localStorage.clear();
});

it("returns the drafts a user saved, and none to another user", () => {
  saveDrafts("user_lan", [draft]);

  expect(loadDrafts("user_lan")).toEqual([draft]);
  expect(loadDrafts("user_minh")).toEqual([]);
});

it("drops stored entries that are not drafts and keeps the rest", () => {
  saveDrafts("user_lan", [draft]);
  const key = Object.keys(localStorage).find((name) => localStorage.getItem(name)?.includes(draft.id));
  if (!key) throw new Error("the draft was not stored");
  const stored = JSON.parse(localStorage.getItem(key) ?? "[]");
  localStorage.setItem(key, JSON.stringify([
    ...stored,
    { ...draft, id: "CAMP-active", status: "active" },
    { ...draft, id: 7 },
    { ...draft, id: "CAMP-no-root", root: "setup" },
    "not a campaign",
  ]));

  expect(loadDrafts("user_lan")).toEqual([draft]);
});

it("returns no drafts when the stored value is not JSON", () => {
  saveDrafts("user_lan", [draft]);
  for (const key of Object.keys(localStorage)) localStorage.setItem(key, "{");

  expect(loadDrafts("user_lan")).toEqual([]);
});

it("clones a campaign into a new draft that the user can load", () => {
  const clone = cloneAsDraft("user_lan", { ...draft, status: "active" });

  expect(clone).toMatchObject({ name: "Copy of Cart recovery", status: "draft", root: draft.root });
  expect(clone.id).not.toBe(draft.id);
  expect(loadDrafts("user_lan")).toEqual([clone]);
});
