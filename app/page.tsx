"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import type { PlotParams } from "react-plotly.js";
import CodeViewer from "../components/CodeViewer";
import { SessionProvider, useSession, signIn, signOut } from "next-auth/react";

const Plot = dynamic<PlotParams>(() => import("react-plotly.js"), { ssr: false });

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://35.200.140.65:5001/api";

type Mode = "local" | "upload" | "git" | "stored";

type DirectoryEntry = {
  type: "folder" | "file";
  name: string;
  path: string;
  level: number;
  extension?: string;
  supported?: boolean;
};

const isGitUrl = (value: string) => {
  const target = value.trim();
  if (!target) {
    return false;
  }
  return (
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("git@") ||
    target.startsWith("ssh://") ||
    target.endsWith(".git")
  );
};

type TreeNode = {
  name: string;
  path: string;
  type: "folder" | "file";
  level: number;
  supported?: boolean;
  children?: TreeNode[];
};

function buildTree(entries: DirectoryEntry[]): TreeNode[] {
  const tree: TreeNode[] = [];
  const stack: TreeNode[] = [];

  entries.forEach(entry => {
    const node: TreeNode = {
      name: entry.name,
      path: entry.path,
      type: entry.type,
      level: entry.level,
      supported: entry.supported,
      children: entry.type === "folder" ? [] : undefined
    };

    while (stack.length && stack[stack.length - 1].level >= entry.level) {
      stack.pop();
    }

    if (stack.length === 0) {
      tree.push(node);
    } else {
      const parent = stack[stack.length - 1];
      if (!parent.children) {
        parent.children = [];
      }
      parent.children.push(node);
    }

    if (entry.type === "folder") {
      stack.push(node);
    }
  });

  return tree;
}

type CryptoFunction = {
  name?: string;
  line_start?: number;
  content?: string;
  type?: string;
};

type CryptoSnippet = {
  name?: string;
  line_start?: number;
  code?: string;
  type?: string;
};

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

type GeminiReview = {
  original_analysis?: BasicCryptoAnalysis;
  gemini_analysis?: string;
  crypto_summary?: {
    security_level?: string;
    algorithms_used?: string[];
    crypto_functions_identified?: string[];
    data_being_hashed?: string[];
    vulnerabilities?: string[];
    recommendations?: string[];
  };
};

type AnalysisResult = {
  status?: string;
  total_files?: number;
  crypto_files_found?: number;
  message?: string;
  basic_analysis?: BasicCryptoAnalysis[];
  detailed_reviews?: GeminiReview[];
};

type StoredItem = {
  name: string;
  path: string;
  files: number;
  size_bytes: number;
};

type ConsoleEntry = {
  timestamp: string;
  message: string;
};

const MODES: Array<{
  id: Mode;
  title: string;
  description: string;
  hint: string;
}> = [
  {
    id: "local",
    title: "Local Directory",
    description: "Analyze a directory that exists on this machine.",
    hint: "Requires backend access to the same filesystem."
  },
  {
    id: "upload",
    title: "Upload ZIP",
    description: "Upload a ZIP archive of your code for analysis.",
    hint: "ZIP is processed server-side and removed after analysis."
  },
  {
    id: "git",
    title: "Git Repository",
    description: "Analyze a remote Git repository (no local checkout required).",
    hint: "Supports HTTPS, HTTP, or SSH URLs."
  },
  {
    id: "stored",
    title: "Stored Projects",
    description: "Review previously stored uploads or clones.",
    hint: "Manage cached datasets for later analysis."
  }
];

const TABS = [
  "Imports",
  "Functions",
  "Patterns",
  "Algorithms",
  "Code Snippets",
  "AI Analysis"
] as const;

