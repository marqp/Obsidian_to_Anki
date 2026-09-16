import type { BenchRepResult } from './bench-harness'

export interface BenchStats {
	count: number
	median: number
	p25: number
	p75: number
	p95: number
	min: number
	max: number
}

export function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) {
		return NaN
	}
	if (sorted.length === 1) {
		return sorted[0]
	}
	const rank = (p / 100) * (sorted.length - 1)
	const low = Math.floor(rank)
	const high = Math.ceil(rank)
	if (low === high) {
		return sorted[low]
	}
	return sorted[low] + (sorted[high] - sorted[low]) * (rank - low)
}

export function summarize(values: number[]): BenchStats {
	const sorted = [...values].sort((a, b) => a - b)
	return {
		count: sorted.length,
		median: percentile(sorted, 50),
		p25: percentile(sorted, 25),
		p75: percentile(sorted, 75),
		p95: percentile(sorted, 95),
		min: sorted[0],
		max: sorted[sorted.length - 1]
	}
}

/**
 * Paired sign test on per-rep medians: for each rep index, compare fork vs
 * upstream totals. Returns wins per side and a two-sided p-value under the
 * null hypothesis of no difference. Non-parametric — no normality assumed.
 */
export function signTest(
	forkTotals: number[],
	upstreamTotals: number[]
): { forkWins: number; upstreamWins: number; ties: number; pValue: number } {
	let forkWins = 0
	let upstreamWins = 0
	let ties = 0
	const n = Math.min(forkTotals.length, upstreamTotals.length)
	for (let i = 0; i < n; i++) {
		if (forkTotals[i] < upstreamTotals[i]) {
			forkWins++
		} else if (forkTotals[i] > upstreamTotals[i]) {
			upstreamWins++
		} else {
			ties++
		}
	}
	const trials = forkWins + upstreamWins
	const k = Math.min(forkWins, upstreamWins)
	let pValue = 1
	if (trials > 0) {
		// Two-sided binomial tail P(X <= k) * 2 for fair coin.
		let tail = 0
		for (let i = 0; i <= k; i++) {
			tail += binomialCoefficient(trials, i) / Math.pow(2, trials)
		}
		pValue = Math.min(1, 2 * tail)
	}
	return { forkWins, upstreamWins, ties, pValue }
}

function binomialCoefficient(n: number, k: number): number {
	if (k < 0 || k > n) {
		return 0
	}
	let result = 1
	const kk = Math.min(k, n - k)
	for (let i = 0; i < kk; i++) {
		result = (result * (n - i)) / (i + 1)
	}
	return result
}

export interface ScenarioReport {
	name: string
	fork: BenchStats
	upstream: BenchStats
	phaseSpeedups: Record<string, number>
	speedup: number
	signTest: { forkWins: number; upstreamWins: number; ties: number; pValue: number }
	cardsPerSecFork: number
	cardsPerSecUpstream: number
	adds: number
	edits: number
	cpuForkMs: number
	cpuUpstreamMs: number
	heapForkKb: number
	heapUpstreamKb: number
	rssForkMb: number
	rssUpstreamMb: number
}

function medianOf(values: number[]): number {
	return summarize(values).median
}

