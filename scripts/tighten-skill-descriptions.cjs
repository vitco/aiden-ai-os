#!/usr/bin/env node
/**
 * Phase 22 Group C, Task 8 + smoke-fix #4 — description tightener.
 *
 * Rewrites every skill description that exceeds 80 chars to a tightened
 * form preserving the specific capability. Drops adjective fluff,
 * connecting phrases ("using the public REST API",
 * "for rendering in the browser"), and redundant qualifiers.
 *
 * Patches BOTH source-of-truth files:
 *   - skills/<name>/SKILL.md frontmatter `description:` line
 *     (the runtime read path — SkillLoader reads frontmatter)
 *   - skills/<name>/skill.json (the manifest — kept in sync for any
 *     consumer that prefers structured metadata)
 *
 * Re-runnable: idempotent. Skills already in tightened form are left
 * untouched.
 *
 * Run: node scripts/tighten-skill-descriptions.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const REWRITES = {
  'architecture-diagram':
    'Architecture and component diagrams as HTML/SVG (dark-themed)',
  'archon-bridge':
    'Unified portfolio + order routing across Zerodha, Upstox, Angel One',
  arxiv: 'Search and download arXiv papers (no API key needed)',
  'ascii-art': 'ASCII text banners and box art (pyfiglet, cowsay, boxes)',
  blogwatcher: 'Monitor RSS / Atom feeds for new posts (Python feedparser)',
  censys: 'Censys lookups: hosts, certificates, services on the public internet',
  'claude-code': 'Delegate coding and file edits to Anthropic Claude Code CLI',
  'clipboard-history':
    'Read/write Windows clipboard text, HTML, images, history (PowerShell)',
  codex: 'Delegate coding tasks to OpenAI Codex CLI',
  'crt-sh':
    'Enumerate subdomains and TLS certs via CT logs (no API key needed)',
  cveapi:
    'CVE lookup via MITRE + NVD: severity, CVSS, affected products, refs',
  'defender-quickscan':
    'Windows Defender: scans, threat history, signatures (PowerShell)',
  'docker-management':
    'Docker containers, images, volumes, networks (CLI + Dockerode)',
  excalidraw:
    'Hand-drawn diagrams in Excalidraw JSON (architecture, flowcharts)',
  explainshell: 'Explain shell commands in plain English (explainshell.com)',
  'gif-search': 'Search and fetch Tenor GIFs (free Tenor API key required)',
  'github-auth': 'GitHub auth setup via gh CLI, SSH keys, HTTPS PATs',
  'github-pr-workflow':
    'Pull request lifecycle: create, review, merge, manage (gh CLI)',
  'github-repo-management':
    'GitHub repos: create, clone, fork, archive (gh CLI + git)',
  'google-workspace':
    'Gmail, Calendar, Drive, Sheets, Docs via Google API (SA / OAuth)',
  greynoise:
    'Classify IPs as scanners or targeted attackers — filter alert noise',
  haveibeenpwned: 'Check email/username against HIBP v3 breach database',
  'india-economic-calendar':
    'Indian economic events: RBI, CPI/WPI, GDP, Budget, NSE expiry',
  'indian-tax-calc':
    'India tax calc: income, STCG/LTCG, advance tax, TDS (FY 2025-26)',
  'jupyter-live-kernel':
    'Stateful Jupyter kernel — variables persist across cells (hamelnb)',
  'media-search':
    'Find and play music/videos via web_search + open_url',
  'minecraft-modpack-server':
    'Set up a modded Minecraft server (NeoForge or Forge)',
  'network-diagnostics':
    'Windows net diag: ping, traceroute, DNS, port scan (PowerShell)',
  'nse-corporate-actions':
    'NSE corp actions: dividends, bonus, splits, rights, buybacks',
  'nse-delivery':
    'NSE delivery % data — surface stocks with high genuine buying',
  'nse-fii-dii':
    'NSE FII/DII daily flows — gauge institutional Indian equity activity',
  'nse-options':
    'NSE options chain: OI buildup, PCR, max pain, IV (Nifty/BankNifty)',
  'nse-scanner':
    'NSE scans: top gainers/losers, volume surges, 52w highs/lows',
  obsidian: 'Read, search, and create notes in Obsidian vaults',
  'ocr-and-documents':
    'Extract text from PDFs, images, scans, Word docs (Python)',
  onenote: 'Read/write OneNote pages via Microsoft Graph or COM',
  opencode:
    'Delegate coding to OpenCode CLI (multi-LLM open-source coding agent)',
  openhue: 'Control Philips Hue lights via OpenHue CLI + Hue Bridge API',
  'outlook-native':
    'Outlook calendar + inbox via PowerShell COM or Microsoft Graph',
  p5js: 'Generative visual art and sketches in p5.js (self-contained HTML)',
  'pokemon-player':
    'Automate Pokémon games via headless emulation + RAM reading',
  'powershell-pro':
    'Expert PowerShell: processes, services, WMI, REST, scheduled tasks',
  'research-paper-writing':
    'Pipeline for ML/AI research papers — lit review to LaTeX submission',
  securityheaders:
    'HTTP security header audit (A+ to F) with fix recommendations',
  shodan: 'Shodan lookups: internet-connected devices, ports, services',
  songsee:
    'Visualize audio as mel spectrograms, chromagrams, MFCC (librosa)',
  ssllabs:
    'TLS/SSL audit via Qualys SSL Labs — grade ciphers, chains, vulns',
  'stable-diffusion-image-generation':
    'Generate images via Stable Diffusion (HuggingFace Diffusers, local/API)',
  'systematic-debugging':
    'Four-phase root cause investigation for bugs and unexpected behavior',
  taskscheduler:
    'Windows Task Scheduler: create, list, enable, disable, delete (PS)',
  upstox: 'Upstox API v2: portfolio, market data, orders, P&L (Indian F&O)',
  urlscan:
    'Submit URLs to urlscan.io — safety verdict + screenshot retrieval',
  virustotal:
    'VirusTotal: check file/URL/domain/IP against 70+ AV engines',
  'windows-registry':
    'Read, write, query Windows Registry via PowerShell provider',
  'windows-services':
    'Windows services: list, start, stop, restart, configure (PowerShell)',
  'wsl-bridge': 'Run Linux in WSL from Windows; share files between hosts',
  'youtube-content':
    'YouTube: transcripts, audio/video downloads (yt-dlp, transcript-api)',
  'zerodha-kite':
    'Zerodha Kite Connect: holdings, positions, orders, live quotes',
};

/**
 * Patch the `description:` line inside a SKILL.md YAML frontmatter
 * block. Returns true when the file was modified, false if the new
 * description was already in place. Throws when no frontmatter or no
 * description line exists (those skills are skipped by main()).
 */
