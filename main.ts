import {
  App,
  Modal,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  normalizePath
} from "obsidian";
import { Buffer } from "buffer";
import { spawn } from "child_process";
import { createHash } from "crypto";
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from "fs/promises";
import * as os from "os";
import * as path from "path";

interface EpubImporterSettings {
  outputFolder: string;
  pandocPath: string;
  kindleEmail: string;
  lastExportSource: string;
  lastExportOutput: string;
  keepSourceEpub: boolean;
  openIndexAfterImport: boolean;
}

interface ManifestItem {
  id?: string;
  href: string;
  "media-type"?: string;
  properties?: string;
}

interface SpineItem {
  idref: string;
  linear?: string;
}

interface NavItem {
  href: string;
  title: string;
}

interface Chapter {
  title: string;
  filename: string;
}

interface EpubStructure {
  manifest: Map<string, ManifestItem>;
  navItems: NavItem[];
  navTitles: Map<string, string>;
  opfDir: string;
  spine: SpineItem[];
  title: string;
}

interface Section {
  title: string;
  markdown: string;
}

interface ExportPathRequest {
  sourcePath: string;
  outputPath: string;
}

interface ExportSource {
  absolutePath: string;
  displayPath: string;
  bookName: string;
  isFolder: boolean;
}

const DEFAULT_SETTINGS: EpubImporterSettings = {
  outputFolder: "Books",
  pandocPath: "",
  kindleEmail: "",
  lastExportSource: "",
  lastExportOutput: "",
  keepSourceEpub: true,
  openIndexAfterImport: true
};

function parseSettings(data: unknown): Partial<EpubImporterSettings> {
  if (!data || typeof data !== "object") {
    return {};
  }

  const raw = data as Partial<Record<keyof EpubImporterSettings, unknown>>;
  const settings: Partial<EpubImporterSettings> = {};

  if (typeof raw.outputFolder === "string") {
    settings.outputFolder = raw.outputFolder;
  }
  if (typeof raw.pandocPath === "string") {
    settings.pandocPath = raw.pandocPath;
  }
  if (typeof raw.kindleEmail === "string") {
    settings.kindleEmail = raw.kindleEmail;
  }
  if (typeof raw.lastExportSource === "string") {
    settings.lastExportSource = raw.lastExportSource;
  } else if (typeof (raw as Record<string, unknown>).lastExportFolder === "string") {
    settings.lastExportSource = (raw as Record<string, string>).lastExportFolder;
  }
  if (typeof raw.lastExportOutput === "string") {
    settings.lastExportOutput = raw.lastExportOutput;
  }
  if (typeof raw.keepSourceEpub === "boolean") {
    settings.keepSourceEpub = raw.keepSourceEpub;
  }
  if (typeof raw.openIndexAfterImport === "boolean") {
    settings.openIndexAfterImport = raw.openIndexAfterImport;
  }

  return settings;
}

export default class EpubReadingImporterPlugin extends Plugin {
  settings: EpubImporterSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    this.addRibbonIcon("book-open", "Transfer EPUB to Markdown", () => {
      void this.importEpub();
    });

    this.addCommand({
      id: "import-epub-reading-workspace",
      name: "Transfer EPUB to Markdown",
      callback: () => {
        void this.importEpub();
      }
    });

    this.addCommand({
      id: "export-current-book-to-epub",
      name: "Export Markdown to EPUB",
      callback: () => {
        void this.exportFolder(false);
      }
    });

    this.addCommand({
      id: "export-current-book-to-kindle",
      name: "Export Markdown to EPUB for Kindle",
      callback: () => {
        void this.exportFolder(true);
      }
    });

    this.addSettingTab(new EpubReadingImporterSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...parseSettings(await this.loadData()) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private async importEpub() {
    if (!Platform.isDesktopApp) {
      new Notice("EPUB import needs Obsidian desktop.");
      return;
    }

    try {
      const file = await selectEpubFile();
      if (!file) return;

      new Notice("Importing EPUB...");
      const vaultBasePath = getVaultBasePath(this.app);
      const tempDir = path.join(os.tmpdir(), "epub-reading-importer", `${Date.now()}-${randomId()}`);
      await mkdir(tempDir, { recursive: true });

      const inputPath = path.join(tempDir, "source.epub");
      await writeFile(inputPath, Buffer.from(await file.arrayBuffer()));

      const bookName = sanitizeBookName(file.name.replace(/\.epub$/i, ""));
      const outputFolder = await uniqueVaultFolder(vaultBasePath, this.settings.outputFolder, bookName);
      const outputDir = path.join(vaultBasePath, outputFolder);

      await convertEpubForObsidian({
        inputPath,
        outputDir,
        bookName,
        tempDir,
        pandocPath: this.settings.pandocPath,
        keepSourceEpub: this.settings.keepSourceEpub
      });

      await rm(tempDir, { recursive: true, force: true });

      const indexPath = normalizePath(`${outputFolder}/00 - Index.md`);
      new Notice(`Transferred EPUB to ${outputFolder}`);

      if (this.settings.openIndexAfterImport) {
        await this.app.workspace.openLinkText(indexPath, "", false);
      }
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "EPUB import failed.");
    }
  }

