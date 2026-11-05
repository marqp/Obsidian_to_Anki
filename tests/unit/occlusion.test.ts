import { describe, it, expect } from 'vitest'
import { canonicalMasks, maskDifferences, occlusionProblem } from '../../src/occlusion'

const IMAGE = '<img src="a.png">'
const rect = (body: string, card = 1): string => `{{c${card}::image-occlusion:rect:${body}}}`

describe('occlusionProblem', () => {
	it('accepts each shape Anki draws', () => {
		const masks = [
			rect('left=.1:top=.2:width=.3:height=.1:oi=1'),
			'{{c2::image-occlusion:ellipse:left=.1:top=.2:rx=.1:ry=.05}}',
			'{{c3::image-occlusion:polygon:left=.1:top=.2:points=.1,.2 .3,.2 .3,.4:oi=1}}'
		].join('<br />\n')

		expect(occlusionProblem([masks, IMAGE])).toBeUndefined()
	})

	it('accepts an embed, because validation has no metadata cache to turn it into an image', () => {
		expect(occlusionProblem([rect('left=.1:top=.2:width=.3:height=.1'), '![[a.png]]'])).toBeUndefined()
	})

	it('leaves text shapes alone, since their values are free text', () => {
		expect(occlusionProblem(['{{c1::image-occlusion:text:left=.1:top=.2:text=abc}}', IMAGE])).toBeUndefined()
	})

	it('tolerates a mask drawn slightly past the edge, as real notes have', () => {
		expect(occlusionProblem([rect('left=.8:top=.2:width=.2027:height=.1'), IMAGE])).toBeUndefined()
	})

	it.each([
		['no mask at all', ['{{c1::text}}', IMAGE], 'at least one'],
		['no image', [rect('left=.1:top=.2:width=.3:height=.1'), 'header'], 'an image is required'],
		['a missing property', [rect('left=.1:top=.2:width=.3'), IMAGE], 'c1 rect has no height'],
		['a value that is not a number', [rect('left=a:top=.2:width=.3:height=.1'), IMAGE], 'invalid numbers'],
		['no size', [rect('left=.1:top=.2:width=0:height=.1'), IMAGE], 'invalid numbers'],
		['pixels instead of fractions', [rect('left=120:top=80:width=40:height=20'), IMAGE], 'leaves the image'],
		['a position past the left edge', [rect('left=-.2:top=.2:width=.1:height=.1'), IMAGE], 'leaves the image'],
		[
			'a polygon of two points',
			['{{c2::image-occlusion:polygon:left=.1:top=.2:points=.1,.2 .3,.2}}', IMAGE],
			'c2 polygon has invalid'
		],
		[
			'a polygon with no points',
			['{{c1::image-occlusion:polygon:left=.1:top=.2}}', IMAGE],
			'c1 polygon has no points'
		],
		['an ellipse with no size', ['{{c1::image-occlusion:ellipse:left=.1:top=.2:rx=0:ry=.1}}', IMAGE], 'invalid']
	])('reports %s', (_case, fields, reason) => {
		expect(occlusionProblem(fields)).toContain(reason)
	})

	it('names the first bad mask when others are fine', () => {
		const masks = `${rect('left=.1:top=.2:width=.1:height=.1')}${rect('left=.9:top=.2:width=.5:height=.1', 4)}`

		expect(occlusionProblem([masks, IMAGE])).toContain('c4')
	})
})

describe('canonicalMasks', () => {
	it('ignores how the numbers are spelled, the order of properties and of masks', () => {
		const a = `${rect('left=.1:top=.2:width=.3:height=.1')}<br>${rect('left=.5:top=.5:width=.1:height=.1', 2)}`
		const b = `${rect('left=.5:top=.5:width=.1:height=.1', 2)}\n${rect('height=0.10:width=0.30:top=0.2:left=0.1')}`

		expect(canonicalMasks(a)).toEqual(canonicalMasks(b))
	})

	it('reads polygon points as numbers too', () => {
		expect(canonicalMasks('{{c1::image-occlusion:polygon:points=.1,.2 .3,.2 .3,.4}}')).toEqual(
			canonicalMasks('{{c1::image-occlusion:polygon:points=0.1,0.2  0.3,0.2 0.30,0.4}}')
		)
	})

	it.each([
		['another card', rect('left=.1:top=.2:width=.3:height=.1', 2)],
		['another position', rect('left=.2:top=.2:width=.3:height=.1')],
		['another mode', rect('left=.1:top=.2:width=.3:height=.1:oi=1')]
	])('tells apart %s', (_case, other) => {
		expect(canonicalMasks(other)).not.toEqual(canonicalMasks(rect('left=.1:top=.2:width=.3:height=.1')))
	})

	it('reads nothing from text without masks', () => {
		expect(canonicalMasks('{{c1::text}} and <br>')).toEqual([])
	})
})

