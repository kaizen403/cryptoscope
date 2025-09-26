"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SessionProvider, useSession, signIn } from "next-auth/react";
import CodeViewer from "../../components/CodeViewer";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://35.200.140.65:5001/api";

type Mode = "local" | "upload" | "git" | "stored";

type DirectoryEntry = { type: "folder" | "file"; name: string; path: string; level: number; supported?: boolean };
type TreeNode = { name: string; path: string; type: "folder" | "file"; level: number; supported?: boolean; children?: TreeNode[] };

type CryptoFunction = { name?: string; line_start?: number; content?: string; type?: string };
type CryptoSnippet = { name?: string; line_start?: number; code?: string; type?: string };
type BasicCryptoAnalysis = {
  file_path: string; file_name: string; file_extension: string; has_crypto: boolean;
  crypto_imports?: string[]; crypto_functions?: CryptoFunction[]; crypto_patterns_found?: string[];
  crypto_algorithms_detected?: Array<Record<string, unknown>>; code_snippets?: CryptoSnippet[];
};
type GeminiReview = { original_analysis?: BasicCryptoAnalysis; gemini_analysis?: string; crypto_summary?: any };
type AnalysisResult = { status?: string; total_files?: number; crypto_files_found?: number; message?: string; basic_analysis?: BasicCryptoAnalysis[]; detailed_reviews?: GeminiReview[] };

function buildTree(entries: DirectoryEntry[]): TreeNode[] {
  const tree: TreeNode[] = []; const stack: TreeNode[] = [];
  for (const entry of entries) {
    const node: TreeNode = { name: entry.name, path: entry.path, type: entry.type, level: entry.level, supported: entry.supported, children: entry.type === 'folder' ? [] : undefined };
    while (stack.length && stack[stack.length-1].level >= entry.level) stack.pop();
    if (!stack.length) tree.push(node); else (stack[stack.length-1].children ||= []).push(node);
    if (entry.type === 'folder') stack.push(node);
  }
  return tree;
}

function getFilesCollection(result: AnalysisResult | null) {
  if (!result) return [] as { analysis: BasicCryptoAnalysis; review?: GeminiReview }[];
  if (result.detailed_reviews?.length) return result.detailed_reviews.map(r => ({ analysis: r.original_analysis || (r as unknown as BasicCryptoAnalysis), review: r })).filter(x => x.analysis);
  if (result.basic_analysis?.length) return result.basic_analysis.map(a => ({ analysis: a }));
  return [];
}

function EditorContent({ selectedPath, files }: { selectedPath: string; files: { analysis: BasicCryptoAnalysis; review?: GeminiReview }[] }) {
  const entry = files.find(f => f.analysis.file_path === selectedPath);
  if (!entry) return <div className="empty-state">No analysis available for {selectedPath}.</div>;
  const a = entry.analysis;
  if (a.code_snippets?.length) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {a.code_snippets.map((snip, i) => (
          <div key={`snip-${i}`}>
            <strong>{snip.name || snip.type || 'Snippet'}{snip.line_start ? ` (line ${snip.line_start})` : ''}</strong>
            {snip.code ? <CodeViewer value={snip.code} extension={a.file_extension} /> : null}
          </div>
        ))}
      </div>
    );
  }
  return <div className="empty-state">No code snippets captured for this file.</div>;
}

