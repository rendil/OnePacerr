import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import path from 'node:path'
import environment from '../environment.js'
import { getMuhnPaceCrc32 } from '../metadata/muhn-pace-metadata.js'
import { QueueDownloadResult } from '../torrent/torrent.model.js'
import { Context } from '../util/context.js'
import getFileCrc32Hash from '../util/crc32.js'
import { Logger } from 'ez-ts-logger'
import type {
	MuhnPaceFailureReason,
	MuhnPaceQueuedJob,
	MuhnPaceSourceEntry,
} from './muhn-pace.model.js'
import {
	findMuhnPaceSource,
	findMuhnPaceSourceByFileId,
	loadMuhnPaceSources,
} from './muhn-pace-sources.js'
import { downloadPixeldrainFile } from './pixeldrain-download.js'
import {
	formatStagingSizeStatus,
	isStagingFileComplete,
} from './staging-file.js'

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}

export class MuhnPaceController {
	private readonly sources
	private readonly queue: MuhnPaceQueuedJob[] = []
	private readonly preferBypassAlbums = new Set<string>()
	private readonly inProgressDownloads = new Set<string>()
	private pendingDownloadsActive = false
	private stagingScanActive = false
	private stagingScanQueued = false

	static validateStagingDir(
		dir: string = environment.MUHN_PACE_DOWNLOAD_DIR,
	): void {
		mkdirSync(dir, { recursive: true })
		const probe = path.join(dir, '.write-probe')
		try {
			writeFileSync(probe, '')
			unlinkSync(probe)
		} catch {
			throw new Error(`[Muhn Pace] Staging directory is not writable: ${dir}`)
		}
	}

	constructor(options?: { sourcesPath?: string }) {
		this.sources = loadMuhnPaceSources(options?.sourcesPath)
		MuhnPaceController.validateStagingDir()
	}

	hasSource(arc: number, episode: number): boolean {
		return findMuhnPaceSource(this.sources, arc, episode) !== undefined
	}

	async queueDownload(
		arc: number,
		episode: number,
	): Promise<QueueDownloadResult> {
		if (environment.PIPELINE_SKIP_DOWNLOADS) {
			Logger.info(`Downloads disabled by env vars`)
			return 'skipped'
		}

		if (this.isQueued(arc, episode)) {
			Logger.debug(
				`[Muhn Pace] Already queued S${String(arc).padStart(2, '0')}E${String(episode).padStart(2, '0')}`,
			)
			return 'added'
		}

		const source = findMuhnPaceSource(this.sources, arc, episode)
		if (!source) {
			Logger.warn(
				`[Muhn Pace] No source entry for S${String(arc).padStart(2, '0')}E${String(episode).padStart(2, '0')}`,
			)
			return 'source_missing'
		}

		const expectedCrc = getMuhnPaceCrc32(
			Context.metadata.getMetadata(),
			arc,
			episode,
		)
		if (!expectedCrc) {
			Logger.warn(
				`[Muhn Pace] No CRC metadata for S${String(arc).padStart(2, '0')}E${String(episode).padStart(2, '0')}`,
			)
			return 'source_missing'
		}

		const stagingStatus = await this.getStagingFileStatus(source, expectedCrc)
		if (stagingStatus === 'ready') {
			Logger.info(
				`[Muhn Pace] Complete staging file already present for S${String(arc).padStart(2, '0')}E${String(episode).padStart(2, '0')}`,
			)
			return 'already_staged'
		}

		if (stagingStatus === 'invalid') {
			const stagingPath = this.stagingPathForSource(source)
			Logger.warn(
				`[Muhn Pace] Invalid staging file for S${String(arc).padStart(2, '0')}E${String(episode).padStart(2, '0')}, will re-download`,
			)
			unlinkSync(stagingPath)
		}

		this.queue.push({
			arc,
			episode,
			expectedCrc,
			source,
			attempts: 0,
			nextAttemptAt: Date.now(),
		})
		return 'added'
	}

