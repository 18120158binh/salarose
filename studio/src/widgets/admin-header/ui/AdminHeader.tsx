import React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import ThemeToggle from "shared/components/ThemeToggle";

export default function AdminHeader() {
  return (
    <header className="h-16 border-b border-border px-8 flex items-center justify-between shrink-0 bg-background/80 backdrop-blur-md sticky top-0 z-40 text-foreground">
      <div className="flex items-center gap-3">
        <span className="text-foreground font-semibold text-base tracking-tighter">🛠️ ADMIN CONSOLE</span>
        <Badge variant="secondary" size="sm">
          MASTER CONTROLS
        </Badge>
      </div>
      <nav className="flex items-center gap-4">
        <Button render={<Link href="/admin/events" />} variant="default" size="sm">
          Events
        </Button>
        <Button render={<Link href="/admin/source-keys" />} variant="outline" size="sm">
          Source keys
        </Button>
        
        <Button render={<Link href="/v2" />} variant="outline" size="sm">
          Try the new studio
        </Button>
        <ThemeToggle />

        <Button
          render={<Link href="/campaign" />}
          variant="outline"
          size="sm"
          className="ml-4"
        >
          ← Campaigns
        </Button>
      </nav>
    </header>
  );
}
