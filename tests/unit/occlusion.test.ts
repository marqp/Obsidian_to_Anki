import { describe, it, expect } from 'vitest'
import { canonicalMasks, occlusionProblem } from '../../src/occlusion'

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
		['a polygon with no points', ['{{c1::image-occlusion:polygon:left=.1:top=.2}}', IMAGE], 'c1 polygon has no points'],
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
