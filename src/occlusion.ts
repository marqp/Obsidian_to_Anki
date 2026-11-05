/**
 * Reads the masks of Anki's native Image Occlusion notes, which are text inside
 * the `Occlusion` field: `{{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.1:oi=1}}`.
 * Pure, so what the scan refuses and what the API compares can be tested alike.
 */

const MASK_REGEXP = /{{c(\d+)::image-occlusion:([\s\S]+?)}}/g
const IMAGE_REGEXP = /<img\b|!\[\[/
/** Masks drawn by hand can pass the edge of the image by a hair. */
const EDGE_TOLERANCE = 0.01
/**
 * Saving in Anki's editor snaps every mask, moved or not: up to .0008 on a
 * 1074x1334 image. A smaller image snaps further, so this leaves room. A real
 * move of less than this cannot be told apart and stays unreported.
 */
const SAME_PLACE_TOLERANCE = 0.005

const REQUIRED_PROPERTIES: Record<string, string[]> = {
	rect: ['left', 'top', 'width', 'height'],
	ellipse: ['left', 'top', 'rx', 'ry'],
	polygon: ['points']
}

interface Mask {
	card: number
	shape: string
	properties: Map<string, string>
}

function parseMask(card: string, body: string): Mask {
	const [shape, ...parts] = body.split(':')
	const properties = new Map<string, string>()
	for (const part of parts) {
		const separator = part.indexOf('=')
		if (separator > 0) {
			properties.set(part.slice(0, separator), part.slice(separator + 1))
		}
	}
	return { card: parseInt(card, 10), shape, properties }
}

function masksIn(text: string): Mask[] {
	return Array.from(text.matchAll(MASK_REGEXP), (match) => parseMask(match[1], match[2]))
}

function numberAt(mask: Mask, name: string): number {
	return Number(mask.properties.get(name) ?? Number.NaN)
}

function polygonPoints(points: string): number[][] {
	return points
		.trim()
		.split(/\s+/)
		.map((point) => point.split(',').map(Number))
}

/** [left, top, right, bottom] of a shape this module knows, or null if its numbers do not add up. */
function bounds(mask: Mask): number[] | null {
	let box: number[]
	if (mask.shape === 'polygon') {
		const points = polygonPoints(mask.properties.get('points') ?? '')
		if (points.length < 3 || points.some((point) => point.length !== 2)) {
			return null
		}
		const xs = points.map((point) => point[0])
		const ys = points.map((point) => point[1])
		box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
	} else {
		const left = numberAt(mask, 'left')
		const top = numberAt(mask, 'top')
		const width = mask.shape === 'rect' ? numberAt(mask, 'width') : 2 * numberAt(mask, 'rx')
		const height = mask.shape === 'rect' ? numberAt(mask, 'height') : 2 * numberAt(mask, 'ry')
		if (width <= 0 || height <= 0) {
			return null
		}
		box = [left, top, left + width, top + height]
	}
	return box.every(Number.isFinite) ? box : null
}

function maskProblem(mask: Mask): string | undefined {
	const required = REQUIRED_PROPERTIES[mask.shape]
	// Anki also has text shapes, whose values this module cannot judge.
	if (required === undefined) {
		return undefined
	}
	const missing = required.filter((name) => !mask.properties.has(name))
	if (missing.length > 0) {
		return `c${mask.card} ${mask.shape} has no ${missing.join(', ')}`
	}
	const box = bounds(mask)
	if (box === null) {
		return `c${mask.card} ${mask.shape} has invalid numbers`
	}
	const [left, top, right, bottom] = box
	if (left < -EDGE_TOLERANCE || top < -EDGE_TOLERANCE || right > 1 + EDGE_TOLERANCE || bottom > 1 + EDGE_TOLERANCE) {
		return `c${mask.card} ${mask.shape} leaves the image: positions go from 0 to 1`
	}
	return undefined
}

/** Why this note cannot become a working occlusion, or undefined if it can. */
export function occlusionProblem(fields: string[]): string | undefined {
	const masks = fields.flatMap(masksIn)
	if (masks.length === 0) {
		return 'at least one {{cN::image-occlusion:...}} mask is required'
	}
	if (!fields.some((field) => IMAGE_REGEXP.test(field))) {
		return 'an image is required'
	}
	for (const mask of masks) {
		const problem = maskProblem(mask)
		if (problem !== undefined) {
			return problem
		}
	}
	return undefined
}

function canonicalValue(value: string): string {
	const number = Number(value)
	return value.trim() !== '' && Number.isFinite(number) ? String(number) : value
}

function canonicalMask(mask: Mask): string {
	const properties = [...mask.properties.entries()]
		.map(([name, value]) => {
			const canonical =
				name === 'points'
					? polygonPoints(value)
							.map((point) => point.map(String).join(','))
							.join(' ')
					: canonicalValue(value)
			return `${name}=${canonical}`
		})
		.sort()
	return `c${mask.card}:${mask.shape}:${properties.join(':')}`
}

/** Each mask once, however its numbers are spelled or ordered, so `.1` and `0.1` compare equal. */
export function canonicalMasks(field: string): string[] {
	return uniqueMasks(field).map(canonicalMask).sort()
}

function uniqueMasks(field: string): Mask[] {
	return [...new Map(masksIn(field).map((mask) => [canonicalMask(mask), mask])).values()]
}

function closeValues(name: string, first: string, second: string): boolean {
	if (first === second) {
		return true
	}
	if (name === 'points') {
		const a = polygonPoints(first)
		const b = polygonPoints(second)
		return (
			a.length === b.length &&
			a.every(
				(point, index) =>
					point.length === b[index].length &&
					point.every((value, axis) => Math.abs(value - b[index][axis]) <= SAME_PLACE_TOLERANCE)
			)
		)
	}
	return (
		first.trim() !== '' && second.trim() !== '' && Math.abs(Number(first) - Number(second)) <= SAME_PLACE_TOLERANCE
	)
}

function samePlace(first: Mask, second: Mask): boolean {
	return (
		first.card === second.card &&
		first.shape === second.shape &&
		first.properties.size === second.properties.size &&
		[...first.properties].every(
			([name, value]) =>
				second.properties.has(name) && closeValues(name, value, second.properties.get(name) as string)
		)
	)
}

/** Masks of each field with no counterpart in the other, ignoring the rounding of Anki's editor. */
export function maskDifferences(first: string, second: string): { onlyInFirst: string[]; onlyInSecond: string[] } {
	const unmatched = uniqueMasks(second)
	const onlyInFirst: Mask[] = []
	for (const mask of uniqueMasks(first)) {
		const index = unmatched.findIndex((other) => samePlace(mask, other))
		if (index === -1) {
			onlyInFirst.push(mask)
		} else {
			unmatched.splice(index, 1)
		}
	}
	return { onlyInFirst: onlyInFirst.map(canonicalMask).sort(), onlyInSecond: unmatched.map(canonicalMask).sort() }
}