  private async exportFolder(forKindle: boolean) {
    if (!Platform.isDesktopApp) {
      new Notice("EPUB export needs Obsidian desktop.");
      return;
    }

    try {
      const vaultBasePath = getVaultBasePath(this.app);
      const defaults = getExportDefaults(this.app.workspace.getActiveFile(), this.settings);
      const exportRequest = await promptForExportPaths(this.app, defaults.sourcePath, defaults.outputPath, forKindle);
      if (!exportRequest) return;

      const source = await resolveExportSource(exportRequest.sourcePath, vaultBasePath);
      const outputPath = resolveExportOutputPath(exportRequest.outputPath, source, vaultBasePath);
      const outputDisplayPath = getDisplayPath(outputPath, vaultBasePath);
      this.settings.lastExportSource = source.displayPath;
      this.settings.lastExportOutput = exportRequest.outputPath.trim();
      await this.saveSettings();

      new Notice("Exporting EPUB...");
      await exportMarkdownToEpub({
        source,
        outputPath,
        pandocPath: this.settings.pandocPath
      });

      if (forKindle) {
        await prepareKindleDelivery(outputPath, this.settings.kindleEmail);
        await copyTextToClipboard(outputPath);
        new Notice(`Exported EPUB to ${outputDisplayPath}. Full path copied.`);
        return;
      }

      await copyTextToClipboard(outputPath);
      new Notice(`Exported EPUB to ${outputDisplayPath}. Full path copied.`);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "EPUB export failed.");
    }
  }
}

class EpubReadingImporterSettingTab extends PluginSettingTab {
  plugin: EpubReadingImporterPlugin;

  constructor(app: App, plugin: EpubReadingImporterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Output folder")
      .setDesc("Folder inside the current vault where imported books are created.")
      .addText((text) =>
        text
          .setPlaceholder("Books")
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (value) => {
            this.plugin.settings.outputFolder = value.trim() || "Books";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Pandoc path")
      .setDesc("Leave blank to auto-detect pandoc.")
      .addText((text) =>
        text
          .setPlaceholder("/opt/homebrew/bin/pandoc")
          .setValue(this.plugin.settings.pandocPath)
          .onChange(async (value) => {
            this.plugin.settings.pandocPath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Kindle email")
      .setDesc("Optional Send-to-Kindle email address used when preparing Kindle delivery.")
      .addText((text) =>
        text
          .setPlaceholder("name_123@kindle.com")
          .setValue(this.plugin.settings.kindleEmail)
          .onChange(async (value) => {
            this.plugin.settings.kindleEmail = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Keep source EPUB")
      .setDesc("Copy the original EPUB into the imported book folder.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.keepSourceEpub).onChange(async (value) => {
          this.plugin.settings.keepSourceEpub = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Open index after import")
      .setDesc("Open 00 - Index.md when import finishes.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.openIndexAfterImport).onChange(async (value) => {
          this.plugin.settings.openIndexAfterImport = value;
          await this.plugin.saveSettings();
        })
      );
  }
}

class ExportPathsModal extends Modal {
  private sourcePath: string;
  private outputPath: string;
  private readonly forKindle: boolean;
  private readonly onSubmit: (request: ExportPathRequest | null) => void;
  private submitted = false;

  constructor(app: App, defaultSource: string, defaultOutput: string, forKindle: boolean, onSubmit: (request: ExportPathRequest | null) => void) {
    super(app);
    this.sourcePath = defaultSource;
    this.outputPath = defaultOutput;
    this.forKindle = forKindle;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText(this.forKindle ? "Export Markdown to EPUB for Kindle" : "Export Markdown to EPUB");
    contentEl.empty();

    contentEl.createEl("p", {
      text: "Enter a Markdown file or a folder of Markdown chapters. The output path is optional."
    });

    const sourceSetting = new Setting(contentEl)
      .setName("Source file or folder")
      .setDesc("Example: Judgement/Poor Charlies Almanack or Judgement/Poor Charlies Almanack/01 - Dedication.md")
      .addText((text) => {
        text
          .setPlaceholder("Judgement/Poor Charlies Almanack")
          .setValue(this.sourcePath)
          .onChange((value) => {
            this.sourcePath = value;
          });
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            this.submit();
          }
        });
      });

    sourceSetting.settingEl.addClass("epub-reading-importer-path-setting");

    const outputSetting = new Setting(contentEl)
      .setName("Output EPUB path")
      .setDesc("Optional. Leave blank to save next to the source. You can enter a folder or a .epub path.")
      .addText((text) => {
        text
          .setPlaceholder("Judgement/Poor Charlies Almanack.epub")
          .setValue(this.outputPath)
          .onChange((value) => {
            this.outputPath = value;
          });
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            this.submit();
          }
        });
      });

    outputSetting.settingEl.addClass("epub-reading-importer-path-setting");

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText("Cancel")
          .onClick(() => {
            this.close();
          })
      )
      .addButton((button) =>
        button
          .setCta()
          .setButtonText(this.forKindle ? "Export for Kindle" : "Export EPUB")
          .onClick(() => {
            this.submit();
          })
      );
  }

