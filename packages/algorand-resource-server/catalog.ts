export interface CatalogEntry {
  name: string;
  category: string;
  recommend_when: string;
  install_command: string;
  source_url: string;
}

export const TOOL_CATALOG: CatalogEntry[] = [
  {
    name: "Superpowers",
    category: "TDD / planning-discipline",
    recommend_when: "Agent needs structured planning, TDD workflow, or systematic debugging discipline before writing code",
    install_command: "claude plugin add superpowers@claude-plugins-official",
    source_url: "https://claude.com/plugins/superpowers",
  },
  {
    name: "Context7",
    category: "live-documentation",
    recommend_when: "Agent needs up-to-date library docs, API references, or version-specific usage examples that may have changed since training cutoff",
    install_command: "npx -y @upstash/context7-mcp@latest",
    source_url: "https://github.com/upstash/context7",
  },
];
