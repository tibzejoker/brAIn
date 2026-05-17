import { useState } from "react";
import type { CLIAgentStatus } from "../../api/client";

interface CLIAgentCardProps {
  agent: CLIAgentStatus;
}

/**
 * One card per CLI agent (Claude Code, Codex, gemini-cli, …).
 *
 * Unlike API providers, CLIs authenticate through their OWN browser
 * login flow — we can't drive it from the API. The card therefore
 * surfaces the install + login commands as copyable snippets and lets
 * the user re-check status after running them in their terminal.
 */
export function CLIAgentCard({ agent }: CLIAgentCardProps): React.ReactElement {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (label: string, text: string): void => {
    void navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="rounded border border-border bg-surface-raised p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${agent.available ? "bg-node-active" : "bg-node-stopped"}`} />
          <span className="font-semibold text-text capitalize">{agent.name}</span>
          {agent.available ? (
            <span className="text-[10px] text-node-active uppercase tracking-wider">installed</span>
          ) : (
            <span className="text-[10px] text-node-stopped uppercase tracking-wider">not installed</span>
          )}
          {agent.version && (
            <span className="text-[10px] text-text-muted font-mono">{agent.version}</span>
          )}
        </div>
        <a
          href={agent.homepage}
          target="_blank"
          rel="noreferrer"
          className="text-[10px] text-accent hover:underline"
        >
          docs ↗
        </a>
      </div>

      {agent.error && !agent.available && (
        <p className="text-[11px] text-text-muted break-words">{agent.error}</p>
      )}

      {!agent.available ? (
        <>
          <CommandRow
            label="1. Install"
            command={agent.installCommand}
            copyKey={`install-${agent.name}`}
            copied={copied}
            onCopy={copy}
          />
          <CommandRow
            label="2. Login (opens a browser)"
            command={agent.loginCommand}
            copyKey={`login-${agent.name}`}
            copied={copied}
            onCopy={copy}
          />
          <p className="text-[10px] text-text-muted italic">
            Run these in your own terminal — auth needs an interactive browser
            flow we can't drive from the dashboard. Hit "Re-check" below once
            you've logged in.
          </p>
        </>
      ) : (
        <CommandRow
          label="Re-login if needed"
          command={agent.loginCommand}
          copyKey={`login-${agent.name}`}
          copied={copied}
          onCopy={copy}
        />
      )}
    </div>
  );
}

function CommandRow({
  label, command, copyKey, copied, onCopy,
}: {
  label: string;
  command: string;
  copyKey: string;
  copied: string | null;
  onCopy: (key: string, text: string) => void;
}): React.ReactElement {
  return (
    <div>
      <div className="text-text-muted text-xs mb-1">{label}</div>
      <div className="flex items-stretch gap-2">
        <code className="flex-1 bg-bg border border-border rounded px-2 py-1 font-mono text-[11px] text-text overflow-x-auto whitespace-nowrap">
          {command}
        </code>
        <button
          type="button"
          onClick={() => onCopy(copyKey, command)}
          className="px-3 py-1 rounded bg-accent text-accent-fg text-xs font-semibold"
        >
          {copied === copyKey ? "Copied!" : "Copy"}
        </button>
      </div>
    </div>
  );
}