  onClose() {
    this.contentEl.empty();
    if (!this.submitted) {
      this.onSubmit(null);
    }
  }

  private submit() {
    this.submitted = true;
    this.onSubmit({
      sourcePath: this.sourcePath.trim(),
      outputPath: this.outputPath.trim()
    });
    this.close();
  }
}

function promptForExportPaths(app: App, defaultSource: string, defaultOutput: string, forKindle: boolean): Promise<ExportPathRequest | null> {
  return new Promise((resolve) => {
    new ExportPathsModal(app, defaultSource, defaultOutput, forKindle, resolve).open();
  });
}

function selectEpubFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = activeDocument.createElement("input");
    input.type = "file";
    input.accept = ".epub,application/epub+zip";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

function getVaultBasePath(app: App): string {
  const adapter = app.vault.adapter as unknown as { getBasePath?: () => string };
  if (typeof adapter.getBasePath !== "function") {
    throw new Error("This importer needs a local desktop vault.");
  }
  return adapter.getBasePath();
}

async function uniqueVaultFolder(vaultBasePath: string, outputFolder: string, bookName: string): Promise<string> {
  const root = normalizePath(outputFolder || "Books");
  let candidate = normalizePath(`${root}/${bookName}`);
  let count = 2;

  while (await pathExists(path.join(vaultBasePath, candidate))) {
    candidate = normalizePath(`${root}/${bookName} ${count}`);
    count += 1;
  }

  return candidate;
}

