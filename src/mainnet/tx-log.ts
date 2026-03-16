// src/mainnet/tx-log.ts
// Transaction log tracker + markdown summary exporter

import { writeFileSync } from "fs";
import { join } from "path";

export interface TxRecord {
  step: string;
  chain: "NEAR" | "Arbitrum" | "Stellar" | "1Click Bridge";
  description: string;
  hash?: string;
  explorer?: string;
  status: "success" | "failed" | "pending" | "skipped";
  details?: string;
}

export class TxLog {
  private records: TxRecord[] = [];
  private params: Record<string, string> = {};
  private addresses: Record<string, string> = {};
  private startTime: Date;
  private title: string;

  constructor(title: string) {
    this.title = title;
    this.startTime = new Date();
  }

  setParam(key: string, value: string) {
    this.params[key] = value;
  }

  setAddress(label: string, address: string) {
    this.addresses[label] = address;
  }

  add(record: TxRecord) {
    this.records.push(record);
  }

  private explorerUrl(chain: string, hash: string): string {
    switch (chain) {
      case "NEAR": return `https://nearblocks.io/txns/${hash}`;
      case "Arbitrum": return `https://arbiscan.io/tx/${hash}`;
      case "Stellar": return `https://stellar.expert/explorer/public/tx/${hash}`;
      default: return hash;
    }
  }

  toMarkdown(): string {
    const endTime = new Date();
    const duration = ((endTime.getTime() - this.startTime.getTime()) / 1000).toFixed(0);
    const ts = this.startTime.toISOString().replace(/[:.]/g, "-").slice(0, 19);

    let md = `# ${this.title}\n\n`;
    md += `**Date:** ${this.startTime.toISOString()}\n`;
    md += `**Duration:** ${duration}s\n\n`;

    // Addresses
    if (Object.keys(this.addresses).length > 0) {
      md += `## Addresses\n\n`;
      md += `| Chain | Address |\n|-------|--------|\n`;
      for (const [label, addr] of Object.entries(this.addresses)) {
        md += `| ${label} | \`${addr}\` |\n`;
      }
      md += `\n`;
    }

    // Parameters
    if (Object.keys(this.params).length > 0) {
      md += `## Parameters\n\n`;
      md += `| Parameter | Value |\n|-----------|-------|\n`;
      for (const [key, val] of Object.entries(this.params)) {
        md += `| ${key} | ${val} |\n`;
      }
      md += `\n`;
    }

    // Transactions
    md += `## Transactions\n\n`;
    md += `| # | Step | Chain | Description | Hash | Status |\n`;
    md += `|---|------|-------|-------------|------|--------|\n`;
    for (let i = 0; i < this.records.length; i++) {
      const r = this.records[i]!;
      const hashCell = r.hash
        ? `[${r.hash.slice(0, 12)}...](${r.explorer ?? this.explorerUrl(r.chain, r.hash)})`
        : "—";
      const statusEmoji = r.status === "success" ? "✅" : r.status === "failed" ? "❌" : r.status === "skipped" ? "⏭️" : "⏳";
      md += `| ${i + 1} | ${r.step} | ${r.chain} | ${r.description} | ${hashCell} | ${statusEmoji} ${r.status} |\n`;
    }
    md += `\n`;

    // Details
    const withDetails = this.records.filter((r) => r.details);
    if (withDetails.length > 0) {
      md += `## Details\n\n`;
      for (const r of withDetails) {
        md += `### ${r.step} — ${r.description}\n\n${r.details}\n\n`;
      }
    }

    return md;
  }

  save(dir: string = "."): string {
    const ts = this.startTime.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const slug = this.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const filename = `${slug}-${ts}.md`;
    const filepath = join(dir, filename);
    writeFileSync(filepath, this.toMarkdown());
    return filepath;
  }
}
