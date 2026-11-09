import { platformConfig, toolHealth } from "@/features/platform-console/model/server";
import { PlatformConsole } from "@/features/platform-console/ui/PlatformConsole";
import { adminViewer } from "@/widgets/v2-shell/model/viewer";
import { PageHeader } from "@/shared/ui/v2/PageHeader";
import { Forbidden } from "@/shared/ui/v2/states";

export const dynamic = "force-dynamic";

const FORBIDDEN = "Platform shows the tools that run Salarose and whether each one is up. Ask an admin if you need something checked.";

// PCN-FR-11: the platform console inside the v2 shell. An editor gets the forbidden state before
// any tool is read or checked.
export default async function V2PlatformPage() {
  if (!(await adminViewer())) return <Forbidden message={FORBIDDEN} />;

  return (
    <>
      <PageHeader title="Platform" description="Is everything that runs Salarose working? Each tool is checked when you open this page." />
      <PlatformConsole
        checkedAt={toolHealth.checkedAt}
        config={platformConfig()}
        healthOf={(tool) => toolHealth(tool.id, tool.health)}
        now={Date.now}
      />
    </>
  );
}
