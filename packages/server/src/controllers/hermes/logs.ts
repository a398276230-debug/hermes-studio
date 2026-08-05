import { existsSync, statSync, readdirSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import axios from 'axios'
import * as hermesCli from '../../services/hermes/hermes-cli'
import { config } from '../../config'
import {
  EKKO_LOG_FILE_NAME,
  EkkoDirectoryManager,
  EkkoFileLogReader,
  type EkkoLogLevel,
  type EkkoLogRecord,
} from '../../../../ekko-agent/src'

const WEBUI_LOG_FILE = join(config.appHome, 'logs', 'server.log')
const BRIDGE_LOG_FILE = join(config.appHome, 'logs', 'bridge.log')

// ─── External log sources ─────────────────────────────────────
const NAPCAT_LOG_DIR = 'D:\\NapCat.Shell\\logs'
const EXTERNAL_BRIDGE_LOG_FILE = 'F:\\hermescache\\hermes-workspace\\sideria_bridge_full_pack\\bridge.log'
const CONTEXTX_HEALTH_URL = 'http://127.0.0.1:8656/health'
const CONTEXTX_MCP_URL = 'http://127.0.0.1:8656/mcp'

interface LogEntry {
  timestamp: string; level: string; logger: string; message: string; raw: string
}

function appendPinoContext(message: string, obj: any): string {
  const parts: string[] = []
  const runtime = obj.runtime && typeof obj.runtime === 'object' ? obj.runtime : null
  if (runtime) {
    if (runtime.profile) parts.push(`profile=${runtime.profile}`)
    if (runtime.cwd) parts.push(`cwd=${runtime.cwd}`)
    if (runtime.profile_dir) parts.push(`profile_dir=${runtime.profile_dir}`)
    if (runtime.config_path) parts.push(`config=${runtime.config_path}`)
  } else if (obj.profile) {
    parts.push(`profile=${obj.profile}`)
  }
  if (obj.request?.action) parts.push(`action=${obj.request.action}`)
  if (obj.err?.message) parts.push(`error=${obj.err.message}`)
  if (obj.sessionId) parts.push(`session=${obj.sessionId}`)
  if (obj.runId) parts.push(`run=${obj.runId}`)
  if (obj.status) parts.push(`status=${obj.status}`)
  return parts.length > 0 ? `${message} ${parts.join(' ')}` : message
}

function parseLine(line: string): LogEntry {
  try {
    const obj = JSON.parse(line)
    if (obj.level && obj.time) {
      const ts = new Date(obj.time).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
      const levelMap: Record<number, string> = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' }
      // Pino 日志格式: { level, time, msg, name (logger name), hostname, pid, ... }
      const loggerName = obj.name || obj.logger || 'app'
      const message = obj.msg || (obj.err ? obj.err.message : '')
      const baseMessage = typeof message === 'string' ? message : JSON.stringify(message)
      return { timestamp: ts, level: levelMap[obj.level] || 'INFO', logger: loggerName, message: appendPinoContext(baseMessage, obj), raw: line }
    }
  } catch {}
  let match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3})\s+(DEBUG|INFO|WARNING|ERROR|CRITICAL)\s+(\S+?):\s(.*)$/)
  if (match) { return { timestamp: match[1], level: match[2], logger: match[3], message: match[4], raw: line } }
  match = line.match(/^\[(\S+?)\]\s+\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3})\]\s+\[(DEBUG|INFO|WARNING|ERROR|CRITICAL)\]\s(.*)$/)
  if (match) { return { timestamp: match[2], level: match[3], logger: match[1], message: match[4], raw: line } }
  return { timestamp: '', level: '', logger: '', message: line, raw: line }
}

function requestedProfile(ctx: any): string {
  return String(ctx.state?.profile?.name || ctx.query?.profile || 'default').trim() || 'default'
}

function ekkoLogReaderForProfile(profile: string): EkkoFileLogReader | null {
  try {
    const directories = new EkkoDirectoryManager(config.appHome)
    const directory = directories.profileLogsPath(profile)
    const filePath = join(directory, EKKO_LOG_FILE_NAME)
    return existsSync(filePath) ? new EkkoFileLogReader({ directory }) : null
  } catch {
    return null
  }
}