describe('maskDifferences', () => {
	const none = { onlyInFirst: [], onlyInSecond: [] }

	it('ignores what saving in the editor does to masks nobody moved', () => {
		const file = `${rect('left=.0795:top=.0048:width=.1869:height=.0275')}\n${rect('left=.7611:top=.7878:width=.2153:height=.0231', 2)}`
		const saved = `${rect('left=.7616:top=.7878:width=.2157:height=.0231', 2)}<br>${rect('left=.0792:top=.0054:width=.187:height=.0271')}<br>`

		expect(maskDifferences(saved, file)).toEqual(none)
	})

	it('names only the mask that moved', () => {
		const file = `${rect('left=.02:top=.06:width=.28:height=.0275')}\n${rect('left=.5:top=.5:width=.1:height=.1', 2)}`
		const saved = `${rect('left=.2529:top=.0515:width=.2797:height=.0271')}<br>${rect('left=.5004:top=.5:width=.1:height=.1', 2)}`

		expect(maskDifferences(saved, file)).toEqual({
			onlyInFirst: ['c1:rect:height=0.0271:left=0.2529:top=0.0515:width=0.2797'],
			onlyInSecond: ['c1:rect:height=0.0275:left=0.02:top=0.06:width=0.28']
		})
	})

	it('pairs the masks of one card one to one', () => {
		const one = rect('left=.1:top=.1:width=.1:height=.1')
		const other = rect('left=.5:top=.5:width=.1:height=.1')
		const moved = rect('left=.7:top=.5:width=.1:height=.1')

		expect(maskDifferences(`${one}${moved}`, `${one}${other}`)).toEqual({
			onlyInFirst: ['c1:rect:height=0.1:left=0.7:top=0.5:width=0.1'],
			onlyInSecond: ['c1:rect:height=0.1:left=0.5:top=0.5:width=0.1']
		})
	})

	it('reads polygon points with the same tolerance', () => {
		const polygon = (points: string): string => `{{c1::image-occlusion:polygon:points=${points}}}`

		expect(maskDifferences(polygon('.1,.2 .3,.2 .3,.4'), polygon('.101,.2 .3,.199 .3,.4'))).toEqual(none)
		expect(maskDifferences(polygon('.1,.2 .3,.2 .3,.4'), polygon('.2,.2 .3,.2 .3,.4')).onlyInFirst).toHaveLength(1)
		expect(
			maskDifferences(polygon('.1,.2 .3,.2 .3,.4'), polygon('.1,.2 .3,.2 .3,.4 .1,.4')).onlyInFirst
		).toHaveLength(1)
	})

	it.each([
		['a move past the rounding', rect('left=.106:top=.2:width=.3:height=.1')],
		['another card', rect('left=.1:top=.2:width=.3:height=.1', 2)],
		['another mode', rect('left=.1:top=.2:width=.3:height=.1:oi=1')],
		['another shape', '{{c1::image-occlusion:ellipse:left=.1:top=.2:width=.3:height=.1}}'],
		['another text', '{{c1::image-occlusion:text:left=.1:top=.2:width=.3:height=b}}']
	])('tells apart %s', (_case, other) => {
		expect(maskDifferences(other, rect('left=.1:top=.2:width=.3:height=.1')).onlyInFirst).toHaveLength(1)
	})

	it('compares text values that are not numbers', () => {
		const text = '{{c1::image-occlusion:text:left=.1:top=.2:text=nome}}'

		expect(maskDifferences(text, text)).toEqual(none)
		expect(maskDifferences(text, text.replace('nome', 'outro')).onlyInFirst).toHaveLength(1)
	})
})