function AnalyzerPageInner() {
  const { data: session } = useSession();
  const [mode, setMode] = useState<Mode>('local');
  const [directoryPath, setDirectoryPath] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [treeEntries, setTreeEntries] = useState<DirectoryEntry[]>([]);
  const treeData = useMemo(() => buildTree(treeEntries), [treeEntries]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [progressPct, setProgressPct] = useState(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const files = useMemo(() => getFilesCollection(analysisResult), [analysisResult]);

  const startProgress = () => {
    setProgressPct(1);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => setProgressPct(prev => Math.min(prev + (Math.random()*6+1), 92)), 320);
  };
  const stopProgress = () => { if (timerRef.current) clearInterval(timerRef.current); setProgressPct(100); setTimeout(()=>setProgressPct(0), 700); };

  const fetchDirectoryTree = useCallback(async (p: string) => {
    try {
      const res = await fetch(`/api/directory-structure?path=${encodeURIComponent(p)}`);
      if (!res.ok) return;
      const payload = await res.json();
      const entries = (payload?.entries || []) as DirectoryEntry[];
      setTreeEntries(entries);
      const defaults: Record<string, boolean> = {};
      entries.forEach(e => { if (e.type === 'folder' && e.level <= 1) defaults[e.path] = true; });
      setExpanded(defaults);
    } catch {}
  }, []);

  const onAnalyzeLocal = async () => {
    if (!directoryPath.trim()) return;
    setLoading(true); startProgress();
    try {
      const res = await fetch(`${API_BASE_URL}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: directoryPath.trim() }) });
      const data = await res.json(); setAnalysisResult(data);
      await fetchDirectoryTree(directoryPath.trim());
    } finally { setLoading(false); stopProgress(); }
  };
  const onAnalyzeGit = async () => {
    if (!gitUrl.trim()) return;
    setLoading(true); startProgress();
    try { const res = await fetch(`${API_BASE_URL}/git-clone`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ git_url: gitUrl.trim() }) }); const data = await res.json(); setAnalysisResult(data);
      // tree from file paths in results
      const paths = getFilesCollection(data).map(f => f.analysis.file_path);
      // create synthetic entries
      const entries: DirectoryEntry[] = [];
      paths.forEach(p=>{ const parts=p.split('/').filter(Boolean); let agg=''; parts.forEach((seg,i)=>{ agg += '/'+seg; entries.push({ type: i===parts.length-1?'file':'folder', name: seg, path: agg, level: i, supported: true }); }); });
      setTreeEntries(entries);
    } finally { setLoading(false); stopProgress(); }
  };
  const onAnalyzeZip = async () => {
    if (!zipFile) return;
    setLoading(true); startProgress();
    try { const fd = new FormData(); fd.append('file', zipFile); const res = await fetch(`${API_BASE_URL}/upload-zip`, { method:'POST', body: fd }); const data = await res.json(); setAnalysisResult(data);
    } finally { setLoading(false); stopProgress(); }
  };

  const toggle = (p: string) => setExpanded(prev => ({ ...prev, [p]: !prev[p] }));
  const renderNodes = (nodes: TreeNode[], depth = 0): JSX.Element => (
    <ul className={`tree-level ${depth===0? 'root':''}`}>
      {nodes.map(node => {
        const isFolder = node.type === 'folder';
        const isExpanded = isFolder ? expanded[node.path] ?? node.level <= 1 : false;
        return (
          <li key={node.path} className={`tree-item ${isFolder ? 'folder':'file'}`} data-depth={node.level}>
            <div className={`tree-row ${selectedPath === node.path ? 'selected':''}`} onClick={() => { if (!isFolder) setSelectedPath(node.path); }} role={!isFolder ? 'button': undefined}>
              {isFolder ? (
                <button type="button" className={`tree-toggle ${isExpanded ? 'expanded':''}`} onClick={() => toggle(node.path)} aria-label={`${isExpanded?'Collapse':'Expand'} folder ${node.name}`} />
              ) : <span className="tree-toggle placeholder" aria-hidden="true" />}
              <span className="tree-icon" aria-hidden="true">{isFolder ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 6.75A2.75 2.75 0 0 1 5.75 4h4.086a1.75 1.75 0 0 1 1.237.513l1.414 1.414c.328.328.773.513 1.237.513H18.25A2.75 2.75 0 0 1 21 9.19v8.06A2.75 2.75 0 0 1 18.25 20H5.75A2.75 2.75 0 0 1 3 17.25V6.75z" fill="currentColor"/></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 3.75A1.75 1.75 0 0 1 8.75 2h4.69c.464 0 .909..185 1.237.513l3.81 3.81c.328.328.513.773.513 1.237v12.69A1.75 1.75 0 0 1 17.25 22H8.75A1.75 1.75 0 0 1 7 20.25V3.75z" stroke="currentColor" fill="none"/><path d="M14 2.5v3.25A1.25 1.25 0 0 0 15.25 7H18.5" stroke="currentColor"/></svg>
              )}</span>
              <span className={`tree-label ${!isFolder ? 'supported':''}`}>{node.name}</span>
            </div>
            {isFolder && isExpanded && node.children?.length ? renderNodes(node.children, depth+1) : null}
          </li>
        );
      })}
    </ul>
  );

  if (!session) {
    return (
      <main className="page started">
        <div className="page-shell analyzer-shell">
          <section className="fade-in" style={{ padding: '2rem' }}>
            <h2 className="section-title">sign in to use the analyzer</h2>
            <p className="section-subtitle">authenticate with google to start scanning code and reviewing findings.</p>
            <button className="google-button" onClick={() => signIn('google')}>
              <svg className="google-icon" viewBox="0 0 533.5 544.3" xmlns="http://www.w3.org/2000/svg"><path fill="#4285F4" d="M533.5 278.4c0-17.4-1.6-34.1-4.6-50.2H272v95.0h147.4c-6.3 34-25 62.8-53.4 82.1v68.2h86.5c50.6-46.6 80-115.3 80-195.1z"/><path fill="#34A853" d="M272 544.3c72.6 0 133.6-24.1 178.1-65.8l-86.5-68.2c-24 16.1-54.6 25.6-91.6 25.6-70.4 0-130.1-47.5-151.5-111.3H31.6v69.9C76 483.2 167.9 544.3 272 544.3z"/><path fill="#FBBC05" d="M120.5 324.6c-10.2-30.6-10.2-63.8 0-94.4V160.3H31.6C-10.5 240.5-10.5 343.7 31.6 424z"/><path fill="#EA4335" d="M272 107.7c39.5-.6 77.2 14 106 40.9l79.2-79.2C405.3 23.5 341.7-.4 272 0 167.9 0 76 61.1 31.6 160.3l88.9 69.9C141.9 155.9 201.6 108.4 272 107.7z"/></svg>
              <span>sign in with google</span>
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
            <h2>analyzer</h2>
            <p>configure sources, run scans, and review cryptographic findings.</p>
          </div>
        </div>
        <section className="editor-shell fade-in">
          <div className="editor-top">
            {(loading || progressPct>0) && (
              <div className="progress"><div className="bar" style={{ width: `${progressPct}%` }} /></div>
            )}
          </div>
          <div className="editor-grid">
            <aside className="editor-sidebar panel">
              <div className="panel-header"><h3>project files</h3></div>
              <div className="panel-body">
                <div className="directory-tree">
                  {treeData.length ? renderNodes(treeData) : <div className="empty-state">waiting for files…</div>}
                </div>
              </div>
            </aside>
            <div className="editor-view">
              {selectedPath ? <EditorContent selectedPath={selectedPath} files={files} /> : <div className="empty-state">select a file from the left to preview</div>}
            </div>
          </div>
        </section>

        <div className="card-grid">
          <article className="panel">
            <div className="panel-header"><h2>analysis controls</h2><p>choose a source and run your scan.</p></div>
            <div className="panel-body">
              <div className="mode-list">
                {(['local','upload','git','stored'] as Mode[]).map(m => (
                  <button key={m} className={`mode-button ${mode===m?'active':''}`} onClick={()=>setMode(m)}>
                    <div><div>{m==='local'?'Local directory':m==='upload'?'Upload ZIP':m==='git'?'Git repository':'Stored datasets'}</div><span>{m==='local'?'use a path on this machine':m==='upload'?'upload a zip to analyze':m==='git'?'clone and analyze a repo':'analyze previously stored items'}</span></div>
                    <span className="small-caps">{m}</span>
                  </button>
                ))}
              </div>

              {mode==='local' && (
                <div className="field-group">
                  <label htmlFor="path">directory path</label>
                  <input id="path" placeholder="/path/to/project" value={directoryPath} onChange={e=>setDirectoryPath(e.target.value)} />
                  <div className="btn-row">
                    <button className="secondary-button" type="button" onClick={()=>fetchDirectoryTree(directoryPath)} disabled={!directoryPath.trim()}>preview structure</button>
                    <button className="primary-button" type="button" onClick={()=>onAnalyzeLocal()} disabled={!directoryPath.trim() || loading}>analyze</button>
                  </div>
                </div>
              )}
              {mode==='upload' && (
                <div className="field-group">
                  <label htmlFor="zip">zip archive</label>
                  <input id="zip" type="file" accept=".zip" onChange={e=>setZipFile(e.target.files?.[0] ?? null)} />
                  <button className="primary-button" type="button" onClick={()=>onAnalyzeZip()} disabled={!zipFile || loading}>analyze zip</button>
                </div>
              )}
              {mode==='git' && (
                <div className="field-group">
                  <label htmlFor="git">repository url</label>
                  <input id="git" placeholder="https://github.com/org/repo.git" value={gitUrl} onChange={e=>setGitUrl(e.target.value)} />
                  <button className="primary-button" type="button" onClick={()=>onAnalyzeGit()} disabled={!gitUrl.trim() || loading}>analyze repository</button>
                </div>
              )}
            </div>
          </article>

          {analysisResult ? (
            <article className="panel">
              <div className="panel-header"><h2>summary</h2><p>high-level metrics from the latest scan.</p></div>
              <div className="panel-body">
                <div className="metrics-grid">
                  <div className="metric-card"><span className="metric-label">total files</span><span className="metric-value">{analysisResult.total_files ?? 0}</span></div>
                  <div className="metric-card"><span className="metric-label">crypto files</span><span className="metric-value">{analysisResult.crypto_files_found ?? 0}</span></div>
                  <div className="metric-card"><span className="metric-label">ai reviews</span><span className="metric-value">{analysisResult.detailed_reviews?.length ?? 0}</span></div>
                </div>
              </div>
            </article>
          ) : null}
        </div>
        <footer className="footer">© Digital Fortress</footer>
      </div>
    </main>
  );
}

export default function AnalyzerPage() {
  return (
    <SessionProvider>
      <AnalyzerPageInner />
    </SessionProvider>
  );
}
