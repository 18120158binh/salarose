import { RegionSkeleton } from "@/shared/ui/v2/states";

export default function V2Loading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <RegionSkeleton className="h-7 w-64" />
        <RegionSkeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <RegionSkeleton className="h-40" />
        <RegionSkeleton className="h-40" />
        <RegionSkeleton className="h-40" />
      </div>
    </div>
  );
}
