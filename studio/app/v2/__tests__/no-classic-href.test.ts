import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// SHL-FR-10, JBD-FR-24: v2 code links to v2 pages. A path into the classic studio stays listed here
// until its v2 page ships, so the list only shrinks: a new path fails, and so does a listed path
// that is gone.
const SRC = path.join(__dirname, "..", "..", "..", "src");
const ROOTS = [
  { dir: path.join(__dirname, ".."), name: "app/v2" },
  ...["features", "widgets", "entities"].map((layer) => ({ dir: path.join(SRC, layer), name: `src/${layer}` })),
];
const CLASSIC_PATH = /(["'`])(\/(?:campaign|segments|admin|platform)(?:[/?#][^"'`$\n]*)?)(?=\1|\$\{)/g;

const BASELINE = [
  "app/v2/data/sources/page.tsx  /admin/source-keys",
  "src/features/home-overview/ui/JourneyLists.tsx  /campaign/new",
  "src/features/journey-analytics/ui/JourneyList.tsx  /campaign/",
  "src/features/journey-analytics/ui/JourneyList.tsx  /campaign/new",
  "src/features/platform-console/ui/PlatformHeader.tsx  /campaign",
  "src/widgets/admin-header/ui/AdminHeader.tsx  /admin/events",
  "src/widgets/admin-header/ui/AdminHeader.tsx  /admin/source-keys",
  "src/widgets/admin-header/ui/AdminHeader.tsx  /campaign",
  "src/widgets/v2-shell/model/routes.ts  /admin/events",
  "src/widgets/v2-shell/model/routes.ts  /admin/source-keys",
  "src/widgets/v2-shell/model/routes.ts  /campaign",
  "src/widgets/v2-shell/model/routes.ts  /campaign",
  "src/widgets/v2-shell/model/routes.ts  /campaign",
  "src/widgets/v2-shell/model/routes.ts  /campaign/",
  "src/widgets/v2-shell/model/routes.ts  /campaign/",
  "src/widgets/v2-shell/model/routes.ts  /platform",
  "src/widgets/v2-shell/model/routes.ts  /segments",
];

interface Source {
  dir: string;
  /** The path from studio/. */
  name: string;
}

function sourceFiles(folder: Source): Source[] {
  return readdirSync(folder.dir, { withFileTypes: true }).flatMap((entry) => {
    const child = { dir: path.join(folder.dir, entry.name), name: `${folder.name}/${entry.name}` };
    if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "__fixtures__" ? [] : sourceFiles(child);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [child] : [];
  });
}

const classicPaths = (source: string) => [...source.matchAll(CLASSIC_PATH)].map((match) => match[2]);

describe("v2 links into the classic studio", () => {
  it("reads a path into the classic studio, and not a v2 path that shares its name", () => {
    const source = 'href="/segments" `/campaign/${id}` "/admin?tab=1" "/v2/segments" "/administrator" "/platforms"';

    expect(classicPaths(source)).toEqual(["/segments", "/campaign/", "/admin?tab=1"]);
  });

  it("are only the listed ones", () => {
    const found = ROOTS.flatMap(sourceFiles).flatMap((file) =>
      classicPaths(readFileSync(file.dir, "utf8")).map((literal) => `${file.name}  ${literal}`));

    expect(found.sort()).toEqual(BASELINE);
  });
});
