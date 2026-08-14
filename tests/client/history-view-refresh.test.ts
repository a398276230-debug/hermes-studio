import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('packages/client/src/views/hermes/HistoryView.vue', 'utf8')

describe('HistoryView refresh controls', () => {
  it('places the manual refresh control immediately before the outline control', () => {
    const refreshButton = source.indexOf('@click="refreshHistorySessions"')
    const outlineButton = source.indexOf('@click="showOutline = !showOutline"')

    expect(refreshButton).toBeGreaterThanOrEqual(0)
    expect(outlineButton).toBeGreaterThan(refreshButton)
    expect(source.slice(refreshButton, outlineButton)).toContain("t('common.refresh')")
  })

  it('refreshes visible history every ten seconds without overlapping requests', () => {
    expect(source).toContain('if (historyRefreshing.value || hermesSessionsLoading.value) return')
    expect(source).toContain('historyRefreshTimer = window.setInterval(() => {')
    expect(source).toMatch(/void refreshHistorySessionsIfVisible\(\)\r?\n\s*}, 10_000\)/)
    expect(source).toContain("document.visibilityState !== 'visible'")
  })

  it('refreshes after returning to the page and cleans up listeners and timers', () => {
    expect(source).toContain("document.addEventListener('visibilitychange', handleHistoryVisibilityChange)")
    expect(source).toContain("document.removeEventListener('visibilitychange', handleHistoryVisibilityChange)")
    expect(source).toContain('clearInterval(historyRefreshTimer)')
  })
})