	async processPendingDownloads(): Promise<void> {
		if (this.pendingDownloadsActive) {
			return
		}
		this.pendingDownloadsActive = true
		try {
			while (true) {
				const now = Date.now()
				const jobIndex = this.queue.findIndex(
					job => job.nextAttemptAt <= now,
				)
				if (jobIndex === -1) {
					break
				}

				// Backpressure: don't outrun the importer. Pause downloads while
				// the staging dir already holds MUHN_PACE_MAX_STAGING_FILES
				// completed files awaiting import, so slow library/NAS copies
				// can't let staging grow unbounded and fill the disk.
				if (
					this.countStagedBacklog() >=
					environment.MUHN_PACE_MAX_STAGING_FILES
				) {
					Logger.info(
						`[Muhn Pace] Staging backlog at capacity (${environment.MUHN_PACE_MAX_STAGING_FILES} awaiting import), pausing downloads until imports catch up`,
					)
					break
				}

				const job = this.queue.splice(jobIndex, 1)[0]!
				const stagingPath = path.join(
					environment.MUHN_PACE_DOWNLOAD_DIR,
					`${job.source.file_id}.mp4`,
				)

				try {
					await this.downloadFile(
						job.source,
						stagingPath,
						job.attempts + 1,
						environment.MUHN_PACE_MAX_RETRIES,
					)
					Logger.info(
						`[Muhn Pace] Download complete for S${String(job.arc).padStart(2, '0')}E${String(job.episode).padStart(2, '0')} — awaiting staging import`,
					)
				} catch (error) {
					Logger.error(
						`[Muhn Pace] Download failed for S${String(job.arc).padStart(2, '0')}E${String(job.episode).padStart(2, '0')}`,
					)
					Logger.error(error instanceof Error ? error.message : error)
					if (existsSync(stagingPath)) {
						unlinkSync(stagingPath)
					}
					this.scheduleRetry(job, 'download')
				}
			}
		} finally {
			this.pendingDownloadsActive = false
		}
	}

	private isQueued(arc: number, episode: number): boolean {
		return this.queue.some(job => job.arc === arc && job.episode === episode)
	}

	/** Count completed, recognized staging files still awaiting import. */
	private countStagedBacklog(): number {
		const stagingDir = environment.MUHN_PACE_DOWNLOAD_DIR
		if (!existsSync(stagingDir)) {
			return 0
		}

		let count = 0
		for (const name of readdirSync(stagingDir)) {
			if (!name.endsWith('.mp4')) {
				continue
			}
			const fileId = name.slice(0, -4)
			if (this.inProgressDownloads.has(fileId)) {
				continue
			}
			const source = findMuhnPaceSourceByFileId(this.sources, fileId)
			if (!source) {
				continue
			}
			if (isStagingFileComplete(source, path.join(stagingDir, name))) {
				count++
			}
		}
		return count
	}

	private scheduleRetry(
		job: MuhnPaceQueuedJob,
		reason: MuhnPaceFailureReason,
	): void {
		job.attempts += 1

		if (job.attempts >= environment.MUHN_PACE_MAX_RETRIES) {
			Logger.error(
				`[Muhn Pace] Abandoning S${String(job.arc).padStart(2, '0')}E${String(job.episode).padStart(2, '0')} after ${environment.MUHN_PACE_MAX_RETRIES} attempts (${reason})`,
			)
			return
		}

		const delayMs = Math.min(
			environment.MUHN_PACE_RETRY_BASE_DELAY_MS * 2 ** (job.attempts - 1),
			environment.MUHN_PACE_RETRY_MAX_DELAY_MS,
		)
		job.nextAttemptAt = Date.now() + delayMs
		this.queue.push(job)

		Logger.warn(
			`[Muhn Pace] Re-queued S${String(job.arc).padStart(2, '0')}E${String(job.episode).padStart(2, '0')} (attempt ${job.attempts + 1}/${environment.MUHN_PACE_MAX_RETRIES}) in ${Math.round(delayMs / 1000)}s (${reason})`,
		)
	}

	private formatDownloadLabel(entry: MuhnPaceSourceEntry): string {
		return `S${String(entry.arc).padStart(2, '0')}E${String(entry.episode).padStart(2, '0')} · ${entry.filename}`
	}

	private stagingPathForSource(source: MuhnPaceSourceEntry): string {
		return path.join(
			environment.MUHN_PACE_DOWNLOAD_DIR,
			`${source.file_id}.mp4`,
		)
	}