function HomeContent() {
  const router = useRouter();
  const { data: session } = useSession();
  const [mode, setMode] = useState<Mode>("local");
  const [apiHealthy, setApiHealthy] = useState<"checking" | "online" | "offline">("checking");
  const [directoryPath, setDirectoryPath] = useState<string>("");
  const [directoryStructure, setDirectoryStructure] = useState<DirectoryEntry[]>([]);
  const [structureLoading, setStructureLoading] = useState(false);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadStoring, setUploadStoring] = useState(false);
  const [gitAnalyzeLoading, setGitAnalyzeLoading] = useState(false);
  const [gitStoreLoading, setGitStoreLoading] = useState(false);
  const [storedLoading, setStoredLoading] = useState(false);
  const [storedDeleting, setStoredDeleting] = useState(false);
  const [gitUrl, setGitUrl] = useState<string>("");
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [showCharts, setShowCharts] = useState(true);
  // console panel removed per request
  const [feedback, setFeedback] = useState<{ type: "success" | "error" | "info"; text: string } | null>(
    null
  );
  const [storedItems, setStoredItems] = useState<StoredItem[]>([]);
  const [storedSelection, setStoredSelection] = useState<string>("");
  const [tabSelections, setTabSelections] = useState<Record<string, (typeof TABS)[number]>>({});
  const [hasStarted, setHasStarted] = useState(false);
  const analyzerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const treeData = useMemo(() => buildTree(directoryStructure), [directoryStructure]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [progressPct, setProgressPct] = useState(0);
  const progressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const appendConsole = useCallback((message: string) => {}, []);

  const notify = useCallback((type: "success" | "error" | "info", text: string) => {
    setFeedback({ type, text });
    appendConsole(text);
  }, [appendConsole]);

  const resetFeedback = useCallback(() => setFeedback(null), []);

  const refreshStoredItems = useCallback(async () => {
    setStoredLoading(true);
    appendConsole("GET /store/list");
    try {
      const response = await fetch(`${API_BASE_URL}/store/list`);
      if (!response.ok) {
        const text = await response.text();
        notify("error", `Failed to fetch stored projects (${response.status}): ${text}`);
        return;
      }
      const payload = await response.json();
      setStoredItems(payload?.items || []);
      setStoredSelection(payload?.items?.[0]?.name ?? "");
    } catch (error: unknown) {
      notify("error", error instanceof Error ? error.message : "Failed to fetch stored projects.");
    } finally {
      setStoredLoading(false);
    }
  }, [appendConsole, notify]);

  const analyzeGitRepository = useCallback(
    async (url: string) => {
      const target = url.trim();
      if (!target) {
        notify("error", "Repository URL is required.");
        return false;
      }
      appendConsole(`POST /git-clone ${target}`);
      try {
        const response = await fetch(`${API_BASE_URL}/git-clone`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ git_url: target })
        });
        if (!response.ok) {
          const text = await response.text();
          notify("error", `Git clone analysis failed (${response.status}): ${text}`);
          return false;
        }
        const data = (await response.json()) as AnalysisResult;
        setAnalysisResult(data);
        notify("success", "Repository cloned and analyzed successfully.");
        return true;
      } catch (error: unknown) {
        notify("error", error instanceof Error ? error.message : "Failed to clone repository.");
        return false;
      }
    },
    [appendConsole, notify, setAnalysisResult]
  );

  useEffect(() => {
    const controller = new AbortController();
    const checkHealth = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/health`, {
          signal: controller.signal
        });
        if (response.ok) {
          setApiHealthy("online");
        } else {
          setApiHealthy("offline");
        }
      } catch (error) {
        setApiHealthy("offline");
      }
    };

    checkHealth();
    const interval = setInterval(checkHealth, 15000);

    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (mode === "stored") {
      void refreshStoredItems();
    }
  }, [mode, refreshStoredItems]);

  useEffect(() => {
    if (!analysisResult) {
      return;
    }
    const files = getFilesCollection(analysisResult);
    if (!files.length) {
      return;
    }
    const defaultTab = TABS[0];
    const nextTabs: Record<string, (typeof TABS)[number]> = {};
    for (const file of files) {
      nextTabs[file.analysis.file_path] = defaultTab;
    }
    setTabSelections(nextTabs);
  }, [analysisResult]);

  useEffect(() => {
    if (hasStarted && analyzerRef.current) {
      analyzerRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [hasStarted]);

  useEffect(() => {
    if (!directoryStructure.length) {
      setExpandedNodes({});
      return;
    }
    const defaults: Record<string, boolean> = {};
    directoryStructure.forEach(entry => {
      if (entry.type === "folder" && entry.level <= 1) {
        defaults[entry.path] = true;
      }
    });
    setExpandedNodes(defaults);
  }, [directoryStructure]);

  const getTabSelection = (filePath: string) => tabSelections[filePath] ?? TABS[0];

  const setFileTab = (filePath: string, tab: (typeof TABS)[number]) => {
    setTabSelections(prev => ({ ...prev, [filePath]: tab }));
  };

  const getChartData = useMemo(() => {
    if (!analysisResult) {
      return null;
    }
    const files = getFilesCollection(analysisResult);
    if (!files.length) {
      return null;
    }

    const fileNames: string[] = [];
    const functionCounts: number[] = [];
    const importCounts: number[] = [];
    const patternCounts: number[] = [];

    for (const entry of files) {
      const analysis = entry.analysis;
      fileNames.push(analysis.file_name || "Unknown");
      functionCounts.push(analysis.crypto_functions?.length || 0);
      importCounts.push(analysis.crypto_imports?.length || 0);
      patternCounts.push(analysis.crypto_patterns_found?.length || 0);
    }

    return {
      fileNames,
      functionCounts,
      importCounts,
      patternCounts,
      totals: {
        functions: functionCounts.reduce((acc, val) => acc + val, 0),
        imports: importCounts.reduce((acc, val) => acc + val, 0),
        patterns: patternCounts.reduce((acc, val) => acc + val, 0)
      }
    };
  }, [analysisResult]);

  const fetchDirectoryStructure = async () => {
    resetFeedback();
    const target = directoryPath.trim();
    if (!target) {
      notify("error", "Please provide a directory path to scan.");
      return;
    }
    if (isGitUrl(target)) {
      notify("info", "Structure preview isn't available for Git URLs. Run Analyze to inspect the repository.");
      return;
    }

    setStructureLoading(true);
    appendConsole(`Preview directory structure: ${target}`);

    try {
      const response = await fetch(`/api/directory-structure?path=${encodeURIComponent(target)}`);
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        const errorMessage = detail?.error || `Unable to read directory (status ${response.status}).`;
        notify("error", errorMessage);
        return;
      }
      const payload = (await response.json()) as { entries: DirectoryEntry[] };
      setDirectoryStructure(payload.entries);
      notify("success", "Directory structure loaded successfully.");
    } catch (error: unknown) {
      notify("error", error instanceof Error ? error.message : "Failed to read directory structure.");
    } finally {
      setStructureLoading(false);
    }
  };

  const requestAnalysis = async (path: string) => {
    resetFeedback();
    setAnalysisLoading(true);
    setEditorOpen(true);
    startProgress();
    setTimeout(() => editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    appendConsole(`POST /analyze ${path}`);

    try {
      const response = await fetch(`${API_BASE_URL}/analyze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ path })
      });

      if (!response.ok) {
        const text = await response.text();
        notify("error", `Analysis failed (${response.status}): ${text}`);
        return;
      }

      const data = (await response.json()) as AnalysisResult;
      setAnalysisResult(data);
      notify("success", "Analysis complete.");
    } catch (error: unknown) {
      notify("error", error instanceof Error ? error.message : "Analysis request failed.");
    } finally {
      setAnalysisLoading(false);
      stopProgress();
    }
  };

  const handleLocalAnalyze = async (event: FormEvent) => {
    event.preventDefault();
    const target = directoryPath.trim();
    if (!target) {
      notify("error", "Path or repository URL is required.");
      return;
    }
    if (isGitUrl(target)) {
      router.push(`/editor?git_url=${encodeURIComponent(target)}`);
      return;
    }
    router.push(`/editor?path=${encodeURIComponent(target)}`);
  };

  const handleUploadAnalyze = async () => {
    resetFeedback();
    if (!zipFile) {
      notify("error", "Please choose a ZIP file first.");
      return;
    }
    setEditorOpen(true);
    setUploadLoading(true);
    startProgress();
    setTimeout(() => editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    appendConsole(`POST /upload-zip ${zipFile.name}`);

    try {
      const formData = new FormData();
      formData.append("file", zipFile);
      const response = await fetch(`${API_BASE_URL}/upload-zip`, {
        method: "POST",
        body: formData
      });
      if (!response.ok) {
        const text = await response.text();
        notify("error", `Upload analysis failed (${response.status}): ${text}`);
        return;
      }
      const data = (await response.json()) as AnalysisResult;
      setAnalysisResult(data);
      notify("success", "ZIP uploaded and analyzed successfully.");
    } catch (error: unknown) {
      notify("error", error instanceof Error ? error.message : "Failed to upload ZIP for analysis.");
    } finally {
      setUploadLoading(false);
      stopProgress();
    }
  };

  const handleUploadStore = async () => {
    resetFeedback();
    if (!zipFile) {
      notify("error", "Please choose a ZIP file first.");
      return;
    }
    setUploadStoring(true);
    appendConsole(`POST /store/upload-zip ${zipFile.name}`);

    try {
      const formData = new FormData();
      formData.append("file", zipFile);
      const response = await fetch(`${API_BASE_URL}/store/upload-zip`, {
        method: "POST",
        body: formData
      });
      if (!response.ok) {
        const text = await response.text();
        notify("error", `Failed to store ZIP (${response.status}): ${text}`);
        return;
      }
      const data = await response.json();
      notify("success", `ZIP stored as ${data?.name || "dataset"}.`);
      await refreshStoredItems();
    } catch (error: unknown) {
      notify("error", error instanceof Error ? error.message : "Failed to store ZIP file.");
    } finally {
      setUploadStoring(false);
    }
  };

  const handleGitAnalyze = async () => {
    resetFeedback();
    if (!gitUrl.trim()) {
      notify("error", "Please provide a Git URL to clone.");
      return;
    }
    router.push(`/editor?git_url=${encodeURIComponent(gitUrl)}`);
  };

  const handleGitStore = async () => {
    resetFeedback();
    if (!gitUrl.trim()) {
      notify("error", "Please provide a Git URL to clone.");
      return;
    }
    setGitStoreLoading(true);
    appendConsole(`POST /store/git-clone ${gitUrl}`);

    try {
      const response = await fetch(`${API_BASE_URL}/store/git-clone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ git_url: gitUrl.trim() })
      });
      if (!response.ok) {
        const text = await response.text();
        notify("error", `Git clone store failed (${response.status}): ${text}`);
        return;
      }
      const data = await response.json();
      notify("success", `Repository stored as ${data?.name || "repo"}.`);
      await refreshStoredItems();
    } catch (error: unknown) {
      notify("error", error instanceof Error ? error.message : "Failed to store cloned repository.");
    } finally {
      setGitStoreLoading(false);
    }
  };

  const handleAnalyzeStored = async () => {
    resetFeedback();
    if (!storedSelection) {
      notify("error", "Please choose a stored project first.");
      return;
    }
    setAnalysisLoading(true);
    setEditorOpen(true);
    startProgress();
    setTimeout(() => editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    appendConsole(`GET /store/analyze/${storedSelection}`);
    try {
      const response = await fetch(`${API_BASE_URL}/store/analyze/${encodeURIComponent(storedSelection)}`);
      if (!response.ok) {
        const text = await response.text();
        notify("error", `Failed to analyze stored project (${response.status}): ${text}`);
        return;
      }
      const data = (await response.json()) as AnalysisResult;
      setAnalysisResult(data);
      notify("success", "Stored project analyzed successfully.");
    } catch (error: unknown) {
      notify("error", error instanceof Error ? error.message : "Failed to analyze stored project.");
    } finally {
      setAnalysisLoading(false);
      stopProgress();
    }
  };

  const handleDeleteStored = async () => {
    resetFeedback();
    if (!storedSelection) {
      notify("error", "Please choose a stored project first.");
      return;
    }
    setStoredDeleting(true);
    appendConsole(`DELETE /store/${storedSelection}`);
    try {
      const response = await fetch(`${API_BASE_URL}/store/${encodeURIComponent(storedSelection)}`, {
        method: "DELETE"
      });
      if (!response.ok) {
        const text = await response.text();
        notify("error", `Failed to delete stored project (${response.status}): ${text}`);
        return;
      }
      notify("success", "Stored project deleted.");
      await refreshStoredItems();
    } catch (error: unknown) {
      notify("error", error instanceof Error ? error.message : "Failed to delete stored project.");
    } finally {
      setStoredDeleting(false);
    }
  };

  const filesToDisplay = useMemo(() => getFilesCollection(analysisResult), [analysisResult]);

  // Findings count per path and aggregation helpers
  const findingsCountByPath = useMemo(() => {
    const map: Record<string, number> = {};
    for (const entry of filesToDisplay) {
      const a = entry.analysis;
      const c = (a.crypto_imports?.length || 0)
        + (a.crypto_functions?.length || 0)
        + (a.crypto_patterns_found?.length || 0)
        + (a.crypto_algorithms_detected?.length || 0);
      map[a.file_path] = c;
    }
    return map;
  }, [filesToDisplay]);

  const getFolderCount = useCallback((folderPath: string) => {
    if (!folderPath) return 0;
    const prefix = folderPath.endsWith('/') ? folderPath : folderPath + '/';
    let sum = 0;
    for (const [p, v] of Object.entries(findingsCountByPath)) {
      if (p.startsWith(prefix)) sum += v;
    }
    return sum;
  }, [findingsCountByPath]);

  // highlight helpers removed; using Monaco viewer in read-only mode only

  const toggleNode = (path: string) => {
    setExpandedNodes(prev => ({ ...prev, [path]: !prev[path] }));
  };

  const startProgress = () => {
    setProgressPct(1);
    if (progressTimerRef.current) clearInterval(progressTimerRef.current);
    progressTimerRef.current = setInterval(() => {
      setProgressPct(prev => Math.min(prev + (Math.random() * 6 + 1), 90));
    }, 350);
  };

  const stopProgress = () => {
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    setProgressPct(100);
    setTimeout(() => setProgressPct(0), 1000);
  };

  const renderFeedback = () => {
    if (!feedback) {
      return null;
    }
    return (
      <div className={`alert ${feedback.type}`}>
        <strong>{feedback.type.toUpperCase()}:</strong>
        <span>{feedback.text}</span>
      </div>
    );
  };

  const renderTreeNodes = (nodes: TreeNode[], depth = 0): JSX.Element => (
    <ul className={`tree-level ${depth === 0 ? "root" : ""}`}>
      {nodes.map(node => {
        const isFolder = node.type === "folder";
        const isExpanded = isFolder ? expandedNodes[node.path] ?? node.level <= 1 : false;
        const count = isFolder ? getFolderCount(node.path) : (findingsCountByPath[node.path] || 0);
        return (
          <li key={node.path} className={`tree-item ${isFolder ? "folder" : "file"}`} data-depth={node.level}>
            <div
              className={`tree-row ${selectedPath === node.path ? "selected" : ""}`}
              onClick={() => { if (!isFolder) { setSelectedPath(node.path); setEditorOpen(true); } }}
              role={!isFolder ? "button" : undefined}
            >
              {isFolder ? (
                <button
                  type="button"
                  className={`tree-toggle ${isExpanded ? "expanded" : ""}`}
                  onClick={() => toggleNode(node.path)}
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
              <span
                className={`tree-label ${ !isFolder ? (node.supported ? "supported" : "unsupported") : "" }`}
              >
                {node.name}
              </span>
              {count > 0 ? <span className="tree-count" title="Total findings">{count}</span> : null}
            </div>
            {isFolder && isExpanded && node.children?.length ? renderTreeNodes(node.children, depth + 1) : null}
          </li>
        );
      })}
    </ul>
  );

  const renderDirectoryTree = () => {
    if (!treeData.length) {
      return null;
    }

    const supportedCount = directoryStructure.filter(entry => entry.type === "file" && entry.supported).length;
    const totalFiles = directoryStructure.filter(entry => entry.type === "file").length;
    const totalFolders = directoryStructure.filter(entry => entry.type === "folder").length;

    return (
      <div className="fade-in">
        <div className="metrics-grid">
          <MetricCard label="Folders" value={totalFolders} help="Total directories discovered" />
          <MetricCard label="Files" value={totalFiles} help="All files encountered during the scan" />
          <MetricCard label="Supported Files" value={supportedCount} help="Files that will be analyzed" />
        </div>
        <div className="directory-tree">{renderTreeNodes(treeData)}</div>
      </div>
    );
  };

  const renderStoredTable = () => {
    if (storedLoading) {
      return <p>Loading stored projects…</p>;
    }
    if (!storedItems.length) {
      return <div className="empty-state">No stored projects yet. Upload or clone to store datasets.</div>;
    }
    return (
      <div className="fade-in">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Files</th>
              <th>Size</th>
              <th>Path</th>
            </tr>
          </thead>
          <tbody>
            {storedItems.map(item => (
              <tr key={item.name}>
                <td>{item.name}</td>
                <td>{item.files}</td>
                <td>{formatBytes(item.size_bytes)}</td>
                <td className="path-cell">{item.path}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  const renderCharts = () => {
    if (!analysisResult || !showCharts) {
      return null;
    }
    const chartData = getChartData;
    if (!chartData) {
      return null;
    }
    const { fileNames, functionCounts, importCounts, patternCounts, totals } = chartData;

    return (
      <section className="fade-in" style={{ marginTop: "2.5rem" }}>
        <h2 className="section-title">Analysis Charts</h2>
        <p className="section-subtitle">Visual breakdown of cryptographic elements found during the scan.</p>
        <div className="charts-grid">
          <div className="panel" style={{ padding: "1.5rem" }}>
            <Plot
              data={[
                {
                  type: "bar",
                  name: "Functions",
                  x: fileNames,
                  y: functionCounts,
                  marker: { color: "#667eea" }
                },
                {
                  type: "bar",
                  name: "Imports",
                  x: fileNames,
                  y: importCounts,
                  marker: { color: "#f093fb" }
                },
                {
                  type: "bar",
                  name: "Patterns",
                  x: fileNames,
                  y: patternCounts,
                  marker: { color: "#764ba2" }
                }
              ]}
              layout={{
                barmode: "group",
                height: 380,
                paper_bgcolor: "rgba(0,0,0,0)",
                plot_bgcolor: "rgba(0,0,0,0)",
                title: "Cryptographic elements per file",
                margin: { t: 60, r: 24, l: 48, b: 120 }
              }}
              config={{ displayModeBar: false, responsive: true }}
              style={{ width: "100%", height: "100%" }}
            />
          </div>
          <div className="panel" style={{ padding: "1.5rem" }}>
            <Plot
              data={[
                {
                  type: "pie",
                  labels: ["Functions", "Imports", "Patterns"],
                  values: [totals.functions, totals.imports, totals.patterns],
                  hole: 0.35,
                  marker: {
                    colors: ["#667eea", "#f093fb", "#764ba2"]
                  }
                }
              ]}
              layout={{
                height: 380,
                paper_bgcolor: "rgba(0,0,0,0)",
                title: "Distribution of cryptographic elements",
                margin: { t: 60, r: 24, l: 24, b: 24 }
              }}
              config={{ displayModeBar: false, responsive: true }}
              style={{ width: "100%", height: "100%" }}
            />
          </div>
        </div>
      </section>
    );
  };

  const renderFileAnalysis = () => {
    if (!filesToDisplay.length) {
      if (analysisResult?.message) {
        return <div className="alert success">{analysisResult.message}</div>;
      }
      return <div className="alert info">No cryptographic files detected in the latest run.</div>;
    }

    return (
      <section className="fade-in" style={{ marginTop: "2.5rem" }}>
        <h2 className="section-title">Detailed File Analysis</h2>
        <p className="section-subtitle">Dive into each flagged file, review code snippets, summaries, and AI commentary.</p>
        <div className="file-analysis-stack" style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          {filesToDisplay.map(entry => {
            const fileKey = entry.analysis.file_path;
            const activeTab = getTabSelection(fileKey);
            const aiAnalysis = entry.review?.gemini_analysis;
            const summary = entry.review?.crypto_summary;

            return (
              <article className="file-card" key={fileKey}>
                <header>
                  <div>
                    <h3>{entry.analysis.file_name}</h3>
                    <div className="file-meta">
                      <span>Path: {entry.analysis.file_path}</span>
                      <span>Extension: {entry.analysis.file_extension}</span>
                    </div>
                  </div>
                  <div className="badge-row">
                    {summary?.security_level ? (
                      <span
                        className={`badge ${
                          summary.security_level?.toLowerCase().includes("high")
                            ? "severity-high"
                            : summary.security_level?.toLowerCase().includes("medium")
                            ? "severity-medium"
                            : summary.security_level?.toLowerCase().includes("low")
                            ? "severity-low"
                            : ""
                        }`}
                      >
                        Security: {summary.security_level}
                      </span>
                    ) : null}
                    <Badge
                      variant="imports"
                      label={`${entry.analysis.crypto_imports?.length || 0} Imports`}
                      hidden={!entry.analysis.crypto_imports?.length}
                    />
                    <Badge
                      variant="functions"
                      label={`${entry.analysis.crypto_functions?.length || 0} Functions`}
                      hidden={!entry.analysis.crypto_functions?.length}
                    />
                    <Badge
                      variant="patterns"
                      label={`${entry.analysis.crypto_patterns_found?.length || 0} Patterns`}
                      hidden={!entry.analysis.crypto_patterns_found?.length}
                    />
                    <Badge
                      variant="algorithms"
                      label={`${entry.analysis.crypto_algorithms_detected?.length || 0} Algorithms`}
                      hidden={!entry.analysis.crypto_algorithms_detected?.length}
                    />
                  </div>
                </header>

                <div className="tab-strip">
                  {TABS.map(tab => (
                    <button
                      key={`${fileKey}-${tab}`}
                      className={`tab-button ${activeTab === tab ? "active" : ""}`}
                      onClick={() => setFileTab(fileKey, tab)}
                    >
                      {tab}
                    </button>
                  ))}
                </div>

                <div className="tab-content">
                  {activeTab === "Imports" && (
                    entry.analysis.crypto_imports?.length ? (
                      entry.analysis.crypto_imports.map((imp, idx) => (
                        <CodeViewer key={`${fileKey}-import-${idx}`} value={imp} extension={entry.analysis.file_extension} />
                      ))
                    ) : (
                      <div className="alert info">No cryptographic imports found.</div>
                    )
                  )}

                  {activeTab === "Functions" && (
                    entry.analysis.crypto_functions?.length ? (
                      entry.analysis.crypto_functions.map((func, idx) => (
                        <div key={`${fileKey}-func-${idx}`}>
                          <strong>
                            {func.name || "Unnamed"} {func.line_start ? `(line ${func.line_start})` : ""}
                          </strong>
                          {func.content ? (
                            <CodeViewer value={func.content} extension={entry.analysis.file_extension} />
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <div className="alert info">No cryptographic functions detected.</div>
                    )
                  )}

                  {activeTab === "Patterns" && (
                    entry.analysis.crypto_patterns_found?.length ? (
                      <ul>
                        {entry.analysis.crypto_patterns_found.map(pattern => (
                          <li key={`${fileKey}-pattern-${pattern}`}>{pattern}</li>
                        ))}
                      </ul>
                    ) : (
                      <div className="alert info">No cryptographic patterns matched.</div>
                    )
                  )}

                  {activeTab === "Algorithms" && (
                    entry.analysis.crypto_algorithms_detected?.length ? (
                      <ul>
                        {entry.analysis.crypto_algorithms_detected.map((algo, idx) => (
                          <li key={`${fileKey}-algo-${idx}`}>
                            {Object.entries(algo)
                              .map(([key, value]) => `${key}: ${String(value)}`)
                              .join(" • ")}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="alert info">No specific algorithms flagged in this file.</div>
                    )
                  )}

                  {activeTab === "Code Snippets" && (
                    entry.analysis.code_snippets?.length ? (
                      entry.analysis.code_snippets.map((snippet, idx) => (
                        <div key={`${fileKey}-snippet-${idx}`}>
                          <strong>
                            {snippet.name || snippet.type || "Snippet"}
                            {snippet.line_start ? ` (line ${snippet.line_start})` : ""}
                          </strong>
                          {snippet.code ? (
                            <CodeViewer value={snippet.code} extension={entry.analysis.file_extension} />
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <div className="alert info">No code snippets captured for this file.</div>
                    )
                  )}

                  {activeTab === "AI Analysis" && (
                    aiAnalysis ? (
                      <div className="alert info" style={{ whiteSpace: "pre-wrap" }}>
                        {aiAnalysis}
                      </div>
                    ) : summary ? (
                      <div className="alert info">
                        <SummaryDisplay {...summary} />
                      </div>
                    ) : (
                      <div className="alert info">No AI commentary is available for this file.</div>
                    )
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>
    );
  };

  const handleGetStarted = () => {
    if (!session) {
      signIn('google');
      return;
    }
    setHasStarted(true);
  };

  const directoryIsGit = isGitUrl(directoryPath.trim());

  const findings = useMemo(() => {
    const v: string[] = [];
    const r: string[] = [];
    if (analysisResult?.detailed_reviews?.length) {
      for (const rev of analysisResult.detailed_reviews) {
        const sum = rev.crypto_summary as any;
        if (sum?.vulnerabilities?.length) v.push(...sum.vulnerabilities);
        if (sum?.recommendations?.length) r.push(...sum.recommendations);
      }
    }
    const uniq = (arr: string[]) => Array.from(new Set(arr)).filter(Boolean);
    return { vulnerabilities: uniq(v), recommendations: uniq(r) };
  }, [analysisResult]);

  return (
    <main className={`page ${hasStarted ? "started" : ""}`}>
      <nav className="navbar">
        <div className="navbar-inner">
          <div className="brand">Digital Fortress</div>
          <div className="nav-links">
            <a href="#overview">Overview</a>
            <a href="#features">Features</a>
            <a href="/analyzer">Analyzer</a>
          </div>
          <button
            className="nav-toggle"
            type="button"
            aria-label="Toggle navigation"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen(prev => !prev)}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
          </button>
          <div className="nav-actions">
            {!session ? (
              <button className="google-button" onClick={() => signIn('google')}>
                <svg className="google-icon" viewBox="0 0 533.5 544.3" xmlns="http://www.w3.org/2000/svg">
                  <path fill="#4285F4" d="M533.5 278.4c0-17.4-1.6-34.1-4.6-50.2H272v95.0h147.4c-6.3 34-25 62.8-53.4 82.1v68.2h86.5c50.6-46.6 80-115.3 80-195.1z"/>
                  <path fill="#34A853" d="M272 544.3c72.6 0 133.6-24.1 178.1-65.8l-86.5-68.2c-24 16.1-54.6 25.6-91.6 25.6-70.4 0-130.1-47.5-151.5-111.3H31.6v69.9C76 483.2 167.9 544.3 272 544.3z"/>
                  <path fill="#FBBC05" d="M120.5 324.6c-10.2-30.6-10.2-63.8 0-94.4V160.3H31.6C-10.5 240.5-10.5 343.7 31.6 424z"/>
                  <path fill="#EA4335" d="M272 107.7c39.5-.6 77.2 14 106 40.9l79.2-79.2C405.3 23.5 341.7-.4 272 0 167.9 0 76 61.1 31.6 160.3l88.9 69.9C141.9 155.9 201.6 108.4 272 107.7z"/>
                </svg>
                <span>Sign in with Google</span>
              </button>
            ) : (
              <>
                <span style={{ color: 'var(--text-secondary)', fontSize: '.9rem' }}>{session.user?.name}</span>
                {session.user?.image ? <img className="avatar" src={session.user.image} alt="avatar" /> : null}
                <button className="ghost-button" onClick={() => signOut()}>Sign out</button>
              </>
            )}
          </div>
        </div>
        {mobileNavOpen ? (
          <div className="mobile-nav">
            <a href="#overview" onClick={() => setMobileNavOpen(false)}>Overview</a>
            <a href="#features" onClick={() => setMobileNavOpen(false)}>Features</a>
            <a href="/analyzer" onClick={() => setMobileNavOpen(false)}>Analyzer</a>
          </div>
        ) : null}
      </nav>
      <section className="hero-section" id="overview">
        <div className="hero-inner">
          <h1 className="hero-heading">Cryptographic code analyzer</h1>
          <p className="hero-subheading">
            Audit cryptographic usage across your repositories with clarity. Move from triage to deep analysis with a streamlined workflow tailored for security engineers.
          </p>
          <div className="hero-actions">
            {!session ? (
              <button className="google-button hero-button" onClick={() => signIn('google')}>
                <svg className="google-icon" viewBox="0 0 533.5 544.3" xmlns="http://www.w3.org/2000/svg">
                  <path fill="#4285F4" d="M533.5 278.4c0-17.4-1.6-34.1-4.6-50.2H272v95.0h147.4c-6.3 34-25 62.8-53.4 82.1v68.2h86.5c50.6-46.6 80-115.3 80-195.1z"/>
                  <path fill="#34A853" d="M272 544.3c72.6 0 133.6-24.1 178.1-65.8l-86.5-68.2c-24 16.1-54.6 25.6-91.6 25.6-70.4 0-130.1-47.5-151.5-111.3H31.6v69.9C76 483.2 167.9 544.3 272 544.3z"/>
                  <path fill="#FBBC05" d="M120.5 324.6c-10.2-30.6-10.2-63.8 0-94.4V160.3H31.6C-10.5 240.5-10.5 343.7 31.6 424z"/>
                  <path fill="#EA4335" d="M272 107.7c39.5-.6 77.2 14 106 40.9l79.2-79.2C405.3 23.5 341.7-.4 272 0 167.9 0 76 61.1 31.6 160.3l88.9 69.9C141.9 155.9 201.6 108.4 272 107.7z"/>
                </svg>
                <span>Sign in with Google</span>
              </button>
            ) : (
              <button className="primary-button hero-button" onClick={handleGetStarted}>Analyze now</button>
            )}
          </div>
        </div>
      </section>
      <section id="features" className="page-shell" style={{ paddingTop: 0 }}>
        <h2 className="section-title">Features</h2>
        <p className="section-subtitle">A streamlined workspace with smart detection, clear visuals, and helpful summaries.</p>
        <div className="card-grid">
          <article className="panel">
            <div className="panel-body">
              <div className="feature-grid">
                <div className="feature-card">
                  <div className="feature-icon" aria-hidden>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 4h7l2 2h7v12a2 2 0 0 1-2 2H4V4z" stroke="currentColor" strokeWidth="1.3"/><path d="M7 9h10M7 13h6" stroke="currentColor" strokeWidth="1.3"/></svg>
                  </div>
                  <h3>Scan any source</h3>
                  <p>Analyze local directories, uploaded ZIPs, or remote Git repositories.</p>
                </div>
                <div className="feature-card">
                  <div className="feature-icon" aria-hidden>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2l7 4v6c0 5-3.5 9-7 10-3.5-1-7-5-7-10V6l7-4z" stroke="currentColor" strokeWidth="1.3"/><path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.3"/></svg>
                  </div>
                  <h3>Detect crypto usage</h3>
                  <p>Identify imports, functions, patterns, and algorithms across languages.</p>
                </div>
                <div className="feature-card">
                  <div className="feature-icon" aria-hidden>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 3v4m0 10v4M3 12h4m10 0h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" stroke="currentColor" strokeWidth="1.3"/></svg>
                  </div>
                  <h3>AI summaries</h3>
                  <p>Consolidated findings with vulnerabilities and recommendations.</p>
                </div>
                <div className="feature-card">
                  <div className="feature-icon" aria-hidden>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.3"/><path d="M7 8h10M7 12h6" stroke="currentColor" strokeWidth="1.3"/></svg>
                  </div>
                  <h3>Code preview</h3>
                  <p>Read‑only editor with inline highlighting and quick navigation.</p>
                </div>
                <div className="feature-card">
                  <div className="feature-icon" aria-hidden>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 7h16v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7z" stroke="currentColor" strokeWidth="1.3"/><path d="M4 7l2-3h12l2 3" stroke="currentColor" strokeWidth="1.3"/></svg>
                  </div>
                  <h3>Store or analyze on the fly</h3>
                  <p>Keep datasets for later or run quick one‑off scans.</p>
                </div>
                <div className="feature-card">
                  <div className="feature-icon" aria-hidden>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.3"/><path d="M3 12h18M12 3c3 3.5 3 9.5 0 15M12 3c-3 3.5-3 9.5 0 15" stroke="currentColor" strokeWidth="1.1"/></svg>
                  </div>
                  <h3>Multi‑language support</h3>
                  <p>Works across Python, JS/TS, C/C++, Java, and more.</p>
                </div>
              </div>
            </div>
          </article>
          
          
        </div>
      </section>


      

      <div ref={analyzerRef} className={`analyzer-wrapper visible`} id="analyzer">
        <div className="page-shell analyzer-shell">
          {!session ? (
            <section className="fade-in" style={{ padding: "2rem" }}>
              <h2 className="section-title">Sign in to use the analyzer</h2>
              <p className="section-subtitle">Authenticate with Google to start scanning code and reviewing findings.</p>
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
          ) : (
            <>
            {editorOpen && (
              <section ref={editorRef} className="editor-shell fade-in">
                <div className="editor-top">
                  <h2>Editor</h2>
                  {(analysisLoading || uploadLoading || gitAnalyzeLoading) && (
                    <div className="progress">
                      <div className="bar" style={{ width: `${progressPct}%` }} />
                      <span className="progress-label">
                        {progressPct > 0 && progressPct < 100
                          ? `Analyzing… ${Math.floor(progressPct)}%`
                          : progressPct === 100
                          ? "Analysis Complete"
                          : ""}
                      </span>
                    </div>
                  )}
                </div>
                <div className="editor-grid">
                  <aside className="editor-sidebar panel">
                    <div className="panel-header"><h3>Project Files</h3></div>
                    <div className="panel-body">
                      <div className="directory-tree">
                        {treeData.length ? (
                          renderTreeNodes(treeData)
                        ) : (
                          <div className="empty-state">Tree will appear after scanning starts.</div>
                        )}
                      </div>
                    </div>
                  </aside>
                  <div className="editor-view">
                    {selectedPath ? (
                      <EditorContent selectedPath={selectedPath} files={filesToDisplay} />
                    ) : (
                      <div className="empty-state">
                        Select a file from the tree to preview code snippets.
                      </div>
                    )}
                  </div>
                </div>
              </section>
            )}
            <div className="analyzer-top">
              <div>
                <h2>Analyzer</h2>
                <p>Configure sources, run scans, and review cryptographic findings.</p>
              </div>
            </div>

            <div className="card-grid">
              <article className="panel">
                <div className="panel-header">
                  <h2>Analysis Controls</h2>
                  <p>Select an ingestion mode, configure inputs, and launch analysis jobs.</p>
                </div>
                <div className="panel-body">
                  <div className="mode-list">
                    {MODES.map(item => (
                      <button
                        key={item.id}
                        className={`mode-button ${mode === item.id ? "active" : ""}`}
                        onClick={() => {
                          setMode(item.id);
                          resetFeedback();
                        }}
                      >
                        <div>
                          <div>{item.title}</div>
                          <span>{item.description}</span>
                        </div>
                        <span className="small-caps">{item.hint}</span>
                      </button>
                    ))}
                  </div>

                  {renderFeedback()}

                  {mode === "local" && (
                    <form className="field-group" onSubmit={handleLocalAnalyze}>
                      <label htmlFor="directory-path">Directory Path or Git URL</label>
                      <input
                        id="directory-path"
                        placeholder="/path/to/project or https://github.com/org/repo.git"
                        value={directoryPath}
                        onChange={event => setDirectoryPath(event.target.value)}
                      />
                      <div className="btn-row">
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => void fetchDirectoryStructure()}
                          disabled={structureLoading || directoryIsGit}
                          title={
                            directoryIsGit
                              ? "Preview is only available for directories on this machine"
                              : undefined
                          }
                        >
                          {structureLoading ? "Scanning…" : "Preview Structure"}
                        </button>
                        <button type="submit" className="primary-button" disabled={analysisLoading}>
                          {analysisLoading
                            ? "Analyzing…"
                            : directoryIsGit
                            ? "Analyze Repository"
                            : "Analyze Directory"}
                        </button>
                      </div>
                      {renderDirectoryTree()}
                    </form>
                  )}

                  {mode === "upload" && (
                    <div className="field-group">
                      <label htmlFor="zip-upload">ZIP Archive</label>
                      <input
                        id="zip-upload"
                        type="file"
                        accept=".zip"
                        onChange={event => {
                          const file = event.target.files?.[0] ?? null;
                          setZipFile(file);
                        }}
                      />
                      <div className="btn-row">
                        <button
                          className="primary-button"
                          type="button"
                          disabled={uploadLoading}
                          onClick={() => void handleUploadAnalyze()}
                        >
                          {uploadLoading ? "Uploading…" : "Analyze ZIP"}
                        </button>
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={uploadStoring}
                          onClick={() => void handleUploadStore()}
                        >
                          {uploadStoring ? "Storing…" : "Store for Later"}
                        </button>
                      </div>
                    </div>
                  )}

                  {mode === "git" && (
                    <div className="field-group">
                      <label htmlFor="git-url">Repository URL</label>
                      <input
                        id="git-url"
                        placeholder="https://github.com/org/repo.git"
                        value={gitUrl}
                        onChange={event => setGitUrl(event.target.value)}
                      />
                      <div className="btn-row">
                        <button
                          type="button"
                          className="primary-button"
                          disabled={gitAnalyzeLoading}
                          onClick={() => void handleGitAnalyze()}
                        >
                          {gitAnalyzeLoading ? "Analyzing…" : "Analyze Repository"}
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={gitStoreLoading}
                          onClick={() => void handleGitStore()}
                        >
                          {gitStoreLoading ? "Storing…" : "Store Repository"}
                        </button>
                      </div>
                    </div>
                  )}

                  {mode === "stored" && (
                    <div className="field-group">
                      <label htmlFor="stored-select">Stored Projects</label>
                      <select
                        id="stored-select"
                        value={storedSelection}
                        onChange={event => setStoredSelection(event.target.value)}
                        disabled={storedLoading}
                      >
                        {storedItems.length === 0 ? (
                          <option value="">No stored projects</option>
                        ) : null}
                        {storedItems.map(item => (
                          <option key={item.name} value={item.name}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
                        <button
                          type="button"
                          className="primary-button"
                          onClick={() => void handleAnalyzeStored()}
                          disabled={analysisLoading || !storedSelection}
                        >
                          {analysisLoading ? "Analyzing…" : "Analyze Stored"}
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => void handleDeleteStored()}
                          disabled={storedDeleting || !storedSelection}
                        >
                          {storedDeleting ? "Deleting…" : "Delete Stored"}
                        </button>
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={() => void refreshStoredItems()}
                        >
                          Refresh List
                        </button>
                      </div>
                      {renderStoredTable()}
                    </div>
                  )}

                  <div className="toggle-row">
                    <label htmlFor="show-charts">Display Charts</label>
                    <label className="switch">
                      <input
                        id="show-charts"
                        type="checkbox"
                        checked={showCharts}
                        onChange={event => setShowCharts(event.target.checked)}
                      />
                      <span className="slider" />
                    </label>
                  </div>
                </div>
              </article>

              
            </div>

            {analysisResult && (
              <section className="fade-in" style={{ marginTop: "3rem" }}>
                <h2 className="section-title">Analysis Overview</h2>
                <p className="section-subtitle">High-level metrics summarizing the most recent run.</p>
                <div className="metrics-grid">
                  <MetricCard
                    label="Total Files Scanned"
                    value={analysisResult.total_files ?? 0}
                    help="Number of files inspected for cryptographic artefacts."
                  />
                  <MetricCard
                    label="Crypto Files Found"
                    value={analysisResult.crypto_files_found ?? 0}
                    help="Files containing cryptographic imports, functions, or patterns."
                  />
                  <MetricCard
                    label="AI Reviews"
                    value={analysisResult.detailed_reviews?.length ?? 0}
                    help="Files that received a Gemini reviewer summary."
                  />
                  <MetricCard
                    label="Crypto Coverage"
                    value={`${computeCoverage(analysisResult.crypto_files_found, analysisResult.total_files)}%`}
                    help="Share of analyzed files that include cryptographic logic."
                  />
                </div>
              </section>
            )}

            {analysisResult?.detailed_reviews?.length ? (
              <section className="fade-in" style={{ marginTop: "2rem" }}>
                <h2 className="section-title">Findings</h2>
                <p className="section-subtitle">Consolidated vulnerabilities and recommendations across files.</p>
                <div className="card-grid">
                  <article className="panel">
                    <div className="panel-header"><h2>Potential Vulnerabilities</h2></div>
                    <div className="panel-body">
                      {findings.vulnerabilities.length ? (
                        <ul>
                          {findings.vulnerabilities.map((item, i) => (
                            <li key={`vuln-${i}`}>{item}</li>
                          ))}
                        </ul>
                      ) : (
                        <div className="empty-state">No vulnerabilities summarized. Review per-file AI analysis.</div>
                      )}
                    </div>
                  </article>
                  <article className="panel">
                    <div className="panel-header"><h2>Recommendations</h2></div>
                    <div className="panel-body">
                      {findings.recommendations.length ? (
                        <ul>
                          {findings.recommendations.map((item, i) => (
                            <li key={`rec-${i}`}>{item}</li>
                          ))}
                        </ul>
                      ) : (
                        <div className="empty-state">No recommendations summarized. Review per-file AI analysis.</div>
                      )}
                    </div>
                  </article>
                </div>
              </section>
            ) : null}

            {renderCharts()}
            {renderFileAnalysis()}

            <footer className="footer">© Digital Fortress</footer>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

type MetricCardProps = {
  label: string;
  value: string | number;
  help?: string;
};

function MetricCard({ label, value, help }: MetricCardProps) {
  return (
    <div className="metric-card">
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
      {help ? <span className="metric-help">{help}</span> : null}
    </div>
  );
}

type BadgeProps = {
  variant: "imports" | "functions" | "patterns" | "algorithms";
  label: string;
  hidden?: boolean;
};

function Badge({ variant, label, hidden }: BadgeProps) {
  if (hidden) {
    return null;
  }
  return <span className={`badge ${variant}`}>{label}</span>;
}

type SummaryDisplayProps = NonNullable<GeminiReview["crypto_summary"]>;

function SummaryDisplay({
  security_level,
  algorithms_used,
  crypto_functions_identified,
  data_being_hashed,
  vulnerabilities,
  recommendations
}: SummaryDisplayProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      {security_level && (
        <div>
          <strong>Security Level:</strong> {security_level}
        </div>
      )}
      {algorithms_used?.length ? (
        <div>
          <strong>Algorithms Used:</strong>
          <ul>
            {algorithms_used.map(algo => (
              <li key={algo}>{algo}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {crypto_functions_identified?.length ? (
        <div>
          <strong>Functions Identified:</strong>
          <ul>
            {crypto_functions_identified.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {data_being_hashed?.length ? (
        <div>
          <strong>Data Hashed/Encrypted:</strong>
          <ul>
            {data_being_hashed.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {vulnerabilities?.length ? (
        <div>
          <strong>Potential Vulnerabilities:</strong>
          <ul>
            {vulnerabilities.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {recommendations?.length ? (
        <div>
          <strong>Recommendations:</strong>
          <ul>
            {recommendations.map(item => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function computeCoverage(cryptoFiles?: number, totalFiles?: number) {
  if (!cryptoFiles || !totalFiles) {
    return (0).toFixed(1);
  }
  if (totalFiles === 0) {
    return (0).toFixed(1);
  }
  return ((cryptoFiles / totalFiles) * 100).toFixed(1);
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  let value = bytes;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}

type FilesCollectionEntry = {
  analysis: BasicCryptoAnalysis;
  review?: GeminiReview;
};

function getFilesCollection(result: AnalysisResult | null): FilesCollectionEntry[] {
  if (!result) {
    return [];
  }
  if (result.detailed_reviews?.length) {
    return result.detailed_reviews
      .map(review => ({
        analysis: review.original_analysis || (review as unknown as BasicCryptoAnalysis),
        review
      }))
      .filter(entry => Boolean(entry.analysis));
  }
  if (result.basic_analysis?.length) {
    return result.basic_analysis.map(analysis => ({ analysis }));
  }
  return [];
}

// Top-level helper so both page and editor content can reuse it
// buildHighlightsForAnalysis removed

type EditorContentProps = {
  selectedPath: string;
  files: FilesCollectionEntry[];
};

function EditorContent({ selectedPath, files }: EditorContentProps) {
  const entry = files.find(f => f.analysis.file_path === selectedPath);
  if (!entry) {
    return <div className="empty-state">No analysis available for {selectedPath}.</div>;
  }
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
  return (
    <div className="empty-state">
      No code snippets captured for this file. Try reviewing Imports or Functions in the sections below.
    </div>
  );
}

export default function HomePage() {
  return (
    <SessionProvider>
      <HomeContent />
    </SessionProvider>
  );
}