function patchSkillMd(filePath, newDescription) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split(/\r?\n/);
  // Frontmatter starts at line 0 with `---` and ends at the next `---`.
  if (lines[0] !== '---') {
    throw new Error(`no frontmatter in ${filePath}`);
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new Error(`unterminated frontmatter in ${filePath}`);
  }
  let descIdx = -1;
  for (let i = 1; i < endIdx; i += 1) {
    if (/^description:\s*/i.test(lines[i])) {
      descIdx = i;
      break;
    }
  }
  if (descIdx === -1) {
    throw new Error(`no description: line in ${filePath} frontmatter`);
  }
  const next = `description: ${newDescription}`;
  if (lines[descIdx] === next) return false;
  lines[descIdx] = next;
  // Preserve trailing newline if original had one.
  const out = raw.endsWith('\n')
    ? lines.join('\n').replace(/\n*$/, '\n')
    : lines.join('\n');
  fs.writeFileSync(filePath, out, 'utf-8');
  return true;
}

function patchSkillJson(filePath, newDescription) {
  const m = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (m.description === newDescription) return false;
  m.description = newDescription;
  fs.writeFileSync(filePath, JSON.stringify(m, null, 2) + '\n', 'utf-8');
  return true;
}

function main() {
  const root = path.resolve(__dirname, '..');
  const skillsDir = path.join(root, 'skills');
  let mdUpdated = 0;
  let jsonUpdated = 0;
  let already = 0;
  let skipped = 0;
  const stillTooLong = [];

  for (const [name, newDesc] of Object.entries(REWRITES)) {
    if (newDesc.length > 80) {
      stillTooLong.push([name, newDesc.length]);
      continue;
    }
    const skillDir = path.join(skillsDir, name);
    const mdPath = path.join(skillDir, 'SKILL.md');
    const jsonPath = path.join(skillDir, 'skill.json');
    let touched = false;

    if (fs.existsSync(mdPath)) {
      try {
        if (patchSkillMd(mdPath, newDesc)) {
          mdUpdated += 1;
          touched = true;
        }
      } catch (err) {
        console.warn(`[md-skip] ${name}: ${err.message}`);
      }
    }
    if (fs.existsSync(jsonPath)) {
      try {
        if (patchSkillJson(jsonPath, newDesc)) {
          jsonUpdated += 1;
          touched = true;
        }
      } catch (err) {
        console.warn(`[json-skip] ${name}: ${err.message}`);
      }
    }
    if (!touched) already += 1;
    if (!fs.existsSync(mdPath) && !fs.existsSync(jsonPath)) skipped += 1;
  }

  if (stillTooLong.length) {
    console.error('REWRITES has entries still over 80 chars:');
    for (const [n, l] of stillTooLong) console.error(`  ${l} ${n}`);
    process.exit(1);
  }
  console.log(
    `SKILL.md updated: ${mdUpdated} · skill.json updated: ${jsonUpdated} · already: ${already} · skipped: ${skipped}`,
  );
}

main();
