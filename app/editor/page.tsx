"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { SessionProvider, useSession, signIn } from "next-auth/react";
import CodeViewer from "../../components/CodeViewer";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://35.200.140.65:5001/api";

type DirectoryEntry = {
  type: "folder" | "file";
  name: string;
  path: string;
  level: number;
  supported?: boolean;
};

type TreeNode = {
  name: string;
  path: string;
  type: "folder" | "file";
  level: number;
  supported?: boolean;
  children?: TreeNode[];
};

type CryptoFunction = { name?: string; line_start?: number; content?: string; type?: string };
type CryptoSnippet = { name?: string; line_start?: number; code?: string; type?: string };

type BasicCryptoAnalysis = {
  file_path: string;
  file_name: string;
  file_extension: string;
  has_crypto: boolean;
  crypto_imports?: string[];
  crypto_functions?: CryptoFunction[];
  crypto_patterns_found?: string[];
  crypto_algorithms_detected?: Array<Record<string, unknown>>;
  code_snippets?: CryptoSnippet[];
};

type GeminiReview = { original_analysis?: BasicCryptoAnalysis; gemini_analysis?: string };
type AnalysisResult = {
  status?: string;
  total_files?: number;
  crypto_files_found?: number;
  message?: string;
  basic_analysis?: BasicCryptoAnalysis[];
  detailed_reviews?: GeminiReview[];
};

type FilesCollectionEntry = { analysis: BasicCryptoAnalysis; review?: GeminiReview };

function getFilesCollection(result: AnalysisResult | null): FilesCollectionEntry[] {
  if (!result) return [];
  if (result.detailed_reviews?.length) {
    return result.detailed_reviews
      .map(review => ({ analysis: review.original_analysis || (review as unknown as BasicCryptoAnalysis), review }))
      .filter(entry => Boolean(entry.analysis));
  }
  if (result.basic_analysis?.length) {
    return result.basic_analysis.map(a => ({ analysis: a }));
  }
  return [];
}

function buildTreeFromEntries(entries: DirectoryEntry[]): TreeNode[] {
  const tree: TreeNode[] = [];
  const stack: TreeNode[] = [];
  for (const e of entries) {
    const node: TreeNode = {
      name: e.name,
      path: e.path,
      type: e.type,
      level: e.level,
      supported: e.supported,
      children: e.type === "folder" ? [] : undefined
    };
    while (stack.length && stack[stack.length - 1].level >= e.level) stack.pop();
    if (!stack.length) tree.push(node);
    else {
      const parent = stack[stack.length - 1];
      (parent.children ||= []).push(node);
    }
    if (e.type === "folder") stack.push(node);
  }
  return tree;
}

function buildTreeFromFilePaths(paths: string[]): TreeNode[] {
  // Build a VS Code-like tree from a list of file paths
  const root: Record<string, any> = {};
  for (const full of paths) {
    const parts = full.split("/").filter(Boolean);
    let cursor = root;
    let agg = "";
    parts.forEach((segment, idx) => {
      agg += "/" + segment;
      cursor.children ||= {};
      cursor.children[segment] ||= { name: segment, path: agg, type: idx === parts.length - 1 ? "file" : "folder", children: {} };
      cursor = cursor.children[segment];
    });
  }
  function toNodes(node: any, level = 0): TreeNode[] {
    const out: TreeNode[] = [];
    const keys = Object.keys(node.children || {}).sort();
    for (const k of keys) {
      const child = node.children[k];
      const entry: TreeNode = { name: child.name, path: child.path, type: child.type, level, children: undefined };
      if (child.type === "folder") {
        entry.children = toNodes(child, level + 1);
      }
      out.push(entry);
    }
    return out;
  }
  return toNodes(root, 0);
}

function EditorContent({ selectedPath, files }: { selectedPath: string; files: FilesCollectionEntry[] }) {
  const entry = files.find(f => f.analysis.file_path === selectedPath || f.analysis.file_path.endsWith(selectedPath));
  if (!entry) return <div className="empty-state">No analysis available for {selectedPath}.</div>;
  const a = entry.analysis;
  if (a.code_snippets?.length) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        {a.code_snippets.map((snip, i) => (
          <div key={`snip-${i}`}>
            <strong>
              {snip.name || snip.type || "Snippet"}
              {snip.line_start ? ` (line ${snip.line_start})` : ""}
            </strong>
            {snip.code ? <CodeViewer value={snip.code} extension={a.file_extension} /> : null}
          </div>
        ))}
      </div>
    );
  }
  return <div className="empty-state">No code snippets captured for this file.</div>;
}

