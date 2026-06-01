import { useCallback, useEffect, useMemo, useState } from "react";
import { getSkills, getSkill, saveSkill, deleteSkill, type SkillInfo, type SkillContent } from "../api/skills";

const NEW_TEMPLATE = `---
name: my-skill
description: What this does and WHEN to use it (include trigger phrases).
---

# My skill

Steps:
1. …
`;

/** Minimal markdown render (no dependency): headings, fenced code, bullets,
 *  inline \`code\` + **bold**. Faithful enough to read a SKILL.md; the raw
 *  toggle shows the exact source. */
function MarkdownLite({ md }: { md: string }): React.ReactElement {
  const blocks: React.ReactElement[] = [];
  const lines = md.split("\n");
  let i = 0; let key = 0;
  const inline = (s: string): React.ReactNode => {
    const parts = s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
    return parts.map((p, j) => {
      if (p.startsWith("**") && p.endsWith("**")) return <strong key={j}>{p.slice(2, -2)}</strong>;
      if (p.startsWith("`") && p.endsWith("`")) return <code key={j} className="px-1 rounded bg-surface-overlay text-accent">{p.slice(1, -1)}</code>;
      return <span key={j}>{p}</span>;
    });
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const buf: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith("```")) { buf.push(lines[i]); i++; }
      i++;
      blocks.push(<pre key={key++} className="my-2 p-2 rounded bg-surface-overlay text-xs overflow-x-auto text-text">{buf.join("\n")}</pre>);
      continue;
    }
    if (/^---\s*$/.test(line)) {
      // frontmatter / hr — collect a frontmatter block to show compactly
      const buf: string[] = []; i++;
      while (i < lines.length && !/^---\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      if (buf.length) blocks.push(<div key={key++} className="my-2 p-2 rounded border border-border/60 text-[11px] text-text-muted font-mono whitespace-pre-wrap">{buf.join("\n")}</div>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      const cls = lvl === 1 ? "text-base font-semibold mt-3" : lvl === 2 ? "text-sm font-semibold mt-3" : "text-sm font-medium mt-2";
      blocks.push(<div key={key++} className={`${cls} text-text`}>{inline(h[2])}</div>);
      i++; continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i++; }
      blocks.push(<ul key={key++} className="list-disc ml-5 my-1 text-sm text-text-muted space-y-0.5">{items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ul>);
      continue;
    }
    if (line.trim() === "") { i++; continue; }
    blocks.push(<p key={key++} className="text-sm text-text-muted my-1">{inline(line)}</p>);
    i++;
  }
  return <div>{blocks}</div>;
}

