import type { ColumnType, DatasetColumn, Delimiter } from "./domain";

// The editor's "Suggest from a sample file": reads a CSV in the browser and suggests a column per
// header. Nothing is uploaded. The admin checks each type before saving.

export const SAMPLE_ROWS = 200;

/** Splits CSV text into rows of fields. Quotes may hold the delimiter, newlines and doubled quotes. */
export function parseCsv(text: string, delimiter: Delimiter): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(field);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  row.push(field);
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

const NUMBER = /^-?\d+(\.\d+)?$/;
const BOOLEAN = /^(true|false)$/i;
const DATETIME = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function fits(values: string[], test: (value: string) => boolean): boolean {
  return values.length > 0 && values.every(test);
}

function isJson(value: string): boolean {
  if (!/^[[{]/.test(value)) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

/** The narrowest type every non-empty value reads as. Text when the column holds no value. */
export function inferType(values: string[]): ColumnType {
  const present = values.map((value) => value.trim()).filter((value) => value !== "");
  if (fits(present, (value) => BOOLEAN.test(value))) return "boolean";
  if (fits(present, (value) => NUMBER.test(value))) return "number";
  if (fits(present, (value) => DATETIME.test(value))) return "datetime";
  if (fits(present, isJson)) return "json";
  return "string";
}

/** A header as a system name: lowercase, underscores for anything else, starting with a letter. */
export function systemNameOf(header: string): string {
  const name = header
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (name === "") return "column";
  return /^[a-z]/.test(name) ? name : `c_${name}`;
}

function displayNameOf(header: string): string {
  const words = header.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return words === "" ? "Column" : words[0].toUpperCase() + words.slice(1);
}

export interface SampleSuggestion {
  columns: DatasetColumn[];
  rows: number;
}

/**
 * One column per header of the sample, typed from up to SAMPLE_ROWS rows. A header that differs from
 * its system name becomes the column's alias, so files with that header still match.
 */
export function suggestColumns(text: string, delimiter: Delimiter): SampleSuggestion | { error: string } {
  const [headers, ...body] = parseCsv(text.replace(/^﻿/, ""), delimiter);
  if (!headers || headers.every((header) => header.trim() === "")) return { error: "The file has no header row." };
  const rows = body.slice(0, SAMPLE_ROWS);
  const taken = new Set<string>();
  const columns = headers.map((header, index): DatasetColumn => {
    const base = systemNameOf(header);
    let name = base;
    for (let suffix = 2; taken.has(name); suffix++) name = `${base}_${suffix}`;
    taken.add(name);
    const trimmed = header.trim();
    return {
      name,
      displayName: displayNameOf(trimmed),
      type: inferType(rows.map((row) => row[index] ?? "")),
      pii: false,
      aliases: trimmed !== name && trimmed !== "" ? [trimmed] : [],
    };
  });
  return { columns, rows: rows.length };
}
