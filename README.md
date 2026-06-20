# EPUB Transfer to Markdown

Desktop-only Obsidian plugin for transferring EPUB files into chapter-based Markdown notes.

## What It Creates

```text
Books/
  Book Title/
    00 - Index.md
    01 - Introduction.md
    02 - Chapter 1.md
    AI Reading Guide.md
    source.epub
    media/
```

## Requirements

- Obsidian desktop for macOS or Windows
- `pandoc`
- macOS uses the system `unzip`
- Windows uses PowerShell `Expand-Archive`

## Development

```sh
npm install
npm run build
```

For local testing, copy or symlink this folder into:

```text
<vault>/.obsidian/plugins/epub-reading-importer
```

Then enable **EPUB Transfer to Markdown** in Obsidian community plugins.
