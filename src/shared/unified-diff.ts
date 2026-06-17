import type { ChangedFile, ChangedFileStatus } from "../contracts/index.ts";

// Parses `git diff` unified output into ChangedFile entries. Each file section
// begins with a `diff --git a/<old> b/<new>` line; per-file status, binary-ness,
// hunk patch, and +/- counts are derived from the section body.
export function parseUnifiedDiff(diffText: string): ChangedFile[] {
  const sections = diffText.split(/^diff --git .*$/m).slice(1);
  const headers = [...diffText.matchAll(/^diff --git (.*)$/gm)].map((match) => match[1] ?? "");

  return sections.map((section, index) => parseFileSection(headers[index] ?? "", section));
}

function parseFileSection(header: string, body: string): ChangedFile {
  // The `diff --git a/<old> b/<new>` header is ambiguous when a path contains a
  // space (git does not quote for spaces alone), so prefer the unambiguous
  // one-path-per-line sources — `--- a/…`, `+++ b/…`, `rename/copy from|to`, and
  // the `Binary files …` line — and fall back to the header only for changes
  // with none of those (e.g. a pure mode change).
  const headerPaths = parseHeaderPaths(header);
  let status: ChangedFileStatus = "modified";
  let isBinary = false;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let minusPath: string | undefined;
  let plusPath: string | undefined;
  let binaryOld: string | undefined;
  let binaryNew: string | undefined;

  const lines = body.split("\n");
  let hunkStart = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("@@")) {
      hunkStart = index;
      break;
    }
    if (line.startsWith("new file mode")) {
      status = "added";
    } else if (line.startsWith("deleted file mode")) {
      status = "deleted";
    } else if (line.startsWith("rename from ")) {
      status = "renamed";
      renameFrom = decodeGitPath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      status = "renamed";
      renameTo = decodeGitPath(line.slice("rename to ".length));
    } else if (line.startsWith("copy from ")) {
      status = "copied";
      renameFrom = decodeGitPath(line.slice("copy from ".length));
    } else if (line.startsWith("copy to ")) {
      status = "copied";
      renameTo = decodeGitPath(line.slice("copy to ".length));
    } else if (line.startsWith("--- ")) {
      minusPath = stripDiffPath(line.slice("--- ".length));
    } else if (line.startsWith("+++ ")) {
      plusPath = stripDiffPath(line.slice("+++ ".length));
    } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      isBinary = true;
      const match = line.match(/^Binary files (.*?) and (.*) differ$/);
      if (match !== null) {
        binaryOld = stripDiffPath(match[1] ?? "");
        binaryNew = stripDiffPath(match[2] ?? "");
      }
    }
  }

  const oldPath = renameFrom ?? minusPath ?? binaryOld ?? headerPaths.oldPath;
  const newPath = renameTo ?? plusPath ?? binaryNew ?? headerPaths.newPath;

  let additions = 0;
  let deletions = 0;
  let patch: string | undefined;
  if (hunkStart >= 0) {
    const hunkLines = lines.slice(hunkStart);
    patch = hunkLines.join("\n").replace(/\n+$/, "");
    for (const line of hunkLines) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        additions += 1;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        deletions += 1;
      }
    }
  }

  const path = status === "deleted" ? oldPath : newPath;

  return {
    path,
    ...(status === "renamed" || status === "copied" ? { oldPath } : {}),
    status,
    additions,
    deletions,
    isBinary,
    ...(isLockfilePath(path) ? { isLockfile: true } : {}),
    ...(patch !== undefined ? { patch } : {}),
  };
}

// Extracts a path from a `--- a/<path>` / `+++ b/<path>` / `Binary files` token.
// Returns undefined for `/dev/null` (added/deleted sentinel). Paths with spaces
// are handled because each of these tokens carries exactly one path; git quotes
// (and C-escapes) paths with control chars or non-ASCII bytes, which are decoded.
function stripDiffPath(raw: string): string | undefined {
  let value = decodeGitPath(raw);
  if (value === "/dev/null") {
    return undefined;
  }
  if (value.startsWith("a/") || value.startsWith("b/")) {
    value = value.slice(2);
  }

  return value.length > 0 ? value : undefined;
}

// Trims and, if the value is a git C-quoted path (`"…"`), decodes it. Does NOT
// strip the a/ b/ prefix — used for `rename`/`copy` lines, which carry a bare
// path, as well as by stripDiffPath for `---`/`+++` tokens (which add the prefix
// removal on top).
function decodeGitPath(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    return unquoteGitPath(value);
  }

  return value;
}

// Decodes a git C-quoted path. Escapes encode raw UTF-8 bytes, and literal
// (unescaped) characters are themselves UTF-8 text, so both are accumulated as
// bytes and decoded once — `\303\251` (and a literal `é`) both become "é".
function unquoteGitPath(quoted: string): string {
  const inner = quoted.slice(1, -1);
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  let literal = "";
  const flushLiteral = (): void => {
    if (literal.length > 0) {
      bytes.push(...encoder.encode(literal));
      literal = "";
    }
  };
  const named: Record<string, number> = { n: 0x0a, t: 0x09, r: 0x0d, '"': 0x22, "\\": 0x5c };

  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index] ?? "";
    if (char !== "\\") {
      literal += char;
      continue;
    }

    flushLiteral();
    const next = inner[index + 1];
    if (next === undefined) {
      bytes.push(0x5c);
      break;
    }
    if (next >= "0" && next <= "7") {
      let octal = "";
      let lookahead = index + 1;
      while (octal.length < 3) {
        const digit = inner[lookahead];
        if (digit === undefined || digit < "0" || digit > "7") {
          break;
        }
        octal += digit;
        lookahead += 1;
      }
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      index = lookahead - 1;
    } else {
      bytes.push(named[next] ?? next.charCodeAt(0));
      index += 1;
    }
  }

  flushLiteral();

  return new TextDecoder().decode(new Uint8Array(bytes));
}

function parseHeaderPaths(header: string): { oldPath: string; newPath: string } {
  // `a/<old> b/<new>`; paths may be quoted when they contain unusual characters.
  const match = header.match(/^(?:"a\/(.+?)"|a\/(\S+)) (?:"b\/(.+?)"|b\/(.+))$/);
  if (match === null) {
    const fallback = header.replace(/^a\//, "").trim();
    return { oldPath: fallback, newPath: fallback };
  }

  const oldPath = match[1] ?? match[2] ?? "";
  const newPath = match[3] ?? match[4] ?? "";

  return { oldPath, newPath };
}

function isLockfilePath(path: string): boolean {
  const name = path.split("/").at(-1) ?? path;

  return (
    name === "package-lock.json" ||
    name === "yarn.lock" ||
    name === "pnpm-lock.yaml" ||
    name === "bun.lock" ||
    name === "bun.lockb" ||
    name === "Cargo.lock" ||
    name === "poetry.lock" ||
    name === "Gemfile.lock" ||
    name === "composer.lock" ||
    name === "go.sum"
  );
}
