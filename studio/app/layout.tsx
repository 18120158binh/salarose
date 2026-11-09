import type { Metadata } from "next";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import "./globals.css";
import { cookies } from "next/headers";
import { cn } from "@/lib/utils";

const interHeading = Inter({subsets:['latin'],variable:'--font-heading'});

const inter = Inter({subsets:['latin'],variable:'--font-sans'});

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Journey Studio | Real-time Customer Journey & CDP Platform",
  description: "Real-time customer journey orchestration, streaming CEP, and multi-channel campaign platform",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const theme = cookieStore.get("theme")?.value || "light";

  return (
    <html
      lang="en"
      className={cn(
        theme === "dark" && "dark",
        "h-full overflow-hidden",
        "antialiased",
        geistSans.variable,
        geistMono.variable,
        "font-sans",
        inter.variable,
        interHeading.variable
      )}
    >
      <body className="h-full bg-background text-foreground font-sans transition-colors duration-200 overflow-hidden">
        <div className="root h-full flex flex-row overflow-hidden">
          <main className="flex-1 bg-background flex flex-col border-r border-border overflow-hidden">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