async function convertEpubForObsidian(options: {
  inputPath: string;
  outputDir: string;
  bookName: string;
  tempDir: string;
  pandocPath: string;
  keepSourceEpub: boolean;
}) {
  const extractDir = path.join(options.tempDir, "epub");
  const htmlTmpDir = path.join(options.tempDir, "html");
  const mediaDir = path.join(options.outputDir, "media");
  const pandoc = await resolveCommand("pandoc", getPandocCandidates(options.pandocPath));

  await mkdir(options.outputDir, { recursive: true });
  await mkdir(extractDir, { recursive: true });
  await mkdir(htmlTmpDir, { recursive: true });
  await mkdir(mediaDir, { recursive: true });

  if (options.keepSourceEpub) {
    await copyFile(options.inputPath, path.join(options.outputDir, "source.epub"));
  }

  await extractEpub(options.inputPath, extractDir, options.tempDir);

  const epub = await readEpubStructure(extractDir);
  const mediaMap = await copyEpubMedia(epub, mediaDir);
  const chapters: Chapter[] = [];
  let chapterNumber = 1;

  for (const spineItem of epub.spine) {
    const item = epub.manifest.get(spineItem.idref);
    if (!item || !isHtmlItem(item)) continue;

    const sourcePath = path.join(epub.opfDir, decodeUriPath(item.href));
    const html = await readFile(sourcePath, "utf8").catch(() => "");
    if (!html.trim()) continue;

    const spineHref = normalizeFilePath(path.relative(epub.opfDir, sourcePath));
    const navTitle = epub.navTitles.get(spineHref);
    const navItems = epub.navItems.filter((navItem) => navItem.href === spineHref);
    const title = navTitle || extractHtmlTitle(html) || `Section ${chapterNumber}`;
    const cleanedHtml = prepareChapterHtml(html, sourcePath, epub.opfDir, mediaMap);
    const tempHtml = path.join(htmlTmpDir, `${String(chapterNumber).padStart(3, "0")}.html`);
    const tempMarkdownPath = path.join(htmlTmpDir, `${String(chapterNumber).padStart(3, "0")}.md`);

    await writeFile(tempHtml, cleanedHtml);
    await runCommand(pandoc, [
      tempHtml,
      "--from=html",
      "--to=gfm",
      "--wrap=none",
      "--markdown-headings=atx",
      "--resource-path",
      options.outputDir,
      "-o",
      tempMarkdownPath
    ]);

    const rawMarkdown = await readFile(tempMarkdownPath, "utf8");
    const markdown = cleanMarkdown(rawMarkdown, title);
    const sections = splitMarkdownByNav(markdown, navItems, title);

    for (const section of sections) {
      const meaningfulChars = section.markdown.replace(/[#\s\-[\]().]/g, "").length;
      if (meaningfulChars < 80 && shouldSkipThinSection(item, section.title)) continue;

      const filename = `${String(chapterNumber).padStart(2, "0")} - ${sanitizeFileName(section.title)}.md`;
      await writeFile(path.join(options.outputDir, filename), section.markdown);
      chapters.push({ title: section.title, filename });
      chapterNumber += 1;
    }
  }

  if (chapters.length === 0) {
    throw new Error("No readable chapters were found in this EPUB.");
  }

  await writeFile(path.join(options.outputDir, "00 - Index.md"), buildIndex(options.bookName, chapters, options.keepSourceEpub));
  await writeFile(path.join(options.outputDir, "AI Reading Guide.md"), buildReadingGuide(options.bookName, chapters));
}

async function exportMarkdownToEpub(options: {
  source: ExportSource;
  outputPath: string;
  pandocPath: string;
}): Promise<void> {
  const pandoc = await resolveCommand("pandoc", getPandocCandidates(options.pandocPath));
  const markdownFiles = await collectExportMarkdownFiles(options.source);

  if (markdownFiles.length === 0) {
    throw new Error("No Markdown files were found in the export source.");
  }

  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await runCommand(pandoc, [
    ...markdownFiles,
    "--from=gfm",
    "--to=epub3",
    "--standalone",
    "--metadata",
    `title=${options.source.bookName}`,
    "--resource-path",
    options.source.isFolder ? options.source.absolutePath : path.dirname(options.source.absolutePath),
    "-o",
    options.outputPath
  ]);
}

async function collectExportMarkdownFiles(source: ExportSource): Promise<string[]> {
  if (!source.isFolder) {
    if (!/\.md$/i.test(source.absolutePath)) {
      throw new Error("The export source file must be a Markdown file.");
    }
    return [source.absolutePath];
  }

  const folderEntries = await readdir(source.absolutePath, { withFileTypes: true });
  return folderEntries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /\.md$/i.test(name))
    .filter((name) => !/^00\s*-\s*Index\.md$/i.test(name))
    .filter((name) => !/^AI Reading Guide\.md$/i.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }))
    .map((name) => path.join(source.absolutePath, name));
}

function getExportDefaults(activeFile: TFile | null, settings: EpubImporterSettings): ExportPathRequest {
  if (settings.lastExportSource || settings.lastExportOutput) {
    return {
      sourcePath: settings.lastExportSource,
      outputPath: settings.lastExportOutput
    };
  }

  if (!activeFile) {
    return { sourcePath: "", outputPath: "" };
  }

  try {
    return { sourcePath: getBookFolder(activeFile).path, outputPath: "" };
  } catch {
    return { sourcePath: activeFile.path, outputPath: "" };
  }
}

async function resolveExportSource(sourcePath: string, vaultBasePath: string): Promise<ExportSource> {
  const trimmed = sourcePath.trim();
  if (!trimmed) {
    throw new Error("Enter a Markdown file or folder before exporting.");
  }

  const absolutePath = resolveInputPath(trimmed, vaultBasePath);
  const info = await stat(absolutePath).catch(() => null);
  if (!info) {
    throw new Error("The export source was not found.");
  }

  const isFolder = info.isDirectory();
  if (!isFolder && !info.isFile()) {
    throw new Error("The export source must be a Markdown file or a folder.");
  }

  const displayPath = getDisplayPath(absolutePath, vaultBasePath);
  const bookName = sanitizeBookName(isFolder ? path.basename(absolutePath) : path.basename(absolutePath, path.extname(absolutePath)));
  return { absolutePath, displayPath, bookName, isFolder };
}

