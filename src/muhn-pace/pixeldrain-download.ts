import axios from 'axios'
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { dirname } from 'node:path'
import type { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { Logger } from 'ez-ts-logger'
import { DownloadProgressTracker } from './download-progress.js'
import {
	pixeldrainBypassFileUrl,
	pixeldrainFileUrl,
} from './muhn-pace-sources.js'

export const PIXELDRAIN_SLOW_WARMUP_MS = 8000
export const PIXELDRAIN_SLOW_BYTES_PER_SEC = 500 * 1024

export type PixeldrainDownloadOptions = {
	fileId: string
	destPath: string
	forceBypass?: boolean
	onPreferBypass?: () => void
	warmupMs?: number
	minBytesPerSec?: number
	label?: string
	expectedTotalBytes?: number
	attempt?: number
	maxAttempts?: number
}

export type PixeldrainDownloadResult = {
	host: string
	usedBypass: boolean
	bytesWritten: number
}

export function shouldSwitchToPixeldrainBypass(args: {
	host: string
	preferBypass: boolean
	elapsedMs: number
	bytesInWindow: number
	warmupMs?: number
	minBytesPerSec?: number
}): boolean {
	if (args.host !== 'pixeldrain.com' || args.preferBypass) {
		return false
	}

	const warmupMs = args.warmupMs ?? PIXELDRAIN_SLOW_WARMUP_MS
	const minBytesPerSec = args.minBytesPerSec ?? PIXELDRAIN_SLOW_BYTES_PER_SEC

	if (args.elapsedMs < warmupMs) {
		return false
	}

	const elapsedSec = args.elapsedMs / 1000
	const avgBytesPerSec = args.bytesInWindow / Math.max(elapsedSec, 0.001)
	return avgBytesPerSec < minBytesPerSec
}

function rangeHeader(startByte: number): Record<string, string> | undefined {
	return startByte > 0 ? { Range: `bytes=${startByte}-` } : undefined
}

function shouldFallbackToBypass(error: unknown): boolean {
	if (!axios.isAxiosError(error)) {
		return true
	}

	const status = error.response?.status
	if (status === undefined) {
		return true
	}

	return status === 403 || status === 429 || status >= 500
}

async function writeChunk(
	fileStream: WriteStream,
	chunk: Buffer,
): Promise<void> {
	if (!fileStream.write(chunk)) {
		await new Promise<void>(resolve => fileStream.once('drain', resolve))
	}
}

async function openPixeldrainStream(
	fileId: string,
	startByte: number,
	forceBypass: boolean,
): Promise<{ stream: Readable; host: string; contentLength?: number }> {
	const parseContentLength = (headers: Record<string, unknown>): number | undefined => {
		const raw = headers['content-length']
		if (raw == null) {
			return undefined
		}
		const parsed = Number.parseInt(String(raw), 10)
		return Number.isFinite(parsed) ? parsed : undefined
	}

	if (forceBypass) {
		const response = await axios.get(pixeldrainBypassFileUrl(fileId), {
			responseType: 'stream',
			headers: rangeHeader(startByte),
		})
		return {
			stream: response.data,
			host: 'cdn.pixeldrain.eu.cc',
			contentLength: parseContentLength(response.headers),
		}
	}

	try {
		const response = await axios.get(pixeldrainFileUrl(fileId), {
			responseType: 'stream',
			headers: rangeHeader(startByte),
		})
		return {
			stream: response.data,
			host: 'pixeldrain.com',
			contentLength: parseContentLength(response.headers),
		}
	} catch (error) {
		if (!shouldFallbackToBypass(error)) {
			throw error
		}

		const status = axios.isAxiosError(error)
			? error.response?.status
			: undefined
		Logger.warn(
			`[Muhn Pace] pixeldrain.com unavailable${status ? ` (HTTP ${status})` : ''} — using bypass CDN`,
		)

		const response = await axios.get(pixeldrainBypassFileUrl(fileId), {
			responseType: 'stream',
			headers: rangeHeader(startByte),
		})
		return {
			stream: response.data,
			host: 'cdn.pixeldrain.eu.cc',
			contentLength: parseContentLength(response.headers),
		}
	}
}

export async function downloadPixeldrainFile(
	options: PixeldrainDownloadOptions,
): Promise<PixeldrainDownloadResult> {
	const {
		fileId,
		destPath,
		forceBypass = false,
		onPreferBypass,
		warmupMs = PIXELDRAIN_SLOW_WARMUP_MS,
		minBytesPerSec = PIXELDRAIN_SLOW_BYTES_PER_SEC,
		label,
		expectedTotalBytes,
		attempt,
		maxAttempts,
	} = options

	mkdirSync(dirname(destPath), { recursive: true })

	const progress = label
		? new DownloadProgressTracker({
				label,
				expectedTotalBytes,
				attempt,
				maxAttempts,
			})
		: undefined

	if (expectedTotalBytes) {
		progress?.setTotalBytes(expectedTotalBytes)
	}

	let preferBypass = forceBypass
	let bytesNow = 0
	const downloadStartTime = Date.now()
	let warmupComplete = false
	let measureStartBytes = 0
	let measureStartTime = downloadStartTime

	const applyStreamMetadata = (
		host: string,
		startByte: number,
		contentLength?: number,
	) => {
		progress?.setHost(host)
		if (contentLength != null) {
			progress?.setTotalBytes(startByte + contentLength)
		}
	}

	let { stream, host, contentLength } = await openPixeldrainStream(
		fileId,
		0,
		preferBypass,
	)
	applyStreamMetadata(host, 0, contentLength)
	if (host === 'cdn.pixeldrain.eu.cc') {
		preferBypass = true
		onPreferBypass?.()
	}
	let fileStream = createWriteStream(destPath)

	if (preferBypass) {
		Logger.info(
			'[Muhn Pace] Download source: bypass CDN (album throttled earlier)',
		)
	} else {
		Logger.debug(`[Muhn Pace] Download source: ${host}`)
	}

	progress?.logStarted()

	const switchToBypass = async (reason: string): Promise<void> => {
		stream.destroy()
		fileStream.end()
		await finished(fileStream)
		preferBypass = true
		onPreferBypass?.()
		Logger.warn(`[Muhn Pace] ${reason} — restarting on bypass CDN`)

		fileStream = createWriteStream(destPath)
		bytesNow = 0

		const resumed = await openPixeldrainStream(fileId, 0, true)
		stream = resumed.stream
		host = resumed.host
		applyStreamMetadata(host, 0, resumed.contentLength)
		measureStartBytes = 0
		measureStartTime = Date.now()
		warmupComplete = true
	}

	try {
		while (true) {
			let switched = false

			try {
				for await (const chunk of stream) {
					await writeChunk(fileStream, chunk)
					bytesNow += chunk.length
					progress?.onBytesWritten(bytesNow)

					const now = Date.now()
					if (!warmupComplete) {
						if (now - downloadStartTime < warmupMs) {
							continue
						}
						warmupComplete = true
						measureStartBytes = bytesNow
						measureStartTime = now
					}

					if (
						shouldSwitchToPixeldrainBypass({
							host,
							preferBypass,
							elapsedMs: now - measureStartTime,
							bytesInWindow: bytesNow - measureStartBytes,
							warmupMs: 0,
							minBytesPerSec,
						})
					) {
						const elapsedSec = (now - measureStartTime) / 1000
						const avgBytesPerSec =
							(bytesNow - measureStartBytes) /
							Math.max(elapsedSec, 0.001)
						await switchToBypass(
							`pixeldrain.com slow (${Math.round(avgBytesPerSec / 1024)} KB/s)`,
						)
						switched = true
						break
					}
				}
			} catch (error) {
				if (host === 'pixeldrain.com' && !preferBypass) {
					await switchToBypass('pixeldrain.com connection lost')
					switched = true
				} else {
					throw error
				}
			}

			if (!switched) {
				break
			}
		}
	} finally {
		fileStream.end()
		await finished(fileStream)
	}

	progress?.logCompleted(bytesNow)

	return {
		host,
		usedBypass: preferBypass,
		bytesWritten: bytesNow,
	}
}
