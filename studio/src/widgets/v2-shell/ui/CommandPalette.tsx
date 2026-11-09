"use client";

import { Fragment, useEffect, useEffectEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { PlusIcon, RouteIcon, SearchIcon, UserSearchIcon, UsersRoundIcon, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandDialogPrimitive,
  CommandDialogTrigger,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandSeparator,
} from "@/components/ui/command";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { PreviewBadge } from "@/shared/ui/v2/PreviewBadge";
import type { Reach } from "../model/routes";
import { paletteGroups, type NameSearch, type PaletteItem } from "../model/palette";
import { NAV_ICONS } from "./navIcons";

export type SearchNames = (text: string) => Promise<NameSearch>;

// Long enough to skip a request per keystroke, short enough to feel immediate.
const SEARCH_DELAY_MS = 150;

const ICONS: Record<Exclude<PaletteItem["kind"], "page">, LucideIcon> = {
  create: PlusIcon,
  journey: RouteIcon,
  segment: UsersRoundIcon,
  customer: UserSearchIcon,
};

function iconOf(item: PaletteItem): LucideIcon {
  return item.kind === "page" ? NAV_ICONS[item.page] : ICONS[item.kind];
}

// SHL-FR-07: the search answer for the text it was asked with, so an answer that arrives after
// the text changed is never shown against the new text.
type Found = { readonly text: string; readonly result: NameSearch };

function useNameSearch(text: string, search: SearchNames): NameSearch | null {
  const [found, setFound] = useState<Found | null>(null);

  useEffect(() => {
    if (text === "") return;
    let current = true;
    const timer = setTimeout(() => {
      search(text).then(
        (result) => current && setFound({ text, result }),
        () => current && setFound({ text, result: { status: "failed" } }),
      );
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [text, search]);

  return found?.text === text ? found.result : null;
}

function useShortcut(onPress: () => void) {
  const press = useEffectEvent(onPress);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== "k" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      press();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

function searchStatus(text: string, found: NameSearch | null): string {
  if (text === "") return "Type to search journeys, segments, and customers.";
  if (found === null) return "Searching journeys and segments…";
  if (found.status === "failed") return "Journeys and segments could not load.";
  return "";
}

export interface CommandPaletteProps {
  viewer: Reach;
  search: SearchNames;
}

// SHL-FR-04, SHL-FR-07, SHL-FR-22: Ctrl+K or Cmd+K opens a palette of what the viewer may reach, the
// journeys and segments whose name holds the typed text, and a customer lookup. It only reads.
export function CommandPalette({ viewer, search }: CommandPaletteProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const text = input.trim();
  const found = useNameSearch(text, search);
  const groups = paletteGroups(viewer, text, found);
  const status = searchStatus(text, found);

  function changeOpen(next: boolean) {
    if (next) setInput("");
    setOpen(next);
  }

  useShortcut(() => changeOpen(!open));

  function pick(item: PaletteItem) {
    setOpen(false);
    router.push(item.href);
  }

  return (
    <CommandDialog onOpenChange={changeOpen} open={open}>
      <CommandDialogTrigger
        render={
          <Button
            aria-keyshortcuts="Control+K Meta+K"
            aria-label="Search"
            className="text-muted-foreground hover:text-foreground md:hidden"
            size="icon"
            variant="ghost"
          />
        }
      >
        <SearchIcon aria-hidden />
      </CommandDialogTrigger>
      <CommandDialogTrigger
        render={
          <Button
            aria-keyshortcuts="Control+K Meta+K"
            className="hidden min-w-65 justify-start gap-2 bg-popover text-muted-foreground md:inline-flex"
            size="sm"
            variant="outline"
          />
        }
      >
        <SearchIcon aria-hidden />
        <span className="flex-1 text-left font-normal">Search or jump to…</span>
        <KbdGroup aria-hidden>
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
      </CommandDialogTrigger>
      <CommandDialogPopup>
        <CommandDialogPrimitive.Title className="sr-only">Search studio</CommandDialogPrimitive.Title>
        <Command items={groups} mode="none" onValueChange={setInput} value={input}>
          <CommandInput aria-label="Search pages, journeys, segments, and customers" placeholder="Search pages, journeys, segments…" />
          <CommandPanel>
            <CommandList>
              {(group: (typeof groups)[number], index: number) => (
                <Fragment key={group.value}>
                  <CommandGroup items={group.items}>
                    <CommandGroupLabel>{group.value}</CommandGroupLabel>
                    <CommandCollection>
                      {(item: PaletteItem) => {
                        const Icon = iconOf(item);
                        return (
                          <CommandItem className="gap-2" key={item.key} onClick={() => pick(item)} value={item}>
                            <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                            <span className="truncate">{item.label}</span>
                            {"preview" in item && item.preview && <PreviewBadge className="ml-auto" />}
                          </CommandItem>
                        );
                      }}
                    </CommandCollection>
                  </CommandGroup>
                  {index < groups.length - 1 && <CommandSeparator />}
                </Fragment>
              )}
            </CommandList>
          </CommandPanel>
          <CommandFooter>
            <p aria-live="polite" className="min-h-4" role="status">
              {status}
            </p>
            <span aria-hidden className="flex shrink-0 items-center gap-3">
              <span className="flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
                Move
              </span>
              <span className="flex items-center gap-1">
                <Kbd>Enter</Kbd>
                Open
              </span>
              <span className="flex items-center gap-1">
                <Kbd>Esc</Kbd>
                Close
              </span>
            </span>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
