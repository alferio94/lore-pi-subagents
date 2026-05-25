import type { FrontmatterPrimitive, FrontmatterValue, ParsedFrontmatter } from "./types.ts";

const FRONTMATTER_DELIMITER = "---";

export function parseFrontmatter(markdown: string): ParsedFrontmatter {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith(`${FRONTMATTER_DELIMITER}\n`)) {
    return { data: {}, body: normalized };
  }

  const lines = normalized.split("\n");
  const closingIndex = lines.slice(1).findIndex((line) => line.trim() === FRONTMATTER_DELIMITER);
  if (closingIndex === -1) {
    throw new Error("Unterminated frontmatter block.");
  }

  const headerLines = lines.slice(1, closingIndex + 1);
  const bodyLines = lines.slice(closingIndex + 2);
  const data = parseHeaderLines(headerLines);

  return {
    data,
    body: stripSingleLeadingNewline(bodyLines.join("\n")),
  };
}

function parseHeaderLines(lines: string[]): Record<string, FrontmatterValue> {
  const data: Record<string, FrontmatterValue> = {};
  let activeArrayKey: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }

    const arrayMatch = rawLine.match(/^\s*-\s*(.+?)\s*$/);
    if (activeArrayKey && arrayMatch) {
      const existing = data[activeArrayKey];
      if (!Array.isArray(existing)) {
        throw new Error(`Frontmatter key '${activeArrayKey}' is not an array.`);
      }
      existing.push(parseScalar(arrayMatch[1]));
      continue;
    }

    activeArrayKey = null;
    const fieldMatch = rawLine.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!fieldMatch) {
      throw new Error(`Unsupported frontmatter syntax: ${rawLine}`);
    }

    const [, key, rawValue = ""] = fieldMatch;
    if (rawValue === "") {
      data[key] = [];
      activeArrayKey = key;
      continue;
    }

    if (isInlineList(rawValue)) {
      data[key] = splitInlineList(rawValue).map(parseScalar);
      continue;
    }

    data[key] = parseScalar(rawValue);
  }

  return data;
}

function stripSingleLeadingNewline(value: string): string {
  return value.startsWith("\n") ? value.slice(1) : value;
}

function isInlineList(value: string): boolean {
  return value.startsWith("[") && value.endsWith("]");
}

function splitInlineList(value: string): string[] {
  const inner = value.slice(1, -1).trim();
  if (!inner) {
    return [];
  }

  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if ((char === '"' || char === "'") && inner[index - 1] !== "\\") {
      if (quote === char) {
        quote = null;
      } else if (!quote) {
        quote = char;
      }
      current += char;
      continue;
    }

    if (char === "," && !quote) {
      parts.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

function parseScalar(value: string): FrontmatterPrimitive {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}