function resolveExportOutputPath(outputPath: string, source: ExportSource, vaultBasePath: string): string {
  const trimmed = outputPath.trim();
  if (!trimmed) {
    const baseDir = source.isFolder ? source.absolutePath : path.dirname(source.absolutePath);
    return path.join(baseDir, `${source.bookName}.epub`);
  }

  const absolutePath = resolveInputPath(trimmed, vaultBasePath);
  if (/\.epub$/i.test(absolutePath)) {
    return absolutePath;
  }

  return path.join(absolutePath, `${source.bookName}.epub`);
}

function resolveInputPath(inputPath: string, vaultBasePath: string): string {
  if (path.isAbsolute(inputPath)) {
    return path.normalize(inputPath);
  }

  return path.join(vaultBasePath, normalizePath(inputPath.replace(/^\/+/, "")));
}

function getDisplayPath(absolutePath: string, vaultBasePath: string): string {
  const normalizedAbsolute = normalizeFilePath(absolutePath);
  const normalizedVault = normalizeFilePath(vaultBasePath);
  if (normalizedAbsolute === normalizedVault) {
    return "/";
  }
  if (normalizedAbsolute.startsWith(`${normalizedVault}/`)) {
    return normalizePath(normalizedAbsolute.slice(normalizedVault.length + 1));
  }
  return absolutePath;
}

function getBookFolder(activeFile: TFile): TFolder {
  const parent = activeFile.parent;
  if (!parent || parent.isRoot()) {
    throw new Error("Open a Markdown file inside an imported book folder first.");
  }

  if (parent.name.toLowerCase() === "media" && parent.parent && !parent.parent.isRoot()) {
    return parent.parent;
  }

  return parent;
}

async function prepareKindleDelivery(epubPath: string, kindleEmail: string): Promise<void> {
  if (!kindleEmail) {
    throw new Error("Set your Kindle email in the plugin settings first.");
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(kindleEmail)) {
    throw new Error("The Kindle email setting does not look like a valid email address.");
  }

  if (os.platform() === "darwin") {
    await prepareKindleDeliveryWithAppleMail(epubPath, kindleEmail);
    new Notice("Created a Kindle email draft in Mail.");
    return;
  }

  if (os.platform() === "win32") {
    await prepareKindleDeliveryWithOutlook(epubPath, kindleEmail);
    new Notice("Created a Kindle email draft in Outlook.");
    return;
  }

  throw new Error("Kindle email draft creation is only supported on macOS Mail and Windows Outlook.");
}

async function copyTextToClipboard(value: string): Promise<void> {
  await activeWindow.navigator.clipboard.writeText(value).catch(() => undefined);
}

async function prepareKindleDeliveryWithAppleMail(epubPath: string, kindleEmail: string): Promise<void> {
  await runCommand("osascript", [
    "-e",
    [
      "on run argv",
      "set kindleAddress to item 1 of argv",
      "set epubPath to item 2 of argv",
      "tell application \"Mail\"",
      "set newMessage to make new outgoing message with properties {subject:\"Convert\", content:\"\", visible:true}",
      "tell newMessage",
      "make new to recipient at end of to recipients with properties {address:kindleAddress}",
      "make new attachment with properties {file name:(POSIX file epubPath)} at after the last paragraph",
      "end tell",
      "activate",
      "end tell",
      "end run"
    ].join("\n"),
    kindleEmail,
    epubPath
  ]);
}

async function prepareKindleDeliveryWithOutlook(epubPath: string, kindleEmail: string): Promise<void> {
  const powershell = await resolveCommand("powershell.exe", [
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "powershell.exe",
    "pwsh.exe"
  ]);

  await runCommand(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    [
      "$ErrorActionPreference = 'Stop'",
      "$mail = (New-Object -ComObject Outlook.Application).CreateItem(0)",
      "$mail.To = $args[0]",
      "$mail.Subject = 'Convert'",
      "$mail.Body = ''",
      "[void] $mail.Attachments.Add($args[1])",
      "$mail.Display()"
    ].join("; "),
    kindleEmail,
    epubPath
  ]);
}

