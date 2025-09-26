"use client";

import dynamic from "next/dynamic";
import React, { useMemo } from "react";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

function detectLanguageFromExtension(ext?: string) {
  switch ((ext || "").toLowerCase()) {
    case ".py":
      return "python";
    case ".js":
      return "javascript";
    case ".ts":
      return "typescript";
    case ".java":
      return "java";
    case ".c":
    case ".h":
      return "c";
    case ".cpp":
      return "cpp";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".php":
      return "php";
    case ".rb":
      return "ruby";
    case ".kt":
      return "kotlin";
    case ".scala":
      return "scala";
    case ".swift":
      return "swift";
    default:
      return "plaintext";
  }
}

export default function CodeViewer({
  value,
  extension,
  minHeight = 140,
  maxHeight = 480,
}: {
  value: string;
  extension?: string;
  minHeight?: number;
  maxHeight?: number;
}) {
  const lines = useMemo(() => value.split("\n").length, [value]);
  const height = useMemo(() => {
    const lineHeight = 18; // px
    const padding = 32; // px
    const raw = lines * lineHeight + padding;
    return Math.max(minHeight, Math.min(maxHeight, raw));
  }, [lines, minHeight, maxHeight]);

  const language = detectLanguageFromExtension(extension);

  return (
    <div style={{ borderRadius: 12, overflow: "hidden", border: "1px solid rgba(68,94,148,0.35)", width: "100%" }}>
      <MonacoEditor
        theme="vs-dark"
        language={language}
        value={value}
        options={{
          readOnly: true,
          domReadOnly: true,
          scrollBeyondLastLine: false,
          lineNumbers: "on",
          minimap: { enabled: false },
          padding: { top: 8, bottom: 8 },
          automaticLayout: true,
          wordWrap: "on",
          fontSize: 13,
        }}
        height={height}
      />
    </div>
  );
}
