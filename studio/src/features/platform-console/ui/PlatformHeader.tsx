import Link from "next/link";
import { Button } from "@/components/ui/button";
import ThemeToggle from "shared/components/ThemeToggle";

export default function PlatformHeader() {
  return (
    <header className="sticky top-0 z-40 flex h-16 shrink-0 items-center justify-between border-b border-border bg-background/80 px-8 text-foreground backdrop-blur-md">
      <h1 className="font-semibold text-base tracking-tighter">PLATFORM</h1>
      <nav className="flex items-center gap-4">
        <ThemeToggle />
        <Button render={<Link href="/campaign" />} variant="outline" size="sm">
          ← Campaigns
        </Button>
      </nav>
    </header>
  );
}
