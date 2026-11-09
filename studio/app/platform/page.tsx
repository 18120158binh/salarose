import { requireAdmin } from "@/shared/auth/session";
import { platformConfig, toolHealth } from "@/features/platform-console/model/server";
import PlatformHeader from "@/features/platform-console/ui/PlatformHeader";
import { PlatformView } from "@/features/platform-console/ui/PlatformView";

export const dynamic = "force-dynamic";

// PCN-FR-01: admins only. The cards render at once and each tool's health streams in (PCN-FR-05).
export default async function PlatformPage() {
  await requireAdmin();

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <PlatformHeader />
      <div className="flex-1 overflow-y-auto bg-background">
        <PlatformView config={platformConfig()} healthOf={(tool) => toolHealth(tool.id, tool.health)} />
      </div>
    </div>
  );
}
