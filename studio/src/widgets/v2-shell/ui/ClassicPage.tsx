"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type SetClassicPage = (href: string | null) => void;

const ClassicPageValue = createContext<string | null>(null);
const ClassicPageSetter = createContext<SetClassicPage | null>(null);

export function ClassicPageProvider({ children }: { children: ReactNode }) {
  const [page, setPage] = useState<string | null>(null);
  return (
    <ClassicPageSetter.Provider value={setPage}>
      <ClassicPageValue.Provider value={page}>{children}</ClassicPageValue.Provider>
    </ClassicPageSetter.Provider>
  );
}

/** The classic page the current v2 page named, or null when the route table decides. */
export function useClassicPage(): string | null {
  return useContext(ClassicPageValue);
}

/**
 * SHL-FR-08: names the classic page that Back to classic opens while this v2 page shows, for a rule
 * the route table cannot apply because it needs the page's data, such as a journey's owner.
 */
export function ClassicPage({ href }: { href: string }) {
  const setPage = useContext(ClassicPageSetter);
  useEffect(() => {
    setPage?.(href);
    return () => setPage?.(null);
  }, [href, setPage]);
  return null;
}
