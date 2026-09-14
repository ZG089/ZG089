import { readFile, writeFile } from "node:fs/promises";

const token = process.env.GITHUB_TOKEN;
const login = process.env.CONTRIBUTOR_LOGIN || "ZG089";
const readmePath = process.env.README_PATH || "README.md";
const apiBase = "https://api.github.com";
const ignoredRepositories = new Set([
  "fagramdesktop/localization",
  "awesome-android-root/awesome-android-root",
  "ZG089/Re-Malwack",
  "YFMARCO-Dev/YFMARCO-Dev",
  "uonou/mmrl-repo",
].map((repository) => repository.toLowerCase()));

if (!token) {
  throw new Error("GITHUB_TOKEN is required");
}

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
};

async function githubRequest(path) {
  const response = await fetch(`${apiBase}${path}`, { headers });
  if (!response.ok) {
    const error = new Error(`GitHub API ${response.status}: ${path}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function getMergedRepositories() {
  const repositories = new Map();
  let page = 1;

  while (true) {
    const query = new URLSearchParams({
      q: `is:pr is:merged author:${login}`,
      per_page: "100",
      page: String(page),
    });
    const result = await githubRequest(`/search/issues?${query}`);
    for (const item of result.items) {
      const repositoryUrl = item.repository_url;
      const match = repositoryUrl?.match(/\/repos\/([^/]+\/[^/]+)$/);
      if (match && !ignoredRepositories.has(match[1].toLowerCase())) {
        repositories.set(match[1].toLowerCase(), match[1]);
      }
    }
    if (result.items.length < 100) break;
    page += 1;
  }

  return [...repositories.values()];
}

async function fetchRepository(repositoryPath) {
  let url = `${apiBase}/repos/${repositoryPath}`;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(url, { headers, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { discontinued: true };
      url = location;
      continue;
    }
    if (response.status === 404) return { discontinued: true };
    if (!response.ok) throw new Error(`GitHub API ${response.status}: ${url}`);
    const repository = await response.json();
    return {
      href: repository.html_url,
      label: repository.name,
      discontinued: Boolean(repository.archived),
    };
  }

  return { discontinued: true };
}

async function checkLink(href) {
  let url = href;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let response = await fetch(url, { method: "HEAD", redirect: "manual" });
    if (response.status === 405 || response.status === 501) {
      response = await fetch(url, { redirect: "manual" });
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { discontinued: true };
      url = new URL(location, url).href;
      continue;
    }
    const temporarilyUnavailable = [401, 403, 429].includes(response.status);
    return { href: url, discontinued: response.status >= 400 && !temporarilyUnavailable };
  }
  return { discontinued: true };
}

function githubPath(href) {
  try {
    const url = new URL(href);
    if (url.hostname !== "github.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  } catch {
    return null;
  }
}

function discontinuedLabel(label, discontinued) {
  const cleanLabel = label.replace(/\s*\(Discontinued\)$/i, "");
  return discontinued ? `${cleanLabel} (Discontinued)` : cleanLabel;
}

function parseEntries(block) {
  const entryPattern = /<strong><a href="([^"]+)">([^<]+)<\/a><\/strong>/g;
  return [...block.matchAll(entryPattern)].map((match) => ({
    href: match[1],
    label: match[2],
  }));
}

function renderEntries(entries) {
  return entries
    .map((entry, index) => {
      const separator = index === entries.length - 1 ? "" : " -";
      return `    <strong><a href="${entry.href}">${entry.label}</a></strong>${separator}`;
    })
    .join("\n");
}

function logChange(message) {
  console.log(message);
}

async function updateReadme() {
  const readme = await readFile(readmePath, "utf8");
  const heading = "# 🤩 Projects I have helped with";
  const headingIndex = readme.indexOf(heading);
  if (headingIndex < 0) throw new Error(`Could not find ${heading}`);

  const blockStart = readme.indexOf('<div align="center">', headingIndex);
  const blockEnd = readme.indexOf("</div>", blockStart);
  if (blockStart < 0 || blockEnd < 0) throw new Error("Could not find contribution block");

  const oldBlock = readme.slice(blockStart, blockEnd + "</div>".length);
  const entries = parseEntries(oldBlock).filter((entry) => {
    const repositoryPath = githubPath(entry.href);
    if (!repositoryPath || !ignoredRepositories.has(repositoryPath.toLowerCase())) return true;
    logChange(`removed ignored repository: ${repositoryPath}`);
    return false;
  });
  const byRepository = new Map();

  for (const entry of entries) {
    const repositoryPath = githubPath(entry.href);
    if (repositoryPath) byRepository.set(repositoryPath.toLowerCase(), entry);
  }

  for (const repositoryPath of await getMergedRepositories()) {
    const key = repositoryPath.toLowerCase();
    if (!byRepository.has(key)) {
      const repository = await fetchRepository(repositoryPath);
      byRepository.set(key, {
        href: repository.href || `https://github.com/${repositoryPath}`,
        label: discontinuedLabel(repository.label || repositoryPath.split("/")[1], repository.discontinued),
      });
      entries.push(byRepository.get(key));
      logChange(`new contribution: ${repositoryPath}`);
    }
  }

  for (const entry of entries) {
    const repositoryPath = githubPath(entry.href);
    const result = repositoryPath
      ? await fetchRepository(repositoryPath)
      : await checkLink(entry.href);
    const previousHref = entry.href;
    const previousLabel = entry.label;
    const previousDiscontinued = /\(Discontinued\)$/i.test(previousLabel);
    if (result.href) entry.href = result.href;
    if (result.label) entry.label = result.label;
    entry.label = discontinuedLabel(entry.label, result.discontinued);
    if (entry.href !== previousHref || entry.label !== previousLabel) {
      if (entry.href !== previousHref) {
        logChange(`repo owner update: ${previousHref} -> ${entry.href}`);
      }
      if (entry.label !== previousLabel) {
        logChange(`repo name update: ${previousLabel} -> ${entry.label}`);
      }
    }
    if (!previousDiscontinued && result.discontinued) {
      logChange(`repo discontinued: ${entry.href}`);
    }
  }

  const newBlock = `<div align="center">\n${renderEntries(entries)}\n</div>`;
  const updatedReadme = readme.replace(oldBlock, newBlock);
  if (updatedReadme !== readme) await writeFile(readmePath, updatedReadme);
  console.log(`Checked ${entries.length} contribution(s); README ${updatedReadme === readme ? "unchanged" : "updated"}.`);
}

await updateReadme();