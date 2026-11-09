import React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import ThemeToggle from "shared/components/ThemeToggle";

interface HeaderProps {
  currentView: "campaign" | "segments";
  isAdminUser?: boolean;
}

export default function Header({
  currentView,
  isAdminUser = false,
}: HeaderProps) {
  return (
    <header className="h-16 border-b border-border px-8 flex items-center justify-between shrink-0 bg-background/80 backdrop-blur-md sticky top-0 z-40">
      <div className="flex items-center gap-3">
        <span className="text-foreground font-semibold text-lg tracking-tighter">JOURNEY STUDIO</span>
        <Badge variant="secondary" size="sm">{currentView === "segments" ? "SEGMENTS" : "CAMPAIGN"}</Badge>
      </div>

      <nav className="flex items-center gap-6">
        {isAdminUser && (
          <Button render={<a href="/admin" />} variant="outline" size="sm">
            🛠️ Admin
          </Button>
        )}
        {isAdminUser && (
          <Button render={<a href="/platform" />} variant="outline" size="sm">
            Platform
          </Button>
        )}
        <Button
          render={<Link href="/campaign" />}
          variant={currentView === "campaign" ? "secondary" : "ghost"}
          size="sm"
        >
          Campaign
        </Button>
        <Button
          render={<Link href="/segments" />}
          variant={currentView === "segments" ? "secondary" : "ghost"}
          size="sm"
        >
          Segments
        </Button>
        
        <Button render={<Link href="/v2" />} variant="outline" size="sm">
          Try the new studio
        </Button>
        <ThemeToggle />

        <form action="/api/auth/logout" method="post">
          <Button variant="ghost" size="sm" type="submit" className="text-red-500 hover:text-red-600 hover:bg-red-500/10">
            Logout
          </Button>
        </form>
      </nav>
    </header>
  );
}
