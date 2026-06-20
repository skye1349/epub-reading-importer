# EPUB Reading Importer

Desktop-only Obsidian plugin for importing EPUB files as chapter-based Markdown reading workspaces.

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

- Obsidian desktop
- `pandoc`
- macOS `unzip`

## Development

```sh
npm install
npm run build
```

For local testing, copy or symlink this folder into:

```text
<vault>/.obsidian/plugins/epub-reading-importer
```

Then enable **EPUB Reading Importer** in Obsidian community plugins.
