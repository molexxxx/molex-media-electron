/**
 * @module main/ffmpeg/unzip
 * @description Hardened zip extraction for downloaded FFmpeg archives.
 *
 * Replaces the unmaintained `extract-zip` package (GHSA-jmr9-qjv8-65gv),
 * which wrote symlink entries without validating their targets. This
 * implementation refuses symlinks and any other non-regular entry outright,
 * and resolves every entry against the destination root so a crafted archive
 * cannot write outside it.
 */

import * as fs from 'fs'
import * as path from 'path'
import type { Entry, ZipFile } from 'yauzl'

const S_IFMT = 0o170000
const S_IFLNK = 0o120000
const S_IFREG = 0o100000
const S_IFDIR = 0o040000
const MADE_BY_UNIX = 3
const DEFAULT_FILE_MODE = 0o644

/**
 * Resolves a zip entry name against the destination root, rejecting any name
 * that would escape it.
 *
 * @param root     - Absolute path of the extraction directory.
 * @param fileName - Raw entry name from the archive.
 * @returns The absolute path the entry may be written to.
 * @throws If the entry name traverses outside `root`.
 */
function safeJoin(root: string, fileName: string): string {
  // Zip names are spec'd to use forward slashes; a backslash is either an
  // archive built on Windows or an attempt to dodge a '/'-based check.
  const normalized = fileName.replace(/\\/g, '/')

  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new Error(`Refusing to extract entry with traversal segment: ${fileName}`)
  }

  const target = path.resolve(root, normalized)
  const relative = path.relative(root, target)

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to extract entry outside destination: ${fileName}`)
  }

  return target
}

/**
 * Reads the unix file mode from a zip entry, or 0 when the archive was not
 * built on a unix host.
 */
function entryMode(entry: Entry): number {
  if (entry.versionMadeBy >> 8 !== MADE_BY_UNIX) return 0
  return (entry.externalFileAttributes >>> 16) & 0xffff
}

/**
 * Extracts a zip archive into a directory.
 *
 * Directory and regular file entries are written; symlinks, devices, fifos
 * and sockets are rejected, as is any entry resolving outside `destDir`. A
 * rejected entry aborts the whole extraction rather than being skipped, so a
 * tampered archive never yields a partially trusted tree.
 *
 * @param zipPath - Absolute path to the archive.
 * @param destDir - Directory to extract into; created entries stay inside it.
 * @throws If the archive cannot be read or contains a disallowed entry.
 */
export function extractZip(zipPath: string, destDir: string): Promise<void> {
  const root = path.resolve(destDir)

  return new Promise<void>((resolve, reject) => {
    void import('yauzl').then((mod) => {
      const yauzl = mod.default ?? mod

      yauzl.open(zipPath, { lazyEntries: true }, (openErr, zipfile: ZipFile) => {
        if (openErr || !zipfile) {
          reject(openErr ?? new Error('Could not open archive'))
          return
        }

        let settled = false

        const fail = (err: Error): void => {
          if (settled) return
          settled = true
          zipfile.close()
          reject(err)
        }

        const done = (): void => {
          if (settled) return
          settled = true
          resolve()
        }

        zipfile.on('error', fail)
        zipfile.on('end', done)

        zipfile.on('entry', (entry: Entry) => {
          let target: string
          try {
            target = safeJoin(root, entry.fileName)
          } catch (err) {
            fail(err as Error)
            return
          }

          const mode = entryMode(entry)
          const type = mode & S_IFMT

          if (type === S_IFLNK) {
            fail(new Error(`Refusing to extract symlink entry: ${entry.fileName}`))
            return
          }
          if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) {
            fail(new Error(`Refusing to extract non-regular entry: ${entry.fileName}`))
            return
          }

          if (entry.fileName.endsWith('/')) {
            fs.mkdir(target, { recursive: true }, (err) =>
              err ? fail(err) : zipfile.readEntry()
            )
            return
          }

          fs.mkdir(path.dirname(target), { recursive: true }, (mkdirErr) => {
            if (mkdirErr) {
              fail(mkdirErr)
              return
            }

            zipfile.openReadStream(entry, (streamErr, readStream) => {
              if (streamErr || !readStream) {
                fail(streamErr ?? new Error(`Could not read entry: ${entry.fileName}`))
                return
              }

              const permissions = mode & 0o777
              const out = fs.createWriteStream(target, {
                mode: permissions || DEFAULT_FILE_MODE
              })

              readStream.on('error', fail)
              out.on('error', fail)
              out.on('close', () => {
                if (!settled) zipfile.readEntry()
              })

              readStream.pipe(out)
            })
          })
        })

        zipfile.readEntry()
      })
    }, reject)
  })
}