async function readEpubStructure(extractDir: string): Promise<EpubStructure> {
  const containerPath = path.join(extractDir, "META-INF", "container.xml");
  const containerXml = await readFile(containerPath, "utf8");
  const rootfile = parseAttrs(containerXml.match(/<rootfile\b[^>]*>/i)?.[0] || "")["full-path"];
  if (!rootfile) throw new Error("EPUB is missing META-INF/container.xml rootfile.");

  const opfPath = path.join(extractDir, decodeUriPath(rootfile));
  const opfDir = path.dirname(opfPath);
  const opfXml = await readFile(opfPath, "utf8");
  const manifest = new Map<string, ManifestItem>();
  const spine: SpineItem[] = [];

  for (const match of opfXml.matchAll(/<item\b[^>]*>/gi)) {
    const attrs = parseAttrs(match[0]);
    if (attrs.id && attrs.href) {
      manifest.set(attrs.id, {
        id: attrs.id,
        href: attrs.href,
        "media-type": attrs["media-type"],
        properties: attrs.properties
      });
    }
  }

  for (const match of opfXml.matchAll(/<itemref\b[^>]*>/gi)) {
    const attrs = parseAttrs(match[0]);
    if (attrs.idref && attrs.linear !== "no") {
      spine.push({
        idref: attrs.idref,
        linear: attrs.linear
      });
    }
  }

  const title = decodeEntities(opfXml.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1] || "");
  const navItems = await readNavItems(manifest, opfDir);
  const navTitles = new Map<string, string>();
  for (const item of navItems) {
    if (!navTitles.has(item.href)) navTitles.set(item.href, item.title);
  }

  return { manifest, navItems, navTitles, opfDir, spine, title };
}

