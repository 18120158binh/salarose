import type { TimeZone } from "@/shared/lib/time-range";
import type { ImportRun } from "../../model/imports";

export function dayLabel(instant: number, zone: TimeZone): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, day: "numeric", month: "short" }).format(instant);
}

export function passName(asOf: number, zone: TimeZone): string {
  return `${dayLabel(asOf, zone)} pass`;
}

/** "In conditions from": the first pass that included the run, or Not yet for an applied run no pass has read. */
export function inConditionsFrom(run: ImportRun, zone: TimeZone): string {
  if (run.firstPassAsOf !== null) return passName(run.firstPassAsOf, zone);
  return run.state === "applied" ? "Not yet" : "–";
}
