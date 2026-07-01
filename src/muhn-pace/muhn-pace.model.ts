export type MuhnPaceSourceEntry = {
	arc: number
	episode: number
	album_id: string
	file_id: string
	filename: string
	size_bytes?: number
}

export type MuhnPaceSources = {
	version: string
	entries: MuhnPaceSourceEntry[]
}

/** arc/episode and expected CRC captured at queue time (metadata is private on MetadataController). */
export type MuhnPaceDownloadJob = {
	arc: number
	episode: number
	expectedCrc: string
	source: MuhnPaceSourceEntry
}

export type MuhnPaceQueuedJob = MuhnPaceDownloadJob & {
	attempts: number
	nextAttemptAt: number
}

export type MuhnPaceFailureReason = 'download' | 'crc_mismatch'