async function readNavItems(manifest: Map<string, ManifestItem>, opfDir: string): Promise<NavItem[]> {
  const items: NavItem[] = [];
  const navItem = [...manifest.values()].find((item) => /\bnav\b/i.test(item.properties || ""));
  const ncxItem = [...manifest.values()].find((item) => /ncx/i.test(item["media-type"] || "") || /\.ncx$/i.test(item.href || ""));

  if (navItem) {
    const navPath = path.join(opfDir, decodeUriPath(navItem.href));
    const navHtml = await readFile(navPath, "utf8").catch(() => "");
    for (const match of navHtml.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const attrs = parseAttrs(match[1]);
      if (!attrs.href) continue;
      const href = stripFragment(decodeUriPath(attrs.href));
      const title = decodeEntities(match[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
      if (href && title) {
        items.push({
          href: normalizeFilePath(path.relative(opfDir, path.join(path.dirname(navPath), href))),
          title
        });
      }
    }
  }

  if (items.length === 0 && ncxItem) {
    const ncxPath = path.join(opfDir, decodeUriPath(ncxItem.href));
    const ncxXml = await readFile(ncxPath, "utf8").catch(() => "");
    for (const match of ncxXml.matchAll(/<navLabel\b[^>]*>\s*<text\b[^>]*>([\s\S]*?)<\/text>\s*<\/navLabel>\s*<content\b([^>]*)>/gi)) {
      const title = decodeEntities(match[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
      const src = parseAttrs(match[2]).src;
      if (src && title) {
        items.push({
          href: normalizeFilePath(path.relative(opfDir, path.join(path.dirname(ncxPath), stripFragment(decodeUriPath(src))))),
          title
        });
      }
    }
  }

  return items;
}

async function copyEpubMedia(epub: EpubStructure, mediaDir: string): Promise<Map<string, string>> {
  const mediaMap = new Map<string, string>();
  const usedNames = new Set<string>();

  for (const item of epub.manifest.values()) {
    if (!/^image\//i.test(item["media-type"] || "")) continue;

    const sourcePath = path.join(epub.opfDir, decodeUriPath(item.href));
    const info = await stat(sourcePath).catch(() => null);
    if (!info?.isFile()) continue;

    const safeName = uniqueFileName(sanitizeMediaName(path.basename(sourcePath)), usedNames);
    await copyFile(sourcePath, path.join(mediaDir, safeName));

    const mediaHref = normalizeFilePath(`media/${safeName}`);
    mediaMap.set(normalizeFilePath(sourcePath), mediaHref);
    mediaMap.set(normalizeFilePath(path.relative(epub.opfDir, sourcePath)), mediaHref);
    mediaMap.set(normalizeFilePath(item.href), mediaHref);
  }

  return mediaMap;
}

function prepareChapterHtml(html: string, sourcePath: string, opfDir: string, mediaMap: Map<string, string>): string {
  let output = html
    .replace(/<head\b[\s\S]*?<\/head>/gi, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/\sclass=(["']).*?\1/gi, "")
    .replace(/\sstyle=(["']).*?\1/gi, "");

  output = output.replace(/\s(?:src|href|xlink:href)=(["'])([^"']+)\1/gi, (full, quote: string, rawUrl: string) => {
    const rewritten = rewriteResourceUrl(rawUrl, sourcePath, opfDir, mediaMap);
    const attr = full.trimStart().split("=")[0];
    return ` ${attr}=${quote}${rewritten}${quote}`;
  });

  output = output.replace(/<svg\b[\s\S]*?<image\b[^>]*(?:href|xlink:href)=(["'])([^"']+)\1[^>]*>[\s\S]*?<\/svg>/gi, (_full, _quote, imageSrc: string) => {
    return `<p><img src="${imageSrc}" /></p>`;
  });

  return output;
}

function rewriteResourceUrl(rawUrl: string, sourcePath: string, opfDir: string, mediaMap: Map<string, string>): string {
  if (/^(?:https?:|mailto:|#|data:)/i.test(rawUrl)) return rawUrl;

  const cleanUrl = stripFragment(decodeUriPath(rawUrl));
  const absolute = normalizeFilePath(path.join(path.dirname(sourcePath), cleanUrl));
  const relativeToOpf = normalizeFilePath(path.relative(opfDir, path.join(path.dirname(sourcePath), cleanUrl)));
  return mediaMap.get(absolute) || mediaMap.get(relativeToOpf) || mediaMap.get(normalizeFilePath(cleanUrl)) || rawUrl;
}

function cleanMarkdown(rawMarkdown: string, title: string): string {
  let markdown = rawMarkdown
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, "$1")
    .replace(/<\/?(?:span|div|section|article|body|html|figure|figcaption)\b[^>]*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/^\s*\\\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const lines = markdown.split("\n");
  while (lines.length && isLikelyTocLine(lines[0])) lines.shift();
  markdown = lines.join("\n").trim();

  if (!markdown.startsWith("# ")) {
    markdown = `# ${title}\n\n${markdown}`;
  }

  return `${markdown.trim()}\n`;
}

function splitMarkdownByNav(markdown: string, navItems: NavItem[], fallbackTitle: string): Section[] {
  if (navItems.length < 2) return [{ title: fallbackTitle, markdown }];

  const lines = markdown.split("\n");
  const anchors: Array<{ index: number; title: string }> = [];
  let searchFrom = 0;
  const seenTitles = new Set<string>();

  for (const item of navItems) {
    const normalizedTitle = normalizeTitle(item.title);
    if (!normalizedTitle || seenTitles.has(normalizedTitle)) continue;
    seenTitles.add(normalizedTitle);

    const index = findTitleLine(lines, normalizedTitle, searchFrom);
    if (index === -1) continue;

    anchors.push({ index, title: item.title });
    searchFrom = index + 1;
  }

  if (anchors.length < 2) return [{ title: fallbackTitle, markdown }];

  const sections: Section[] = [];
  for (let index = 0; index < anchors.length; index += 1) {
    const start = anchors[index].index;
    const end = anchors[index + 1]?.index ?? lines.length;
    const title = anchors[index].title;
    const body = lines.slice(start + 1, end).join("\n").trim();
    if (!body) continue;
    sections.push({
      title,
      markdown: `# ${title}\n\n${body}\n`
    });
  }

  return sections.length > 1 ? sections : [{ title: fallbackTitle, markdown }];
}

function buildIndex(bookName: string, chapters: Chapter[], keepSourceEpub: boolean): string {
  const chapterLinks = chapters
    .map((chapter) => `- [[${chapter.filename.replace(/\.md$/, "")}|${chapter.title}]]`)
    .join("\n");
  const sourceLine = keepSourceEpub ? "- [[source.epub]]\n" : "";

  return `# ${bookName}\n\n## Reading entry\n\n${chapterLinks}\n\n## Source\n\n${sourceLine}- [[AI Reading Guide]]\n`;
}

function buildReadingGuide(bookName: string, chapters: Chapter[]): string {
  const chapterList = chapters.map((chapter) => `- [ ] [[${chapter.filename.replace(/\.md$/, "")}|${chapter.title}]]`).join("\n");
  return `# AI Reading Guide - ${bookName}\n\nUse this file as the starting point for AI-assisted reading in Obsidian. Ask Claude or Codex to summarize one chapter at a time, extract claims, list mental models, and generate review questions.\n\n## Chapter checklist\n\n${chapterList}\n\n## Suggested prompts\n\n- Summarize the current chapter in five bullet points.\n- Extract the key concepts and define them in plain language.\n- Turn this chapter into atomic notes with backlinks.\n- List passages worth quoting and explain why they matter.\n- Create review questions for spaced repetition.\n`;
}

function isLikelyTocLine(line: string): boolean {
  const text = line.trim();
  if (!text) return true;
  return /^\[.+\]\(#.+\)\s*\\?$/.test(text) || /^<.+>$/.test(text);
}

function findTitleLine(lines: string[], normalizedTitle: string, start: number): number {
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index].replace(/^#+\s*/, "").trim();
    if (normalizeTitle(line) === normalizedTitle) return index;
  }

  return -1;
}

function normalizeTitle(value: string): string {
  return value
    .replace(/^\s*\d+\s*[.)]\s*/, "")
    .replace(/\u00a0/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function shouldSkipThinSection(item: ManifestItem, title: string): boolean {
  const value = `${item.id || ""} ${item.href || ""} ${title || ""}`;
  return /cover|titlepage|copyright|toc|nav|contents?/i.test(value);
}

function isHtmlItem(item: ManifestItem): boolean {
  return /xhtml|html/i.test(item["media-type"] || "") || /\.(?:xhtml|html?)$/i.test(item.href || "");
}

function extractHtmlTitle(html: string): string {
  const heading = html.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i)?.[1];
  const title = heading || html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return title ? decodeEntities(title.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() : "";
}

function sanitizeBookName(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}._ -]+/gu, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 80);

  return cleaned || `book-${randomId()}`;
}

function sanitizeFileName(name: string): string {
  const cleaned = decodeEntities(name)
    .normalize("NFKD")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[<>:"/\\|?*\p{Cc}]+/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 96);

  return cleaned || "Untitled";
}

function sanitizeMediaName(name: string): string {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  const safeBase = sanitizeFileName(base);
  const safeExt = ext.replace(/[^a-z0-9.]/gi, "").toLowerCase();
  return `${safeBase}${safeExt || ".bin"}`;
}

function uniqueFileName(name: string, usedNames: Set<string>): string {
  const ext = path.extname(name);
  const base = path.basename(name, ext) || "image";
  let candidate = `${base}${ext}`;
  let count = 2;

  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${base}-${count}${ext}`;
    count += 1;
  }

  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[match[1]] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return attrs;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function decodeUriPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeFilePath(value: string): string {
  return path.normalize(value).split(path.sep).join("/");
}

function stripFragment(value: string): string {
  return value.split("#")[0];
}

function getPandocCandidates(configuredPath: string): Array<string | undefined> {
  if (os.platform() === "win32") {
    return [
      configuredPath,
      "C:\\Program Files\\Pandoc\\pandoc.exe",
      "C:\\Program Files (x86)\\Pandoc\\pandoc.exe",
      path.join(os.homedir(), "AppData", "Local", "Pandoc", "pandoc.exe"),
      "pandoc.exe",
      "pandoc"
    ];
  }

  return [
    configuredPath,
    "/opt/homebrew/bin/pandoc",
    "/usr/local/bin/pandoc",
    "/usr/bin/pandoc"
  ];
}

async function extractEpub(inputPath: string, extractDir: string, tempDir: string): Promise<void> {
  if (os.platform() === "win32") {
    await extractEpubWithPowerShell(inputPath, extractDir, tempDir);
    return;
  }

  const unzip = await resolveCommand("unzip", ["/usr/bin/unzip"]);
  await runCommand(unzip, ["-q", inputPath, "-d", extractDir]);
}

async function extractEpubWithPowerShell(inputPath: string, extractDir: string, tempDir: string): Promise<void> {
  const zipPath = path.join(tempDir, "source.zip");
  await copyFile(inputPath, zipPath);

  const powershell = await resolveCommand("powershell.exe", [
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "powershell.exe",
    "pwsh.exe"
  ]);

  await runCommand(powershell, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
    zipPath,
    extractDir
  ]);
}

async function resolveCommand(command: string, candidates: Array<string | undefined>): Promise<string> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next likely install location.
    }
  }

  return command;
}

function runCommand(command: string, args: string[], options: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function randomId(): string {
  return createHash("sha1").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 8);
}
