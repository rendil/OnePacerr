import { existsSync, statSync } from 'node:fs'
import type { MuhnPaceSourceEntry } from './muhn-pace.model.js'

export function isStagingFileComplete(
	source: MuhnPaceSourceEntry,
	stagingPath: string,
): boolean {
	if (!existsSync(stagingPath)) {
		return false
	}

	const { size } = statSync(stagingPath)
	if (size === 0) {
		return false
	}

	// CDN file sizes can differ from the vendored index; CRC verifies content.
	if (source.size_bytes != null) {
		return size >= source.size_bytes
	}

	return true
}

export function formatStagingSizeStatus(
	source: MuhnPaceSourceEntry,
	stagingPath: string,
): string {
	if (!existsSync(stagingPath)) {
		return '0 B'
	}

	const { size } = statSync(stagingPath)
	if (source.size_bytes != null) {
		return `${size} / ${source.size_bytes} B`
	}

	return `${size} B`
}