export function buildScenarioReport(scenario: string, reps: BenchRepResult[]): ScenarioReport {
	const fork = reps.filter((r) => r.side === 'fork')
	const upstream = reps.filter((r) => r.side === 'upstream')
	const forkTotals = fork.map((r) => r.phases.total)
	const upstreamTotals = upstream.map((r) => r.phases.total)
	const forkStats = summarize(forkTotals)
	const upstreamStats = summarize(upstreamTotals)
	const phases = ['setupScan', 'scanNotes', 'scanInlineNotes', 'search', 'writeIDs'] as const
	const phaseSpeedups: Record<string, number> = {}
	for (const phase of phases) {
		const f = medianOf(fork.map((r) => r.phases[phase]))
		const u = medianOf(upstream.map((r) => r.phases[phase]))
		phaseSpeedups[phase] = f > 0 ? u / f : NaN
	}
	const cards = Math.max(1, fork[0]?.adds ?? 1)
	return {
		name: scenario,
		fork: forkStats,
		upstream: upstreamStats,
		phaseSpeedups,
		speedup: forkStats.median > 0 ? upstreamStats.median / forkStats.median : NaN,
		signTest: signTest(forkTotals, upstreamTotals),
		cardsPerSecFork: (cards / forkStats.median) * 1000,
		cardsPerSecUpstream: (cards / upstreamStats.median) * 1000,
		adds: fork[0]?.adds ?? 0,
		edits: fork[0]?.edits ?? 0,
		cpuForkMs: medianOf(fork.map((r) => (r.cpuUserUs + r.cpuSystemUs) / 1000)),
		cpuUpstreamMs: medianOf(upstream.map((r) => (r.cpuUserUs + r.cpuSystemUs) / 1000)),
		heapForkKb: medianOf(fork.map((r) => r.heapDelta / 1024)),
		heapUpstreamKb: medianOf(upstream.map((r) => r.heapDelta / 1024)),
		rssForkMb: medianOf(fork.map((r) => r.rssPeak / 1024 / 1024)),
		rssUpstreamMb: medianOf(upstream.map((r) => r.rssPeak / 1024 / 1024))
	}
}

function fmtMs(value: number): string {
	return `${value.toFixed(3)} ms`
}

function fmtSpeedup(value: number): string {
	if (!Number.isFinite(value)) {
		return 'n/a'
	}
	return `${value.toFixed(2)}x`
}

function verdictFor(report: ScenarioReport): string {
	const { pValue, forkWins, upstreamWins } = report.signTest
	if (pValue >= 0.05) {
		return 'empate estatístico (p ≥ 0.05)'
	}
	if (forkWins === upstreamWins) {
		return 'diferença significativa mas equilibrada (investigar dispersão)'
	}
	if (report.speedup >= 1.05 && forkWins > upstreamWins) {
		return `fork mais rápido (${fmtSpeedup(report.speedup)})`
	}
	if (report.speedup <= 0.95 && upstreamWins > forkWins) {
		return `upstream mais rápido (${fmtSpeedup(1 / report.speedup)})`
	}
	return 'diferença significativa mas < 5% (irrelevante na prática)'
}

/**
 * Full Markdown report: executive table, per-phase table, resources,
 * linearity, sanity gate, limits, reproduction. Printed to console and
 * returned for file output.
 */
