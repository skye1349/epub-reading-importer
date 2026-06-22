# EPUB Transfer to Markdown

Transfer EPUB books into chapter-based Markdown notes.

This plugin is designed for people who keep books and reading notes in a local vault. It converts an EPUB into a folder of Markdown files, keeps image assets together, and creates an index note plus an AI reading guide.

It can also export an edited book folder back to EPUB and prepare a Send-to-Kindle email draft with the exported EPUB attached.

## What It Creates

After importing an EPUB, the plugin creates a folder like this:

```text
Books/
  Book Title/
    00 - Index.md
    01 - Introduction.md
    02 - Chapter 1.md
    AI Reading Guide.md
    source.epub
    media/
      image-1.jpg
      image-2.png
```

`00 - Index.md` links to all generated chapter notes. `media/` contains images copied from the EPUB, so chapter images stay readable after import. If "Keep source EPUB" is enabled, the original EPUB is copied into the book folder as `source.epub`.

## Requirements

This is a desktop-only plugin for macOS and Windows.

You must install `pandoc` before using the plugin:

- macOS: install pandoc with Homebrew or from the official pandoc installer.
- Windows: install pandoc for Windows and make sure `pandoc.exe` is available.

The plugin tries to find pandoc automatically.

On macOS it checks:

```text
/opt/homebrew/bin/pandoc
/usr/local/bin/pandoc
/usr/bin/pandoc
```

On Windows it checks:

```text
C:\Program Files\Pandoc\pandoc.exe
C:\Program Files (x86)\Pandoc\pandoc.exe
%USERPROFILE%\AppData\Local\Pandoc\pandoc.exe
pandoc.exe
pandoc
```

If pandoc is installed somewhere else, open the plugin settings and enter the full pandoc path manually.

## How to Use

### EPUB to Markdown

1. Install and enable the plugin.
2. Open the command palette.
3. Run `Transfer EPUB to Markdown`.
4. Select an `.epub` file.
5. Wait for the import to finish.
6. Open the generated `00 - Index.md` file.

You can also click the book icon in the left ribbon.

### Markdown back to EPUB

1. Open the command palette.
2. Run `Export Markdown to EPUB`.
3. Enter the source Markdown file or folder.
4. Optionally enter the output EPUB path.
5. Run the export.

The source can be a folder:

```text
Books/Poor Charlies Almanack
```

Or a single Markdown file:

```text
Books/Poor Charlies Almanack/01 - Dedication.md
```

The output can be blank, a folder, or a full `.epub` path.

Source paths can be vault-relative paths. Output paths can be vault-relative paths or full system paths.

If output is blank, the plugin saves the EPUB next to the source:

```text
Books/Poor Charlies Almanack/Poor Charlies Almanack.epub
```

If the source is a folder, Markdown files are exported in filename order. The plugin skips `00 - Index.md` and `AI Reading Guide.md` so they do not become book chapters.

After export, the plugin shows the output path and copies the full system path to the clipboard.

### Send to Kindle

1. Set your Kindle email in the plugin settings.
2. Run `Export Markdown to EPUB for Kindle`.
3. Enter the source Markdown file or folder.
4. Optionally enter the output EPUB path.
5. The plugin creates an EPUB and opens an email draft with the EPUB attached.
6. Review the draft and send it from your mail client.

Kindle delivery uses your Kindle email address, such as `name_123@kindle.com`. Your sending email address must also be approved in your Amazon Kindle document settings.

On macOS, Kindle delivery uses Apple Mail. On Windows, it uses Outlook if Outlook is installed and configured.

## Settings

- `Output folder`: the vault folder where imported books are created. The default is `Books`.
- `Pandoc path`: optional full path to pandoc. Leave it blank for auto-detection.
- `Kindle email`: optional Send-to-Kindle email address for creating Kindle delivery drafts.
- `Keep source EPUB`: copy the original EPUB into the generated book folder.
- `Open index after import`: open `00 - Index.md` after the import finishes.

## Troubleshooting

### "pandoc" is not found

Install pandoc first, then restart the app and try again.

If it still fails, set the full pandoc path in the plugin settings.

Examples:

```text
/opt/homebrew/bin/pandoc
C:\Program Files\Pandoc\pandoc.exe
```

### The import works on macOS but fails on Windows

Check that pandoc is installed for Windows. The plugin uses PowerShell `Expand-Archive` to unzip EPUB files on Windows, so PowerShell must be available.

### No readable chapters were found

The EPUB may have an unusual internal structure, DRM protection, or content stored as images instead of HTML text. Try opening the EPUB in a regular EPUB reader first. If the book is mostly scanned pages, the plugin cannot turn those pages into clean text notes.

### Images are missing

Make sure the generated `media/` folder stays next to the Markdown files. Do not move the chapter notes without moving the `media/` folder too.

### The generated Markdown looks messy

EPUB files vary a lot. Some books contain clean chapter HTML, while others contain layout-heavy HTML, scanned pages, or unusual navigation files. This plugin tries to create readable Markdown, but the final quality depends on the source EPUB.

### EPUB export fails

Make sure pandoc is installed and the source path exists. A folder source should contain chapter Markdown files such as `01 - Introduction.md` or `02 - Chapter 1.md`. A file source must be a `.md` file.

### Kindle delivery does not open an email draft

Check that your Kindle email is set in the plugin settings.

On macOS, make sure Apple Mail is installed and configured. On Windows, make sure Outlook is installed and configured. The plugin does not store SMTP passwords or send email silently in the background.

## Privacy and Permissions

The plugin works locally. It does not send book files or notes to a network service.

It does use local filesystem access to read the selected EPUB, write Markdown files, and export EPUB files into your vault. It also runs local command-line tools such as pandoc, and on Windows it may run PowerShell for EPUB extraction or Outlook draft creation.

## Development

```sh
npm install
npm run build
```

For local testing, copy or symlink this folder into:

```text
<vault>/.obsidian/plugins/epub-reading-importer
```

Then enable **EPUB Transfer to Markdown** in community plugins.
