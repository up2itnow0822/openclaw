const debug = require("debug")("extract-zip");
const { createWriteStream, promises: fs } = require("fs");
const getStream = require("get-stream");
const path = require("path");
const { promisify } = require("util");
const stream = require("stream");
const yauzl = require("yauzl");

const openZip = promisify(yauzl.open);
const pipeline = promisify(stream.pipeline);

function assertInsideRoot(rootDir, candidate, label) {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(candidate);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(prefix)) {
    throw new Error(`Out of bound path "${resolved}" found while processing ${label}`);
  }
  return resolved;
}

class Extractor {
  constructor(zipPath, opts) {
    this.zipPath = zipPath;
    this.opts = opts;
  }

  async extract() {
    debug("opening", this.zipPath, "with opts", this.opts);

    this.zipfile = await openZip(this.zipPath, { lazyEntries: true });
    this.canceled = false;

    return new Promise((resolve, reject) => {
      this.zipfile.on("error", (err) => {
        this.canceled = true;
        reject(err);
      });
      this.zipfile.readEntry();

      this.zipfile.on("close", () => {
        if (!this.canceled) {
          debug("zip extraction complete");
          resolve();
        }
      });

      this.zipfile.on("entry", async (entry) => {
        if (this.canceled) {
          debug("skipping entry", entry.fileName, { cancelled: this.canceled });
          return;
        }

        debug("zipfile entry", entry.fileName);

        if (entry.fileName.startsWith("__MACOSX/")) {
          this.zipfile.readEntry();
          return;
        }

        const destDir = path.dirname(path.join(this.opts.dir, entry.fileName));

        try {
          await fs.mkdir(destDir, { recursive: true });

          const canonicalDestDir = await fs.realpath(destDir);
          assertInsideRoot(this.opts.dir, canonicalDestDir, `file ${entry.fileName}`);

          await this.extractEntry(entry);
          debug("finished processing", entry.fileName);
          this.zipfile.readEntry();
        } catch (err) {
          this.canceled = true;
          this.zipfile.close();
          reject(err);
        }
      });
    });
  }

  async extractEntry(entry) {
    if (this.canceled) {
      debug("skipping entry extraction", entry.fileName, { cancelled: this.canceled });
      return;
    }

    if (this.opts.onEntry) {
      this.opts.onEntry(entry, this.zipfile);
    }

    const dest = assertInsideRoot(
      this.opts.dir,
      path.join(this.opts.dir, entry.fileName),
      `file ${entry.fileName}`,
    );

    const mode = (entry.externalFileAttributes >> 16) & 0xffff;
    const IFMT = 61440;
    const IFDIR = 16384;
    const IFLNK = 40960;
    const symlink = (mode & IFMT) === IFLNK;
    let isDir = (mode & IFMT) === IFDIR;

    if (!isDir && entry.fileName.endsWith("/")) {
      isDir = true;
    }

    const madeBy = entry.versionMadeBy >> 8;
    if (!isDir) isDir = madeBy === 0 && entry.externalFileAttributes === 16;

    debug("extracting entry", { filename: entry.fileName, isDir, isSymlink: symlink });

    const procMode = this.getExtractedMode(mode, isDir) & 0o777;
    const destDir = isDir ? dest : path.dirname(dest);

    const mkdirOptions = { recursive: true };
    if (isDir) {
      mkdirOptions.mode = procMode;
    }
    debug("mkdir", { dir: destDir, ...mkdirOptions });
    await fs.mkdir(destDir, mkdirOptions);
    if (isDir) return;

    debug("opening read stream", dest);
    const readStream = await promisify(this.zipfile.openReadStream.bind(this.zipfile))(entry);

    if (symlink) {
      const link = await getStream(readStream);
      assertInsideRoot(
        this.opts.dir,
        path.resolve(path.dirname(dest), link),
        `symlink ${entry.fileName}`,
      );
      debug("creating symlink", link, dest);
      await fs.symlink(link, dest);
      return;
    }

    try {
      const destStat = await fs.lstat(dest);
      if (destStat.isSymbolicLink()) {
        throw new Error(`Refusing to overwrite symlink at "${dest}"`);
      }
    } catch (err) {
      if (!err || typeof err !== "object" || !("code" in err) || err.code !== "ENOENT") {
        throw err;
      }
    }

    await pipeline(readStream, createWriteStream(dest, { mode: procMode }));
  }

  getExtractedMode(entryMode, isDir) {
    let mode = entryMode;
    if (mode === 0) {
      if (isDir) {
        if (this.opts.defaultDirMode) {
          mode = parseInt(this.opts.defaultDirMode, 10);
        }
        if (!mode) {
          mode = 0o755;
        }
      } else {
        if (this.opts.defaultFileMode) {
          mode = parseInt(this.opts.defaultFileMode, 10);
        }
        if (!mode) {
          mode = 0o644;
        }
      }
    }

    return mode;
  }
}

module.exports = async function (zipPath, opts) {
  debug("creating target directory", opts.dir);

  if (!path.isAbsolute(opts.dir)) {
    throw new Error("Target directory is expected to be absolute");
  }

  await fs.mkdir(opts.dir, { recursive: true });
  opts.dir = await fs.realpath(opts.dir);
  return new Extractor(zipPath, opts).extract();
};