	private async getStagingFileStatus(
		source: MuhnPaceSourceEntry,
		expectedCrc: string,
	): Promise<'missing' | 'partial' | 'ready' | 'invalid'> {
		const stagingPath = this.stagingPathForSource(source)
		if (!existsSync(stagingPath)) {
			return 'missing'
		}

		if (this.inProgressDownloads.has(source.file_id)) {
			return 'partial'
		}

		if (!isStagingFileComplete(source, stagingPath)) {
			return 'partial'
		}

		const actualCrc = await getFileCrc32Hash(stagingPath)
		return actualCrc === expectedCrc ? 'ready' : 'invalid'
	}

	private async downloadFile(
		entry: MuhnPaceSourceEntry,
		destPath: string,
		attemptNumber: number,
		maxAttempts: number,
	): Promise<void> {
		const maxAttemptsPerRound = 3
		let lastError: unknown

		this.inProgressDownloads.add(entry.file_id)
		try {
			for (let attempt = 0; attempt < maxAttemptsPerRound; attempt++) {
				if (attempt > 0) {
					await sleep(1000 * 2 ** (attempt - 1))
					if (existsSync(destPath)) {
						unlinkSync(destPath)
					}
				}

				try {
					if (
						!(await this.tryUseExistingStagingFile(
							entry,
							destPath,
							attemptNumber,
							maxAttempts,
						))
					) {
						await downloadPixeldrainFile({
							fileId: entry.file_id,
							destPath,
							forceBypass: this.preferBypassAlbums.has(entry.album_id),
							onPreferBypass: () => {
								this.preferBypassAlbums.add(entry.album_id)
							},
							label: this.formatDownloadLabel(entry),
							expectedTotalBytes: entry.size_bytes,
							attempt: attemptNumber,
							maxAttempts,
						})
					}
					return
				} catch (error) {
					lastError = error
					if (attempt === maxAttemptsPerRound - 1) {
						if (existsSync(destPath)) {
							unlinkSync(destPath)
						}
						throw error
					}
				}
			}

			throw lastError
		} finally {
			this.inProgressDownloads.delete(entry.file_id)
		}
	}

	private async importDownloadedFile(
		job: MuhnPaceQueuedJob,
		stagingPath: string,
	): Promise<QueueDownloadResult> {
		const actualCrc = await getFileCrc32Hash(stagingPath)
		if (actualCrc !== job.expectedCrc) {
			unlinkSync(stagingPath)
			return 'crc_mismatch'
		}

		const episode = Context.metadata.getEpisode(job.arc, job.episode)
		const targetLibraryFile =
			await Context.library.getTargetLibraryEpisodeFile(episode)
		const destination = path.resolve(
			targetLibraryFile.path,
			targetLibraryFile.filename,
		)

		mkdirSync(path.dirname(destination), { recursive: true })
		copyFileSync(stagingPath, destination)
		unlinkSync(stagingPath)

		Logger.info(
			`[Muhn Pace] Imported S${String(job.arc).padStart(2, '0')}E${String(job.episode).padStart(2, '0')}`,
		)

		try {
			await Context.pipeline.updatemetadata(job.arc, job.episode)
		} catch (error) {
			Logger.warn(
				`[Muhn Pace] Metadata update failed for S${String(job.arc).padStart(2, '0')}E${String(job.episode).padStart(2, '0')} after import`,
			)
			Logger.warn(error instanceof Error ? error.message : error)
		}

		return 'added'
	}

	private createJobFromSource(
		source: MuhnPaceSourceEntry,
	): MuhnPaceQueuedJob | undefined {
		const expectedCrc = getMuhnPaceCrc32(
			Context.metadata.getMetadata(),
			source.arc,
			source.episode,
		)
		if (!expectedCrc) {
			return undefined
		}

		return {
			arc: source.arc,
			episode: source.episode,
			expectedCrc,
			source,
			attempts: 0,
			nextAttemptAt: Date.now(),
		}
	}

	private async libraryAlreadyHasMuhnEpisode(
		source: MuhnPaceSourceEntry,
	): Promise<boolean> {
		const expectedCrc = getMuhnPaceCrc32(
			Context.metadata.getMetadata(),
			source.arc,
			source.episode,
		)
		if (!expectedCrc) {
			return false
		}

		const episode = Context.metadata.getEpisode(source.arc, source.episode)
		const libraryFile =
			await Context.library.getExistingLibraryEpisodeFile(episode)
		if (!libraryFile) {
			return false
		}

		if (environment.PIPELINE_SKIP_VERIFY_PRESENT_FILES) {
			return true
		}

		const libraryCrc = await getFileCrc32Hash(libraryFile)
		return libraryCrc === expectedCrc
	}