function EditorContentPage() {
  const { data: session } = useSession();
  const params = useSearchParams();
  const router = useRouter();
  const pathParam = params.get("path");
  const gitParam = params.get("git_url");

  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [progressPct, setProgressPct] = useState(1);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const files = useMemo(() => getFilesCollection(analysisResult), [analysisResult]);
  const findingsCountByPath = useMemo(() => {
    const map: Record<string, number> = {};
    for (const entry of files) {
      const a = entry.analysis;
      const c = (a.crypto_imports?.length || 0)
        + (a.crypto_functions?.length || 0)
        + (a.crypto_patterns_found?.length || 0)
        + (a.crypto_algorithms_detected?.length || 0);
      map[a.file_path] = c;
    }
    return map;
  }, [files]);
  const getFolderCount = useCallback((folderPath: string) => {
    if (!folderPath) return 0;
    const prefix = folderPath.endsWith('/') ? folderPath : folderPath + '/';
    let sum = 0;
    for (const [p, v] of Object.entries(findingsCountByPath)) {
      if (p.startsWith(prefix)) sum += v;
    }
    return sum;
  }, [findingsCountByPath]);

  const startProgress = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    setProgressPct(1);
    timerRef.current = setInterval(() => {
      setProgressPct(prev => Math.min(prev + (Math.random() * 6 + 1), 98));
    }, 300);
  }, []);

  const finishProgress = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setProgressPct(100);
    setTimeout(() => setProgressPct(0), 1200);
  }, []);

  const fetchDirectoryTree = useCallback(async (p: string) => {
    try {
      const response = await fetch(`/api/directory-structure?path=${encodeURIComponent(p)}`);
      if (!response.ok) return;
      const payload = await response.json();
      const entries = (payload?.entries || []) as DirectoryEntry[];
      setTree(buildTreeFromEntries(entries));
      const defaults: Record<string, boolean> = {};
      entries.forEach(e => {
        if (e.type === "folder" && e.level <= 1) defaults[e.path] = true;
      });
      setExpanded(defaults);
    } catch {}
  }, []);

  const toggle = (p: string) => setExpanded(prev => ({ ...prev, [p]: !prev[p] }));

  useEffect(() => {
    startProgress();
    (async () => {
      try {
        if (gitParam) {
          const res = await fetch(`${API_BASE_URL}/git-clone`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ git_url: gitParam })
          });
          const data = (await res.json()) as AnalysisResult;
          setAnalysisResult(data);
          // Build a tree from analyzed file paths
          const paths = getFilesCollection(data).map(f => f.analysis.file_path);
          setTree(buildTreeFromFilePaths(paths));
        } else if (pathParam) {
          const res = await fetch(`${API_BASE_URL}/analyze`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: pathParam })
          });
          const data = (await res.json()) as AnalysisResult;
          setAnalysisResult(data);
          await fetchDirectoryTree(pathParam);
        }
      } catch (e) {
        // In case of failure, still allow progress to finish so UI doesn't hang
      } finally {
        setLoading(false);
        finishProgress();
      }
    })();
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [gitParam, pathParam, finishProgress, fetchDirectoryTree, startProgress]);

  const renderNodes = (nodes: TreeNode[], depth = 0): JSX.Element => (
    <ul className={`tree-level ${depth === 0 ? "root" : ""}`}>
      {nodes.map(node => {
        const isFolder = node.type === "folder";
        const isExpanded = isFolder ? expanded[node.path] ?? node.level <= 1 : false;
        const count = isFolder ? getFolderCount(node.path) : (findingsCountByPath[node.path] || 0);
        return (
          <li key={node.path} className={`tree-item ${isFolder ? "folder" : "file"}`} data-depth={node.level}>
            <div
              className={`tree-row ${selectedPath === node.path ? "selected" : ""}`}
              onClick={() => {
                if (!isFolder) setSelectedPath(node.path);
              }}
              role={!isFolder ? "button" : undefined}
            >
              {isFolder ? (
                <button
                  type="button"
                  className={`tree-toggle ${isExpanded ? "expanded" : ""}`}
                  onClick={() => toggle(node.path)}
                  aria-label={`${isExpanded ? "Collapse" : "Expand"} folder ${node.name}`}
                />
              ) : (
                <span className="tree-toggle placeholder" aria-hidden="true" />
              )}
              <span className="tree-icon" aria-hidden="true">
                {isFolder ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M3 6.75A2.75 2.75 0 0 1 5.75 4h4.086a1.75 1.75 0 0 1 1.237.513l1.414 1.414c.328.328.773.513 1.237.513H18.25A2.75 2.75 0 0 1 21 9.19v8.06A2.75 2.75 0 0 1 18.25 20H5.75A2.75 2.75 0 0 1 3 17.25V6.75z" fill="currentColor" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M7 3.75A1.75 1.75 0 0 1 8.75 2h4.69c.464 0 .909.185 1.237.513l3.81 3.81c.328.328.513.773.513 1.237v12.69A1.75 1.75 0 0 1 17.25 22H8.75A1.75 1.75 0 0 1 7 20.25V3.75z" stroke="currentColor" fill="none"/>
                    <path d="M14 2.5v3.25A1.25 1.25 0 0 0 15.25 7H18.5" stroke="currentColor"/>
                  </svg>
                )}
              </span>
              <span className={`tree-label ${!isFolder ? "supported" : ""}`}>{node.name}</span>
              {count > 0 ? <span className="tree-count" title="Total findings">{count}</span> : null}
            </div>
            {isFolder && isExpanded && node.children?.length ? renderNodes(node.children, depth + 1) : null}
          </li>
        );
      })}
    </ul>
  );

  const filesList = files.map(f => f.analysis.file_path);

  if (!session) {
    return (
      <main className="page started">
        <div className="page-shell analyzer-shell">
          <section className="fade-in" style={{ padding: "2rem" }}>
            <h2 className="section-title">Sign in to use the editor</h2>
            <p className="section-subtitle">Authenticate with Google to review code and findings.</p>
            <button className="google-button" onClick={() => signIn('google')}>
              <svg className="google-icon" viewBox="0 0 533.5 544.3" xmlns="http://www.w3.org/2000/svg">
                <path fill="#4285F4" d="M533.5 278.4c0-17.4-1.6-34.1-4.6-50.2H272v95.0h147.4c-6.3 34-25 62.8-53.4 82.1v68.2h86.5c50.6-46.6 80-115.3 80-195.1z"/>
                <path fill="#34A853" d="M272 544.3c72.6 0 133.6-24.1 178.1-65.8l-86.5-68.2c-24 16.1-54.6 25.6-91.6 25.6-70.4 0-130.1-47.5-151.5-111.3H31.6v69.9C76 483.2 167.9 544.3 272 544.3z"/>
                <path fill="#FBBC05" d="M120.5 324.6c-10.2-30.6-10.2-63.8 0-94.4V160.3H31.6C-10.5 240.5-10.5 343.7 31.6 424z"/>
                <path fill="#EA4335" d="M272 107.7c39.5-.6 77.2 14 106 40.9l79.2-79.2C405.3 23.5 341.7-.4 272 0 167.9 0 76 61.1 31.6 160.3l88.9 69.9C141.9 155.9 201.6 108.4 272 107.7z"/>
              </svg>
              <span>Sign in with Google</span>
            </button>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="page started">
      <div className="page-shell analyzer-shell">
        <div className="analyzer-top">
          <div>
            <h2>Editor</h2>
            <p>Live progress and code preview while scanning.</p>
          </div>
          <button className="ghost-button" type="button" onClick={() => router.push("/")}>Back</button>
        </div>

        <section className="editor-shell fade-in">
          <div className="editor-top">
            {(loading || progressPct > 0) && (
              <div className="progress" aria-label="analysis progress">
                <div className="bar" style={{ width: `${progressPct}%` }} />
              </div>
            )}
            {filesList.length ? (
              <span className="small-caps">{filesList.length} files</span>
            ) : null}
          </div>
          <div className="editor-grid">
            <aside className="editor-sidebar panel">
              <div className="panel-header"><h3>Project Files</h3></div>
              <div className="panel-body">
                <div className="directory-tree">
                  {tree.length ? renderNodes(tree) : <div className="empty-state">Waiting for files…</div>}
                </div>
              </div>
            </aside>
            <div className="editor-view">
              {selectedPath ? (
                <EditorContent selectedPath={selectedPath} files={files} />
              ) : (
                <div className="empty-state">Select a file from the left to preview.</div>
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

export default function EditorPage() {
  return (
    <SessionProvider>
      <Suspense fallback={<div className="empty-state">Loading editor…</div>}>
        <EditorContentPage />
      </Suspense>
    </SessionProvider>
  );
}
