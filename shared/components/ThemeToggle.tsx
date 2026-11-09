"use client";

import React, { useEffect, useState } from "react";
import { Sun, Moon } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    // Determine initial theme on client side
    const isDark = document.documentElement.classList.contains("dark");
    setTheme(isDark ? "dark" : "light");
  }, []);

  const toggleTheme = () => {
    const nextTheme = theme === "light" ? "dark" : "light";
    setTheme(nextTheme);

    if (nextTheme === "dark") {
      document.documentElement.classList.add("dark");
      document.cookie = "theme=dark; path=/; max-age=31536000; SameSite=Lax";
    } else {
      document.documentElement.classList.remove("dark");
      document.cookie = "theme=light; path=/; max-age=31536000; SameSite=Lax";
    }
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggleTheme}
      className="relative flex items-center justify-center rounded-full size-8 border border-input bg-transparent text-foreground hover:bg-accent transition-colors cursor-pointer select-none"
      aria-label="Toggle dark mode"
    >
      <Sun className="size-4 rotate-0 scale-100 transition-transform duration-300 dark:-rotate-90 dark:scale-0 text-amber-500" />
      <Moon className="absolute size-4 rotate-90 scale-0 transition-transform duration-300 dark:rotate-0 dark:scale-100 text-indigo-400" />
    </Button>
  );
}