export function renderBenchReport(
	reports: ScenarioReport[],
	meta: { node: string; platform: string; pinnedSha: string; date: string; sanity: string }
): string {
	const lines: string[] = []
	lines.push('# Relatório de benchmark: fork vs upstream (motor de parse)')
	lines.push('')
	lines.push(`- Data: ${meta.date}`)
	lines.push(`- Node: ${meta.node} · Plataforma: ${meta.platform}`)
	lines.push(`- Upstream pinado: \`${meta.pinnedSha}\` (verificado contra worktree)`)
	lines.push('- Método: bundles isolados do harness de paridade, `obsidian` mockado, `findNotes` stubado.')
	lines.push('- Sem Obsidian, sem Anki, sem rede. Medição externa via `hrtime.bigint()` por fase.')
	lines.push(`- Sanity gate: ${meta.sanity}`)
	lines.push('')
	lines.push('## 1. Resumo executivo (mediana do total por cenário)')
	lines.push('')
	lines.push('| Cenário | Fork (mediana) | Upstream (mediana) | Speedup (up/fork) | Sinal (fork×up, p) | Veredito |')
	lines.push('|---|---|---|---|---|---|')
	for (const r of reports) {
		lines.push(
			`| ${r.name} | ${fmtMs(r.fork.median)} | ${fmtMs(r.upstream.median)} | ${fmtSpeedup(r.speedup)} | ` +
				`${r.signTest.forkWins}×${r.signTest.upstreamWins} (p=${r.signTest.pValue.toFixed(4)}) | ${verdictFor(r)} |`
		)
	}
	lines.push('')
	lines.push('## 2. Por fase (speedup = upstream/fork; > 1 favorece o fork)')
	lines.push('')
	lines.push('| Cenário | setupScan | scanNotes | scanInline | search | writeIDs |')
	lines.push('|---|---|---|---|---|---|')
	for (const r of reports) {
		lines.push(
			`| ${r.name} | ${fmtSpeedup(r.phaseSpeedups.setupScan)} | ${fmtSpeedup(r.phaseSpeedups.scanNotes)} | ` +
				`${fmtSpeedup(r.phaseSpeedups.scanInlineNotes)} | ${fmtSpeedup(r.phaseSpeedups.search)} | ` +
				`${fmtSpeedup(r.phaseSpeedups.writeIDs)} |`
		)
	}
	lines.push('')
	lines.push('## 3. Throughput e dispersão')
	lines.push('')
	lines.push('| Cenário | Cards | Fork cards/s | Upstream cards/s | Fork p25–p75 | Upstream p25–p75 |')
	lines.push('|---|---|---|---|---|---|')
	for (const r of reports) {
		lines.push(
			`| ${r.name} | ${r.adds + r.edits} | ${r.cardsPerSecFork.toFixed(0)} | ${r.cardsPerSecUpstream.toFixed(0)} | ` +
				`${r.fork.p25.toFixed(2)}–${r.fork.p75.toFixed(2)} ms | ${r.upstream.p25.toFixed(2)}–${r.upstream.p75.toFixed(2)} ms |`
		)
	}
	lines.push('')
	lines.push('## 4. Recursos (mediana por repetição)')
	lines.push('')
	lines.push('| Cenário | CPU fork | CPU upstream | HeapΔ fork | HeapΔ upstream | RSS fork | RSS upstream |')
	lines.push('|---|---|---|---|---|---|---|')
	for (const r of reports) {
		lines.push(
			`| ${r.name} | ${r.cpuForkMs.toFixed(2)} ms | ${r.cpuUpstreamMs.toFixed(2)} ms | ` +
				`${r.heapForkKb.toFixed(1)} KB | ${r.heapUpstreamKb.toFixed(1)} KB | ` +
				`${r.rssForkMb.toFixed(1)} MB | ${r.rssUpstreamMb.toFixed(1)} MB |`
		)
	}
	lines.push('')
	const linear = reports.filter((r) => r.name.startsWith('linear-'))
	if (linear.length >= 2) {
		lines.push('## 5. Linearidade (ms por bloco)')
		lines.push('')
		lines.push('| Lado | x1 (500) | x2 (1000) | x4 (2000) | ms/bloco x1 | ms/bloco x4 |')
		lines.push('|---|---|---|---|---|---|')
		for (const side of ['fork', 'upstream'] as const) {
			const cells = linear.map((r) => {
				const stats = side === 'fork' ? r.fork : r.upstream
				return fmtMs(stats.median)
			})
			const blocks = [500, 1000, 2000]
			const perBlock = linear.map((r, i) => {
				const stats = side === 'fork' ? r.fork : r.upstream
				return (stats.median / blocks[Math.min(i, blocks.length - 1)]).toFixed(4)
			})
			lines.push(`| ${side} | ${cells.join(' | ')} | ${perBlock[0]} | ${perBlock[perBlock.length - 1]} |`)
		}
		lines.push('')
	}
	lines.push('## 6. Limites (ler antes de citar qualquer número)')
	lines.push('')
	lines.push('- Motor isolado ≠ scan real: sem I/O de vault, sem AnkiConnect, sem `mapConcurrent`.')
	lines.push('- `isStatUnchanged`/`mapConcurrent(8)` (ganhos de I/O) NÃO são medidos aqui.')
	lines.push('- Heap/RSS são do processo Node do bench, não do Obsidian.')
	lines.push('- Formatos de log nunca foram comparados — só durações.')
	lines.push('- Reps intercaladas A/B/A/B + mediana/IQR mitigam drift da máquina; dispersão publicada acima.')
	lines.push('')
	lines.push('## 7. Reprodução')
	lines.push('')
	lines.push('```bash')
	lines.push('pnpm run test:bench            # bench completo (~2–5 min)')
	lines.push('pnpm run test:bench -- --verbose  # log por repetição [BENCH]')
	lines.push('```')
	lines.push('')
	lines.push('- Resultados brutos: `tests/parity/.bench-results.json` (gitignored).')
	lines.push('- Seed de IDs: 900001. Ordem intercalada, warmup descartado, `gc()` entre reps (`--expose-gc`).')
	return lines.join('\n')
}
