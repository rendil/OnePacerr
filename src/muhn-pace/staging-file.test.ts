import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MuhnPaceSourceEntry } from './muhn-pace.model.js'
import {
	formatStagingSizeStatus,
	isStagingFileComplete,
} from './staging-file.js'

describe('staging-file', () => {
	const source: MuhnPaceSourceEntry = {
		arc: 19,
		episode: 1,
		album_id: 'album',
		file_id: 'file-id',
		filename: 'test.mp4',
		size_bytes: 100,
	}

	it('isStagingFileComplete returns true when size matches size_bytes', () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'onepacerr-staging-'))
		const filePath = path.join(dir, 'file-id.mp4')
		writeFileSync(filePath, Buffer.alloc(100))

		expect(isStagingFileComplete(source, filePath)).toBe(true)
	})

	it('isStagingFileComplete returns true when size exceeds size_bytes', () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'onepacerr-staging-'))
		const filePath = path.join(dir, 'file-id.mp4')
		writeFileSync(filePath, Buffer.alloc(110))

		expect(isStagingFileComplete(source, filePath)).toBe(true)
	})

	it('isStagingFileComplete returns false for a partial file', () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'onepacerr-staging-'))
		const filePath = path.join(dir, 'file-id.mp4')
		writeFileSync(filePath, Buffer.alloc(40))

		expect(isStagingFileComplete(source, filePath)).toBe(false)
		expect(formatStagingSizeStatus(source, filePath)).toBe('40 / 100 B')
	})
})
