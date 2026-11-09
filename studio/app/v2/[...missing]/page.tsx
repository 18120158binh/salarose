import { notFound } from "next/navigation";

// Any /v2 path without a page, reserved routes included, gets the not-found page inside the shell.
export default function V2Missing(): never {
  notFound();
}
