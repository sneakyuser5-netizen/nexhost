const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const yauzl = require("yauzl");
const { pipeline } = require("node:stream/promises");

const BOTS_DIR = path.resolve(__dirname, "../../storage/bots");

const MAX_FILES = 500;
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_TOTAL_SIZE = 100 * 1024 * 1024;

function extractZip(buffer, destination) {
    return new Promise((resolve, reject) => {
        yauzl.fromBuffer(buffer, {
            lazyEntries: true,
            validateEntrySizes: true
        }, (error, zipfile) => {
            if (error) return reject(error);

            let fileCount = 0;
            let totalSize = 0;
            let settled = false;

            function fail(err) {
                if (settled) return;
                settled = true;

                try {
                    zipfile.close();
                } catch {}

                reject(err);
            }

            zipfile.on("error", fail);

            zipfile.on("end", () => {
                if (settled) return;
                settled = true;
                resolve({ fileCount, totalSize });
            });

            zipfile.on("entry", async (entry) => {
                if (settled) return;

                try {
                    fileCount++;

                    if (fileCount > MAX_FILES) {
                        throw new Error("Archive contains too many entries.");
                    }

                    const name = entry.fileName;

                    if (
                        !name ||
                        name.includes("\\") ||
                        name.includes("\0") ||
                        path.posix.isAbsolute(name) ||
                        /^[a-zA-Z]:/.test(name)
                    ) {
                        throw new Error("Unsafe archive path detected.");
                    }

                    const isDirectory = name.endsWith("/");
                    const segments = name.split("/").filter(Boolean);

                    if (
                        segments.length === 0 ||
                        segments.some(part => part === "." || part === "..")
                    ) {
                        throw new Error("Unsafe archive path detected.");
                    }

                    const relativePath = segments.join("/");
                    const target = path.resolve(destination, relativePath);
                    const relative = path.relative(destination, target);

                    if (
                        relative.startsWith("..") ||
                        path.isAbsolute(relative)
                    ) {
                        throw new Error("Archive path escapes bot directory.");
                    }

                    const unixMode = (entry.externalFileAttributes >>> 16) & 0xFFFF;
                    const fileType = unixMode & 0o170000;

                    if (fileType === 0o120000) {
                        throw new Error("Symbolic links are not allowed.");
                    }

                    if (
                        fileType !== 0 &&
                        fileType !== 0o100000 &&
                        fileType !== 0o040000
                    ) {
                        throw new Error("Special files are not allowed.");
                    }

                    if (isDirectory || fileType === 0o040000) {
                        await fs.promises.mkdir(target, { recursive: true });
                        zipfile.readEntry();
                        return;
                    }

                    if (fileType === 0o120000) {
                        throw new Error("Symbolic links are not allowed.");
                    }

                    if (entry.uncompressedSize > MAX_FILE_SIZE) {
                        throw new Error("An archive file exceeds the size limit.");
                    }

                    totalSize += entry.uncompressedSize;

                    if (totalSize > MAX_TOTAL_SIZE) {
                        throw new Error("Extracted archive exceeds 100 MB.");
                    }

                    await fs.promises.mkdir(path.dirname(target), {
                        recursive: true
                    });

                    await new Promise((resolveStream, rejectStream) => {
                        zipfile.openReadStream(entry, async (streamError, stream) => {
                            if (streamError) return rejectStream(streamError);

                            try {
                                await pipeline(
                                    stream,
                                    fs.createWriteStream(target, {
                                        flags: "wx",
                                        mode: 0o600
                                    })
                                );

                                resolveStream();
                            } catch (err) {
                                rejectStream(err);
                            }
                        });
                    });

                    zipfile.readEntry();

                } catch (err) {
                    fail(err);
                }
            });

            zipfile.readEntry();
        });
    });
}

async function uploadBotArchive(bot, buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
        throw new Error("Invalid ZIP archive.");
    }

    if (
        buffer[0] !== 0x50 ||
        buffer[1] !== 0x4B
    ) {
        throw new Error("Uploaded file is not a valid ZIP archive.");
    }

    await fs.promises.mkdir(BOTS_DIR, { recursive: true });

    const staging = path.join(BOTS_DIR, `.staging-${crypto.randomUUID()}`);
    const target = path.join(BOTS_DIR, bot.id);
    const backup = path.join(BOTS_DIR, `.backup-${crypto.randomUUID()}`);

    await fs.promises.mkdir(staging);

    let backupCreated = false;

    try {
        const result = await extractZip(buffer, staging);

        const entryPath = path.join(staging, bot.entry_file);

        if (!fs.existsSync(entryPath) || !fs.statSync(entryPath).isFile()) {
            throw new Error(
                `Entry file "${bot.entry_file}" was not found in the ZIP archive.`
            );
        }

        if (fs.existsSync(target)) {
            await fs.promises.rename(target, backup);
            backupCreated = true;
        }

        try {
            await fs.promises.rename(staging, target);
        } catch (error) {
            if (backupCreated) {
                await fs.promises.rename(backup, target);
                backupCreated = false;
            }
            throw error;
        }

        if (backupCreated) {
            await fs.promises.rm(backup, {
                recursive: true,
                force: true
            });
        }

        return {
            files: result.fileCount,
            extractedBytes: result.totalSize,
            directory: target
        };

    } catch (error) {
        await fs.promises.rm(staging, {
            recursive: true,
            force: true
        }).catch(() => {});

        if (backupCreated && !fs.existsSync(target)) {
            await fs.promises.rename(backup, target).catch(() => {});
        }

        throw error;
    }
}

module.exports = { uploadBotArchive };