export function SkillsPanel(): React.ReactElement {
  const [list, setList] = useState<SkillInfo[]>([]);
  const [selected, setSelected] = useState<SkillContent | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draft, setDraft] = useState("");
  const [raw, setRaw] = useState(false);
  const [banner, setBanner] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const refresh = useCallback((): void => {
    getSkills().then(setList).catch((e: unknown) => setBanner({ type: "error", message: String(e) }));
  }, []);
  useEffect(refresh, [refresh]);

  const open = useCallback((name: string): void => {
    setBanner(null); setEditing(false); setRaw(false);
    getSkill(name).then(setSelected).catch((e: unknown) => setBanner({ type: "error", message: String(e) }));
  }, []);

  const startNew = useCallback((): void => {
    setSelected(null); setEditing(true); setRaw(false);
    setDraftName(""); setDraft(NEW_TEMPLATE);
  }, []);

  const startEdit = useCallback((): void => {
    if (!selected) return;
    setDraftName(selected.name); setDraft(selected.content); setEditing(true);
  }, [selected]);

  const save = useCallback((): void => {
    const name = draftName.trim();
    if (!name) { setBanner({ type: "error", message: "name required" }); return; }
    saveSkill(name, draft)
      .then((s) => { setBanner({ type: "success", message: `Saved "${s.name}"` }); setEditing(false); setSelected(s); refresh(); })
      .catch((e: unknown) => setBanner({ type: "error", message: e instanceof Error ? e.message : String(e) }));
  }, [draftName, draft, refresh]);

  const remove = useCallback((): void => {
    if (!selected || !window.confirm(`Delete personal skill "${selected.name}"?`)) return;
    deleteSkill(selected.name)
      .then(() => { setBanner({ type: "success", message: `Deleted "${selected.name}"` }); setSelected(null); refresh(); })
      .catch((e: unknown) => setBanner({ type: "error", message: e instanceof Error ? e.message : String(e) }));
  }, [selected, refresh]);

  const filtered = useMemo(() => list.filter((s) =>
    !query || s.name.toLowerCase().includes(query.toLowerCase()) || s.description.toLowerCase().includes(query.toLowerCase()),
  ), [list, query]);

  return (
    <div className="flex-1 flex min-h-0">
      {/* List */}
      <div className="w-64 shrink-0 border-r border-border flex flex-col min-h-0">
        <div className="p-2 border-b border-border flex gap-2">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search skills…"
            className="flex-1 px-2 py-1 text-xs rounded bg-surface-overlay border border-border focus:border-accent focus:outline-none text-text" />
          <button onClick={startNew} title="New personal skill" className="px-2 py-1 text-xs rounded bg-accent text-accent-fg">＋</button>
        </div>
        <div className="overflow-y-auto flex-1">
          {filtered.map((s) => (
            <button key={s.name} onClick={() => open(s.name)}
              className={`w-full text-left px-3 py-2 border-b border-border/40 hover:bg-surface-overlay ${selected?.name === s.name ? "bg-surface-overlay" : ""}`}>
              <div className="text-sm text-text flex items-center gap-1.5">
                {s.name}
                <span className={`text-[9px] px-1 rounded ${s.source === "personal" ? "bg-amber-500/20 text-amber-400" : "bg-surface-raised text-text-muted"}`}>{s.source}</span>
              </div>
              <div className="text-[11px] text-text-muted line-clamp-2">{s.description}</div>
            </button>
          ))}
          {filtered.length === 0 && <div className="p-4 text-xs text-text-muted text-center">No skills. Create one with ＋, or install a library that ships some.</div>}
        </div>
      </div>

      {/* Viewer / editor */}
      <div className="flex-1 flex flex-col min-h-0">
        {banner && (
          <div className={`px-4 py-2 text-xs ${banner.type === "success" ? "bg-node-active/10 text-node-active" : "bg-node-stopped/10 text-node-stopped"}`}>{banner.message}</div>
        )}
        {editing ? (
          <div className="flex-1 flex flex-col min-h-0 p-3 gap-2">
            <input value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="skill-name (kebab-case)"
              className="px-2 py-1 text-sm rounded bg-surface-overlay border border-border focus:border-accent focus:outline-none text-text font-mono" />
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false}
              className="flex-1 min-h-0 p-2 text-xs rounded bg-surface-overlay border border-border focus:border-accent focus:outline-none text-text font-mono resize-none" />
            <div className="flex gap-2">
              <button onClick={save} className="px-3 py-1 text-xs rounded bg-accent text-accent-fg font-semibold">Save</button>
              <button onClick={() => setEditing(false)} className="px-3 py-1 text-xs rounded text-text-muted hover:text-text">Cancel</button>
            </div>
          </div>
        ) : selected ? (
          <>
            <div className="px-4 py-2 border-b border-border flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-text">{selected.name}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-overlay text-text-muted font-mono">{selected.source} · {selected.version}</span>
              <div className="ml-auto flex gap-2">
                {selected.editable ? (
                  <>
                    {/* Editing IS the raw view for a personal skill: edit the
                        SKILL.md source directly. Bundled skills get a read-only
                        Raw toggle instead (below). */}
                    <button onClick={startEdit} className="px-2 py-1 text-xs rounded bg-accent/20 text-accent">Edit</button>
                    <button onClick={remove} className="px-2 py-1 text-xs rounded text-node-stopped hover:bg-node-stopped/10">Delete</button>
                  </>
                ) : (
                  <button onClick={() => setRaw((v) => !v)} className="px-2 py-1 text-xs rounded text-text-muted hover:text-text">{raw ? "Rendered" : "Raw"}</button>
                )}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {raw
                ? <pre className="text-xs text-text whitespace-pre-wrap font-mono">{selected.content}</pre>
                : <MarkdownLite md={selected.content} />}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-text-muted">Select a skill, or create one with ＋.</div>
        )}
      </div>
    </div>
  );
}
