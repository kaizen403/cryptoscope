import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const SUPPORTED = new Set([
  ".py",
  ".js",
  ".ts",
  ".java",
  ".cpp",
  ".c",
  ".cs",
  ".php",
  ".rb",
  ".go",
  ".rs",
  ".swift",
  ".kt",
  ".scala",
  ".r",
  ".m",
  ".h",
]);

const SKIP_DIRS = new Set(["node_modules", "__pycache__", "build", "dist", "target"]);

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const directoryPath = searchParams.get("path") || "";
  if (!directoryPath) {
    return NextResponse.json({ error: "Missing 'path' query param" }, { status: 400 });
  }
  try {
    const st = fs.statSync(directoryPath);
    if (!st.isDirectory()) {
      return NextResponse.json({ error: "Not a directory" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: "Directory not accessible" }, { status: 404 });
  }

  const entries: Array<{ type: "folder" | "file"; name: string; path: string; level: number; extension?: string; supported?: boolean; }> = [];
  const root = path.resolve(directoryPath);
  const rootLen = root.length;

  const stack: string[] = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    let dirents: fs.Dirent[] = [];
    try {
      dirents = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (d.name.startsWith(".")) continue;
      const full = path.join(cur, d.name);
      const rel = full.slice(rootLen);
      const level = rel.split(path.sep).filter(Boolean).length;
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name)) continue;
        entries.push({ type: "folder", name: d.name, path: full, level });
        stack.push(full);
      } else if (d.isFile()) {
        const ext = path.extname(d.name).toLowerCase();
        const supported = SUPPORTED.has(ext);
        entries.push({ type: "file", name: d.name, path: full, level, extension: ext, supported });
      }
    }
  }

  // Sort folders first then files, each group alphabetically
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1));
  return NextResponse.json({ entries });
}