	async processStagingDirectory(): Promise<void> {
		// Serialize scans: concurrent runs (interval tick + post-download
		// trigger) would otherwise race to import the same file, and the loser
		// crashes on a copyfile ENOENT once the winner deletes it.
		if (this.stagingScanActive) {
			this.stagingScanQueued = true
			return
		}
		this.stagingScanActive = true
		try {
			do {
				this.stagingScanQueued = false
				await this.scanStagingDirectoryOnce()
			} while (this.stagingScanQueued)
		} finally {
			this.stagingScanActive = false
		}
	}

	private async scanStagingDirectoryOnce(): Promise<void> {
		const stagingDir = environment.MUHN_PACE_DOWNLOAD_DIR
		if (!existsSync(stagingDir)) {
			return
		}

		for (const name of readdirSync(stagingDir)) {
			if (!name.endsWith('.mp4')) {
				continue
			}

			const fileId = name.slice(0, -4)
			const stagingPath = path.join(stagingDir, name)
			const source = findMuhnPaceSourceByFileId(this.sources, fileId)
			if (!source) {
				Logger.debug(`[Muhn Pace] Unknown staging file ${name}, skipping`)
				continue
			}

			if (this.isQueued(source.arc, source.episode)) {
				continue
			}

			if (this.inProgressDownloads.has(fileId)) {
				Logger.debug(
					`[Muhn Pace] Staging file ${name} is still downloading, skipping import`,
				)
				continue
			}

			if (!isStagingFileComplete(source, stagingPath)) {
				Logger.debug(
					`[Muhn Pace] Staging file incomplete for S${String(source.arc).padStart(2, '0')}E${String(source.episode).padStart(2, '0')} (${formatStagingSizeStatus(source, stagingPath)})`,
				)
				continue
			}

			try {
				if (await this.libraryAlreadyHasMuhnEpisode(source)) {
					Logger.info(
						`[Muhn Pace] Removing redundant staging file for S${String(source.arc).padStart(2, '0')}E${String(source.episode).padStart(2, '0')} (${name})`,
					)
					if (existsSync(stagingPath)) {
						unlinkSync(stagingPath)
					}
					continue
				}

				const job = this.createJobFromSource(source)
				if (!job) {
					continue
				}

				// Another pass may have imported and removed the file already.
				if (!existsSync(stagingPath)) {
					continue
				}

				Logger.info(
					`[Muhn Pace] Found staged download for S${String(source.arc).padStart(2, '0')}E${String(source.episode).padStart(2, '0')} (${name})`,
				)

				const result = await this.importDownloadedFile(job, stagingPath)
				if (result === 'crc_mismatch') {
					Logger.warn(
						`[Muhn Pace] Staging file CRC mismatch for S${String(source.arc).padStart(2, '0')}E${String(source.episode).padStart(2, '0')} (${name})`,
					)
					this.scheduleRetry(job, 'crc_mismatch')
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
					Logger.debug(
						`[Muhn Pace] Staging file ${name} already handled, skipping`,
					)
					continue
				}
				Logger.error(
					`[Muhn Pace] Failed to import staging file ${name}`,
				)
				Logger.error(error instanceof Error ? error.message : error)
			}
		}
	}

	private async tryUseExistingStagingFile(
		entry: MuhnPaceSourceEntry,
		destPath: string,
		attemptNumber: number,
		maxAttempts: number,
	): Promise<boolean> {
		if (!isStagingFileComplete(entry, destPath)) {
			return false
		}

		const expectedCrc = getMuhnPaceCrc32(
			Context.metadata.getMetadata(),
			entry.arc,
			entry.episode,
		)
		if (!expectedCrc) {
			unlinkSync(destPath)
			return false
		}

		const actualCrc = await getFileCrc32Hash(destPath)
		if (actualCrc === expectedCrc) {
			Logger.info(
				`[Muhn Pace] Reusing complete staged file for S${String(entry.arc).padStart(2, '0')}E${String(entry.episode).padStart(2, '0')} · ${entry.filename} (attempt ${attemptNumber}/${maxAttempts})`,
			)
			return true
		}

		Logger.warn(
			`[Muhn Pace] Staging file CRC mismatch for S${String(entry.arc).padStart(2, '0')}E${String(entry.episode).padStart(2, '0')}, re-downloading`,
		)
		unlinkSync(destPath)
		return false
	}
}