function displaySize(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${(bytes / 1024).toFixed(1)}KB`
}

// ─── NapCat log parsing ───────────────────────────────────────
// NapCat log format: "08-05 23:35:55 [info] fuaji | message..."
function parseNapCatLine(line: string): LogEntry {
  const match = line.match(/^(\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+\[(\w+)\]\s+(\S+)\s+\|\s(.*)$/)
  if (match) {
    const levelMap: Record<string, string> = {
      info: 'INFO', debug: 'DEBUG', warn: 'WARNING', warning: 'WARNING',
      error: 'ERROR', fatal: 'ERROR', trace: 'TRACE',
    }
    return {
      timestamp: match[1],
      level: levelMap[match[2].toLowerCase()] || match[2].toUpperCase(),
      logger: match[3],
      message: match[4],
      raw: line,
    }
  }
  // Continuation lines (indented or JSON blobs) get appended as raw message
  return { timestamp: '', level: '', logger: '', message: line, raw: line }
}

// ─── NapCat directory listing ─────────────────────────────────
function listNapCatLogFiles(): { name: string; size: string; modified: string }[] {
  try {
    if (!existsSync(NAPCAT_LOG_DIR)) return []
    const entries = readdirSync(NAPCAT_LOG_DIR)
      .filter(f => f.endsWith('.log'))
      .map(f => {
        const fullPath = join(NAPCAT_LOG_DIR, f)
        try {
          const stat = statSync(fullPath)
          return { filename: f, fullPath, mtime: stat.mtime, size: stat.size }
        } catch {
          return null
        }
      })
      .filter((e): e is { filename: string; fullPath: string; mtime: Date; size: number } => e !== null)
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
      .slice(0, 5) // latest 5 files

    return entries.map(e => ({
      name: `napcat:${e.filename}`,
      size: displaySize(e.size),
      modified: e.mtime.toLocaleString(),
    }))
  } catch {
    return []
  }
}

// ─── ContextX health check ────────────────────────────────────
async function fetchContextXStatus(): Promise<{ online: boolean; serverInfo?: string; tools?: string[]; error?: string }> {
  try {
    const res = await axios.get(CONTEXTX_HEALTH_URL, {
      timeout: 3000,
      proxy: false, // bypass proxy for localhost
      validateStatus: () => true,
    })
    if (res.status === 200 && res.data === 'ok') {
      // Try to get MCP server info via initialize
      try {
        const mcpRes = await axios.post(CONTEXTX_MCP_URL,
          { jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'hermes-studio', version: '1.0' } }, id: 0 },
          {
            timeout: 3000,
            proxy: false,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            validateStatus: () => true,
          },
        )
        // Parse SSE response
        const mcpText = typeof mcpRes.data === 'string' ? mcpRes.data : JSON.stringify(mcpRes.data)
        const dataMatch = mcpText.match(/data:\s*({.*})/)
        if (dataMatch) {
          const mcpData = JSON.parse(dataMatch[1])
          const serverInfo = mcpData.result?.serverInfo
          const infoStr = serverInfo
            ? `${serverInfo.name} v${serverInfo.version}${serverInfo.title ? ` (${serverInfo.title})` : ''}`
            : 'contextX'
          return { online: true, serverInfo: infoStr, tools: ['grok_search', 'grok_deep_search'] }
        }
      } catch {}
      return { online: true, serverInfo: 'contextX', tools: ['grok_search', 'grok_deep_search'] }
    }
    return { online: false, error: `Health check returned ${res.status}` }
  } catch (err: any) {
    return { online: false, error: err.code || err.message }
  }
}

function ekkoLogEntry(record: EkkoLogRecord): LogEntry {
  const timestamp = new Date(record.timestamp).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
  const level = record.level === 'warn' ? 'WARNING' : record.level.toUpperCase()
  const context = [
    record.sessionId ? `session=${record.sessionId}` : '',
    record.runId ? `run=${record.runId}` : '',
    record.turnId ? `turn=${record.turnId}` : '',
  ].filter(Boolean)
  const data = record.data === undefined ? '' : ` ${JSON.stringify(record.data)}`
  const message = `${record.event}${context.length ? ` ${context.join(' ')}` : ''}${data}`
  return {
    timestamp,
    level,
    logger: `ekko-agent/${record.category}`,
    message,
    raw: JSON.stringify(record),
  }
}

export async function list(ctx: any) {
  const files = await hermesCli.listLogFiles()
  if (existsSync(WEBUI_LOG_FILE)) {
    try {
      const stat = statSync(WEBUI_LOG_FILE)
      const size = stat.size > 1024 * 1024 ? `${(stat.size / 1024 / 1024).toFixed(1)}MB` : `${(stat.size / 1024).toFixed(1)}KB`
      const modified = stat.mtime.toLocaleString()
      files.push({ name: 'webui', size, modified })
    } catch { }
  }
  if (existsSync(BRIDGE_LOG_FILE)) {
    try {
      const stat = statSync(BRIDGE_LOG_FILE)
      const size = stat.size > 1024 * 1024 ? `${(stat.size / 1024 / 1024).toFixed(1)}MB` : `${(stat.size / 1024).toFixed(1)}KB`
      const modified = stat.mtime.toLocaleString()
      files.push({ name: 'bridge', size, modified })
    } catch { }
  }
  const ekkoReader = ekkoLogReaderForProfile(requestedProfile(ctx))
  if (ekkoReader && existsSync(ekkoReader.filePath)) {
    try {
      const stat = statSync(ekkoReader.filePath)
      files.push({ name: 'ekko-agent', size: displaySize(stat.size), modified: stat.mtime.toLocaleString() })
    } catch { }
  }

  // ─── External log sources ─────────────────────────────────────
  // NapCat QQ logs: list latest 5 files
  for (const f of listNapCatLogFiles()) {
    files.push(f)
  }

  // External bridge log (sideria_bridge_full_pack)
  if (existsSync(EXTERNAL_BRIDGE_LOG_FILE)) {
    try {
      const stat = statSync(EXTERNAL_BRIDGE_LOG_FILE)
      files.push({ name: 'qq-bridge', size: displaySize(stat.size), modified: stat.mtime.toLocaleString() })
    } catch { }
  }

  // ContextX status (always listed, shown as online/offline)
  files.push({ name: 'contextx', size: '—', modified: '—' })

  ctx.body = { files }
}

export async function read(ctx: any) {
  const logName = ctx.params.name
  const lines = ctx.query.lines ? parseInt(ctx.query.lines as string, 10) : 100
  const level = (ctx.query.level as string) || undefined
  const session = (ctx.query.session as string) || undefined
  const since = (ctx.query.since as string) || undefined

  if (logName === 'ekko-agent') {
    try {
      const ekkoReader = ekkoLogReaderForProfile(requestedProfile(ctx))
      if (!ekkoReader) { ctx.body = { entries: [] }; return }
      const normalizedLevel = String(level || '').toLowerCase()
      const records = ekkoReader.query({
        sessionId: session,
        runId: (ctx.query.run as string) || undefined,
        category: (ctx.query.category as any) || undefined,
        level: (['debug', 'info', 'warn', 'error'].includes(normalizedLevel)
          ? normalizedLevel
          : normalizedLevel === 'warning'
            ? 'warn'
            : undefined) as EkkoLogLevel | undefined,
        event: (ctx.query.event as string) || undefined,
        text: (ctx.query.text as string) || undefined,
        after: since,
        limit: Number.isFinite(lines) && lines > 0 ? lines : 100,
      })
      ctx.body = { entries: records.map(ekkoLogEntry).reverse() }
    } catch (err: any) {
      ctx.status = 500; ctx.body = { error: err.message }
    }
    return
  }

  if (logName === 'webui') {
    try {
      if (!existsSync(WEBUI_LOG_FILE)) { ctx.body = { entries: [] }; return }
      const content = await readFile(WEBUI_LOG_FILE, 'utf-8')
      const rawLines = content.split('\n')
      const sliced = rawLines.length > lines ? rawLines.slice(-lines) : rawLines
      const entries: LogEntry[] = []
      for (const line of sliced) { if (!line.trim()) continue; entries.push(parseLine(line)) }
      ctx.body = { entries: entries.reverse() }
    } catch (err: any) {
      ctx.status = 500; ctx.body = { error: err.message }
    }
    return
  }

  if (logName === 'bridge') {
    try {
      if (!existsSync(BRIDGE_LOG_FILE)) { ctx.body = { entries: [] }; return }
      const content = await readFile(BRIDGE_LOG_FILE, 'utf-8')
      const rawLines = content.split('\n')
      const sliced = rawLines.length > lines ? rawLines.slice(-lines) : rawLines
      const entries: LogEntry[] = []
      for (const line of sliced) { if (!line.trim()) continue; entries.push(parseLine(line)) }
      ctx.body = { entries: entries.reverse() }
    } catch (err: any) {
      ctx.status = 500; ctx.body = { error: err.message }
    }
    return
  }

  // ─── NapCat QQ logs (napcat:filename) ─────────────────────────
  if (logName.startsWith('napcat:')) {
    try {
      const filename = logName.substring('napcat:'.length)
      const filePath = join(NAPCAT_LOG_DIR, filename)
      if (!existsSync(filePath)) { ctx.body = { entries: [] }; return }
      const content = await readFile(filePath, 'utf-8')
      const rawLines = content.split('\n')
      const sliced = rawLines.length > lines ? rawLines.slice(-lines) : rawLines
      const entries: LogEntry[] = []
      for (const line of sliced) {
        if (!line.trim()) continue
        const entry = parseNapCatLine(line)
        // Apply level filter
        if (level && entry.level && entry.level !== level) continue
        entries.push(entry)
      }
      ctx.body = { entries: entries.reverse() }
    } catch (err: any) {
      ctx.status = 500; ctx.body = { error: err.message }
    }
    return
  }

  // ─── QQ Bridge log (sideria_bridge_full_pack/bridge.log) ──────
  if (logName === 'qq-bridge') {
    try {
      if (!existsSync(EXTERNAL_BRIDGE_LOG_FILE)) { ctx.body = { entries: [] }; return }
      const content = await readFile(EXTERNAL_BRIDGE_LOG_FILE, 'utf-8')
      const rawLines = content.split('\n')
      const sliced = rawLines.length > lines ? rawLines.slice(-lines) : rawLines
      const entries: LogEntry[] = []
      for (const line of sliced) { if (!line.trim()) continue; entries.push(parseLine(line)) }
      ctx.body = { entries: entries.reverse() }
    } catch (err: any) {
      ctx.status = 500; ctx.body = { error: err.message }
    }
    return
  }

  // ─── ContextX status (health check + MCP info) ────────────────
  if (logName === 'contextx') {
    try {
      const status = await fetchContextXStatus()
      const now = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
      if (status.online) {
        const entries: LogEntry[] = [
          {
            timestamp: now,
            level: 'INFO',
            logger: 'contextX',
            message: `✅ ContextX 在线 — ${status.serverInfo || 'contextX'}`,
            raw: JSON.stringify(status),
          },
        ]
        if (status.tools && status.tools.length > 0) {
          entries.push({
            timestamp: now,
            level: 'INFO',
            logger: 'contextX/mcp',
            message: `MCP 工具: ${status.tools.join(', ')}`,
            raw: JSON.stringify(status.tools),
          })
        }
        entries.push({
          timestamp: now,
          level: 'INFO',
          logger: 'contextX/endpoint',
          message: `健康检查: ${CONTEXTX_HEALTH_URL} → ok | MCP 端点: ${CONTEXTX_MCP_URL}`,
          raw: `${CONTEXTX_HEALTH_URL} | ${CONTEXTX_MCP_URL}`,
        })
        ctx.body = { entries }
      } else {
        ctx.body = {
          entries: [{
            timestamp: now,
            level: 'ERROR',
            logger: 'contextX',
            message: `❌ ContextX 离线 — ${status.error || '无法连接'}`,
            raw: JSON.stringify(status),
          }],
        }
      }
    } catch (err: any) {
      ctx.status = 500; ctx.body = { error: err.message }
    }
    return
  }

  try {
    const content = await hermesCli.readLogs(logName, lines, level, session, since)
    const rawLines = content.split('\n')
    const entries: (LogEntry | null)[] = []
    for (const line of rawLines) {
      if (line.startsWith('---') || line.trim() === '') continue
      entries.push(parseLine(line))
    }
    ctx.body = { entries: entries.reverse() }
  } catch (err: any) {
    ctx.status = 500; ctx.body = { error: err.message }
  }
}
