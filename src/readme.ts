import { readFileSync } from "node:fs";
import { marked } from "marked";

const README_PATH = new URL("../README.md", import.meta.url);

export function renderReadmeHtml(): string {
  const markdown = readFileSync(README_PATH, "utf8");
  const body = marked.parse(markdown) as string;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>README — Hancock Desks</title>
<link rel="stylesheet" href="/public/style.css" />
</head>
<body>
<main class="readme">
${body}
</main>
</body>
</html>
`;
}
