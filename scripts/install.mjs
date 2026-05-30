#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFile, chmod, lstat, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const managedFiles = [
  ["profile/AGENTS.md", "AGENTS.md"],
  ["profile/SYSTEM.md", "SYSTEM.md"],
  ["profile/APPEND_SYSTEM.md", "APPEND_SYSTEM.md"],
  ["profile/settings.json", "settings.json"],
  ["profile/keybindings.json", "keybindings.json"],
  ["profile/models.json", "models.json"],
];

function usage() {
  console.log(`Usage: node scripts/install.mjs [options]

Options:
  --dry-run     Show what would change without writing files
  --no-backup   Do not back up existing destination files before overwriting
  -h, --help    Show this help

Environment:
  PI_CODING_AGENT_DIR  Pi config directory (default: ~/.pi/agent)`);
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    backup: true,
  };

  for (const arg of argv) {
    switch (arg) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--no-backup":
        options.backup = false;
        break;
      case "-h":
      case "--help":
        usage();
        process.exit(0);
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        usage();
        process.exit(2);
    }
  }

  return options;
}

function expandHome(input) {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

function timestamp() {
  const value = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return [
    value.getFullYear(),
    pad(value.getMonth() + 1),
    pad(value.getDate()),
    "-",
    pad(value.getHours()),
    pad(value.getMinutes()),
    pad(value.getSeconds()),
  ].join("");
}

async function maybeLstat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function ensureDirectory(path, { dryRun }) {
  const info = await maybeLstat(path);
  if (info?.isDirectory()) return;
  if (info) throw new Error(`Expected directory but found something else: ${path}`);

  if (dryRun) {
    console.log(`Would create directory: ${path}`);
  } else {
    await mkdir(path, { recursive: true });
  }
}

async function fileHash(path) {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

async function hasSameFileContent(left, right) {
  const rightInfo = await maybeLstat(right);
  if (!rightInfo?.isFile()) return false;

  const [leftHash, rightHash] = await Promise.all([fileHash(left), fileHash(right)]);
  return leftHash === rightHash;
}

class Installer {
  constructor({ root, piDir, dryRun, backup }) {
    this.root = root;
    this.piDir = piDir;
    this.dryRun = dryRun;
    this.backup = backup;
    this.backupDir = undefined;
  }

  async ensureBackupDirectory() {
    if (this.backupDir) return this.backupDir;

    this.backupDir = join(this.piDir, "backups", `pi-private-${timestamp()}`);
    await ensureDirectory(this.backupDir, { dryRun: this.dryRun });
    return this.backupDir;
  }

  async backupExisting(destination, destinationName, destinationInfo) {
    if (!this.backup) return;

    const backupDir = await this.ensureBackupDirectory();
    const backupPath = join(backupDir, destinationName);
    await ensureDirectory(dirname(backupPath), { dryRun: this.dryRun });

    if (destinationInfo.isSymbolicLink()) {
      const metadataPath = `${backupPath}.symlink.txt`;
      if (this.dryRun) {
        console.log(`Would back up symlink metadata: ${destination} -> ${metadataPath}`);
        return;
      }

      const target = await readlink(destination);
      await writeFile(metadataPath, `symlink -> ${target}\n`, "utf8");
      return;
    }

    if (this.dryRun) {
      console.log(`Would back up: ${destination} -> ${backupPath}`);
    } else {
      await copyFile(destination, backupPath);
    }
  }

  async copyProfileFile(sourceRelativePath, destinationName) {
    const source = join(this.root, sourceRelativePath);
    const sourceInfo = await maybeLstat(source);
    if (!sourceInfo?.isFile()) return;

    await ensureDirectory(this.piDir, { dryRun: this.dryRun });

    const destination = join(this.piDir, destinationName);
    const destinationInfo = await maybeLstat(destination);

    if (destinationInfo) {
      const isSymlink = destinationInfo.isSymbolicLink();
      if (!isSymlink && destinationInfo.isFile() && (await hasSameFileContent(source, destination))) {
        console.log(`Unchanged: ${destination}`);
        return;
      }

      if (!isSymlink && !destinationInfo.isFile()) {
        throw new Error(`Destination exists and is not a file: ${destination}`);
      }

      await this.backupExisting(destination, destinationName, destinationInfo);

      // Avoid writing through an existing symlink. Replace it with a real file.
      if (isSymlink) {
        if (this.dryRun) {
          console.log(`Would remove symlink: ${destination}`);
        } else {
          await rm(destination, { force: true });
        }
      }
    }

    if (this.dryRun) {
      console.log(`Would install: ${source} -> ${destination}`);
      return;
    }

    await copyFile(source, destination);
    await chmod(destination, 0o644).catch(() => {});
    console.log(`Installed: ${destination}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(scriptDir, "..");
  const piDir = resolve(expandHome(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")));

  console.log(`Pi private profile root: ${root}`);
  console.log(`Pi config directory: ${piDir}`);

  const installer = new Installer({
    root,
    piDir,
    dryRun: options.dryRun,
    backup: options.backup,
  });

  for (const [sourceRelativePath, destinationName] of managedFiles) {
    await installer.copyProfileFile(sourceRelativePath, destinationName);
  }

  if (installer.backupDir) {
    console.log(`Backups written to: ${installer.backupDir}`);
  }

  console.log("Done. Restart Pi or run /reload inside Pi to pick up changes.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
