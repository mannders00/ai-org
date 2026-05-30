import { For, Match, Show, Switch, createMemo, createSignal, onCleanup } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"

type ParsedHeadline = {
  level: number
  text: string
  todo?: string
  priority?: string
  tags: string[]
  scheduled?: string
  deadline?: string
  closed?: boolean
  body: string
  line: number
  style?: string
  lastRepeat?: string
  repeater?: string
  clockEntries: Array<{ in: string; out?: string; minutes?: number }>
}

type OrgFile = { path: string; content: string; headlines: ParsedHeadline[] }

const HABIT_TODO = new Set(["TODO", "NEXT", "IN-PROGRESS"])

function parseTimestamp(ts: string): string {
  return ts.replace(/\s+\+\d+[hdwmy].*$/, "").replace(/\s+-\d+[hdwmy].*$/, "").trim()
}

function parseOrgFile(content: string): ParsedHeadline[] {
  const lines = content.split("\n")
  const headlines: ParsedHeadline[] = []
  let current: ParsedHeadline | undefined
  let bodyLines: string[] = []
  let inProperties = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.match(/^#\+/)) continue
    if (line.trim() === "") continue
    const headingMatch = line.match(/^(\*+)\s+(TODO|DONE|NEXT|WAITING|IN-PROGRESS|CANCELLED)?\s*(?:\[([A-C])\])?\s*(.*?)(?:\s+:(\w+(?:-\w+)*(?::\w+(?:-\w+)*)*):)?\s*$/)
    if (headingMatch) {
      if (current) current.body = bodyLines.join("\n").trim()
      bodyLines = []
      current = {
        level: headingMatch[1].length,
        text: (headingMatch[4] || "").trim(),
        todo: headingMatch[2] || undefined,
        priority: headingMatch[3] || undefined,
        tags: headingMatch[5] ? headingMatch[5].split(":").filter(Boolean) : [],
        clockEntries: [],
        body: "",
        line: i + 1,
        scheduled: undefined,
        deadline: undefined,
        closed: undefined,
      }
      const closedInline = line.match(/CLOSED:\s*\[([^\]]+)\]/)
      if (closedInline) current.closed = true
      const deadlineInline = line.match(/DEADLINE:\s*<([^>]+)>/)
      if (deadlineInline) {
        current.deadline = parseTimestamp(deadlineInline[1])
        const repM = line.match(/[.+]?\+(\d+[hdwmy])/)
        if (repM) current.repeater = repM[1]
      }
      const scheduledInline = line.match(/SCHEDULED:\s*<([^>]+)>/)
      if (scheduledInline) {
        current.scheduled = parseTimestamp(scheduledInline[1])
        if (!current.repeater) {
          const repM = line.match(/[.+]?\+(\d+[hdwmy])/)
          if (repM) current.repeater = repM[1]
        }
      }
      headlines.push(current)
      inProperties = false
    } else if (current) {
      if (line.trim() === ":PROPERTIES:") { inProperties = true; continue }
      if (line.trim() === ":END:") { inProperties = false; continue }
      if (inProperties) {
        const styleM = line.match(/^\s*:STYLE:\s*(.+)/)
        if (styleM) current.style = styleM[1].trim()
        const lrM = line.match(/^\s*:LAST_REPEAT:\s*\[([^\]]+)\]/)
        if (lrM) current.lastRepeat = lrM[1].trim()
        continue
      }
      const closedM = line.match(/^\s*CLOSED:\s*\[([^\]]+)\]/)
      if (closedM) { current.closed = true }
      if (!current.deadline) {
        const deadlineM = line.match(/^\s*DEADLINE:\s*<([^>]+)>/)
        if (deadlineM) {
          current.deadline = parseTimestamp(deadlineM[1])
          const repM = line.match(/[.+]?\+(\d+[hdwmy])/)
          if (repM) current.repeater = repM[1]
        }
      }
      if (!current.deadline && !current.closed) {
        const combinedM = line.match(/CLOSED:\s*\[([^\]]+)\]\s*DEADLINE:\s*<([^>]+)>/)
        if (combinedM) {
          current.closed = true
          current.deadline = parseTimestamp(combinedM[2])
        }
      }
      if (!current.deadline && !current.closed) {
        const combinedM2 = line.match(/DEADLINE:\s*<([^>]+)>\s*CLOSED:\s*\[([^\]]+)\]/)
        if (combinedM2) {
          current.closed = true
          current.deadline = parseTimestamp(combinedM2[1])
        }
      }
      if (!current.scheduled) {
        const scheduledM = line.match(/^\s*SCHEDULED:\s*<([^>]+)>/)
        if (scheduledM) {
          current.scheduled = parseTimestamp(scheduledM[1])
          if (!current.repeater) {
            const repM = line.match(/[.+]?\+(\d+[hdwmy])/)
            if (repM) current.repeater = repM[1]
          }
        }
      }
      if (!current.deadline) {
        const dlSchedM = line.match(/^\s*DEADLINE:\s*<([^>]+)>\s+SCHEDULED:\s*<([^>]+)>/)
        if (dlSchedM) {
          current.deadline = parseTimestamp(dlSchedM[1])
          current.scheduled = parseTimestamp(dlSchedM[2])
        }
      }
      const cm = line.match(/^\s*CLOCK:\s*\[([^\]]+)\](?:\s*--\s*\[([^\]]+)\])?(?:\s*=>\s*(\d+:\d+))?/)
      if (cm) {
        current.clockEntries.push({
          in: cm[1],
          out: cm[2] || undefined,
          minutes: cm[3] ? parseInt(cm[3].split(":")[0]) * 60 + parseInt(cm[3].split(":")[1]) : undefined,
        })
        continue
      }
      bodyLines.push(line)
    }
  }
  if (current) current.body = bodyLines.join("\n").trim()
  return headlines
}

function formatRepeatLabel(repeater?: string): string {
  if (!repeater) return ""
  const m = repeater.match(/\+(\d+)([hdwmy])/)
  if (!m) return repeater
  const n = parseInt(m[1])
  const unit: Record<string, [string, string]> = { h: ["hour", "hours"], d: ["day", "days"], w: ["week", "weeks"], m: ["month", "months"], y: ["year", "years"] }
  const [s, p] = unit[m[2]] ?? [m[2], m[2]]
  return n === 1 ? `every ${s}` : `every ${n} ${p}`
}

function isHabit(h: ParsedHeadline): boolean {
  return h.style === "habit" || !!h.repeater
}

function isToday(ts: string): boolean {
  const d = new Date()
  const prefix = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  return ts.startsWith(prefix)
}

function isPast(ts: string): boolean {
  const cleaned = ts.replace(/\s+\w{3}\s+/, "T").replace(/:$/, ":00").replace(/\s+\+\d+[hdwmy].*$/, "")
  const d = new Date(cleaned)
  if (isNaN(d.getTime())) return false
  const today = new Date()
  today.setHours(23, 59, 59, 0)
  return d < today
}

function advanceDate(ts: string, repeater: string): string {
  if (!repeater) return ts
  const m = repeater.match(/\+(\d+)([hdwmy])/)
  if (!m) return ts
  const n = parseInt(m[1])
  const unit = m[2]
  const cleaned = ts.replace(/\s+\w{3}\s+/, " ").replace(/\s+\+\d+[hdwmy].*$/, "").replace(/:$/, ":00")
  const d = new Date(cleaned)
  if (isNaN(d.getTime())) return ts
  const ms: Record<string, number> = { h: 3600000, d: 86400000, w: 604800000, m: 30 * 86400000, y: 365 * 86400000 }
  d.setTime(d.getTime() + n * (ms[unit] || 86400000))
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${days[d.getDay()]}`
}

function todayStamp(): string {
  const d = new Date()
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${days[d.getDay()]}`
}

export function SessionAgendaTab() {
  const sdk = useSDK()
  const language = useLanguage()
  const [view, setView] = createSignal<"day" | "week" | "todos" | "habits">("day")

  const today = new Date()
  const [dayOffset, setDayOffset] = createSignal(0)
  const [weekOffset, setWeekOffset] = createSignal(0)

  const dayDate = createMemo(() => {
    const d = new Date(today)
    d.setDate(d.getDate() + dayOffset())
    return d
  })

  const weekStartDate = createMemo(() => {
    const d = new Date(today)
    d.setDate(d.getDate() - d.getDay() + weekOffset() * 7)
    return d
  })

  const [orgFiles, setOrgFiles] = createSignal<OrgFile[]>([])
  const [loadError, setLoadError] = createSignal(false)
  const [completing, setCompleting] = createSignal<Set<string>>(new Set())
  const [error, setError] = createSignal<string | null>(null)

  const scanAllFiles = async (): Promise<OrgFile[]> => {
    const allFiles: OrgFile[] = []
    async function scanDir(dir: string, depth: number): Promise<void> {
      if (depth > 4) return
      let entries: Array<{ name: string; path: string; type: string }>
      try {
        const result = await sdk.client.file.list({ path: dir })
        if (!result.data) return
        entries = result.data
      } catch { return }
      for (const entry of entries) {
        if (entry.type === "file" && entry.name.endsWith(".org")) {
          try {
            const content = await sdk.client.file.read({ path: entry.path })
            if (content.data && content.data.type === "text" && content.data.content)
              allFiles.push({ path: entry.path, content: content.data.content, headlines: parseOrgFile(content.data.content) })
          } catch { /* skip */ }
        } else if (entry.type === "directory" && !entry.name.startsWith(".")) {
          await scanDir(entry.path, depth + 1)
        }
      }
    }
    await scanDir("", 0)
    return allFiles.sort((a, b) => a.path.localeCompare(b.path))
  }

  const loadAll = async () => {
    try {
      setLoadError(false)
      const files = await scanAllFiles()
      setOrgFiles(files)
    } catch { setLoadError(true) }
  }

  loadAll()

  const refreshInterval = setInterval(loadAll, 30_000)
  onCleanup(() => clearInterval(refreshInterval))

  let pendingRefetch: ReturnType<typeof setTimeout> | undefined
  const debounceRefetch = () => {
    clearTimeout(pendingRefetch)
    pendingRefetch = setTimeout(loadAll, 300)
  }

  const updateSingleFile = async (filePath: string) => {
    try {
      const content = await sdk.client.file.read({ path: filePath })
      if (content.data && content.data.type === "text" && content.data.content) {
        const updated: OrgFile = { path: filePath, content: content.data.content, headlines: parseOrgFile(content.data.content) }
        setOrgFiles(prev => {
          const idx = prev.findIndex(f => f.path === filePath)
          if (idx >= 0) { const next = [...prev]; next[idx] = updated; return next }
          return [...prev, updated].sort((a, b) => a.path.localeCompare(b.path))
        })
      }
    } catch {
      setOrgFiles(prev => prev.filter(f => f.path !== filePath))
    }
  }

  const stopWatch = sdk.event.listen((e) => {
    const detail = e.details
    if (detail.type === "file.watcher.updated") {
      const filePath: string = detail.properties?.file ?? ""
      if (!filePath.endsWith(".org")) return
      if (orgFiles().some(f => f.path === filePath)) {
        updateSingleFile(filePath)
      } else {
        debounceRefetch()
      }
    }
  })
  onCleanup(() => stopWatch())

  const [clockTick, setClockTick] = createSignal(0)
  const clockInterval = setInterval(() => setClockTick((t) => t + 1), 60_000)
  onCleanup(() => clearInterval(clockInterval))
  void clockTick

  const habits = createMemo(() => {
    const result: Array<{ file: OrgFile; headline: ParsedHeadline; dueDate?: string; overdue: boolean }> = []
    for (const f of orgFiles()) {
      for (const h of f.headlines) {
        if (!isHabit(h)) continue
        const ts = h.scheduled || h.deadline
        if (!ts) continue
        const overdue = isPast(ts) || isToday(ts)
        result.push({ file: f, headline: h, dueDate: ts, overdue })
      }
    }
    return result.sort((a, b) => {
      const aDone = a.headline.todo === "DONE" ? 1 : 0
      const bDone = b.headline.todo === "DONE" ? 1 : 0
      if (aDone !== bDone) return aDone - bDone
      return (a.dueDate ?? "").localeCompare(b.dueDate ?? "")
    })
  })

  const completeHabit = async (file: OrgFile, headline: ParsedHeadline) => {
    const key = `${file.path}:${headline.line}`
    setCompleting(prev => new Set(prev).add(key))
    try {
      const lines = file.content.split("\n")
      const lineIdx = headline.line - 1
      const ts = headline.scheduled || headline.deadline
      const repeater = headline.repeater

      if (headline.todo && HABIT_TODO.has(headline.todo) && repeater && ts) {
        const newDate = advanceDate(ts, repeater)
        const today = todayStamp()

        lines[lineIdx] = lines[lineIdx].replace(headline.todo, "DONE")

        const tsLineIdx = lines.findIndex((l, i) => i > lineIdx && (l.match(/^\s*SCHEDULED:\s*[<[]/) || l.match(/^\s*DEADLINE:\s*[<[]/)))
        if (tsLineIdx >= 0) {
          const datePart = ts.replace(/\s+\w{3}\s+/, " ").split(" ")[0]
          lines[tsLineIdx] = lines[tsLineIdx].replace(datePart, newDate.split(" ")[0])
          lines[tsLineIdx] = `CLOSED: [${today}] ` + lines[tsLineIdx].trimStart()
        } else {
          lines.splice(lineIdx + 1, 0, `  CLOSED: [${today}]`)
        }

        const existingPropsIdx = lines.findIndex((l, i) => i > lineIdx && l.trim() === ":PROPERTIES:")
        if (existingPropsIdx >= 0) {
          const endPropsIdx = lines.findIndex((l, i) => i > existingPropsIdx && l.trim() === ":END:")
          if (endPropsIdx >= 0) {
            lines.splice(endPropsIdx, 0, `  :LAST_REPEAT: [${today}]`)
          }
        }

        const patch = buildPatch(file.path, file.content, lines.join("\n"))
        await sdk.client.vcs.apply({ patch })

        await new Promise(r => setTimeout(r, 500))
        debounceRefetch()
      } else if (headline.todo && HABIT_TODO.has(headline.todo)) {
        const lines2 = file.content.split("\n")
        const lineIdx2 = headline.line - 1
        lines2[lineIdx2] = lines2[lineIdx2].replace(headline.todo, "DONE")
        const tsLineIdx2 = lines2.findIndex((l, i) => i > lineIdx2 && (l.match(/^\s*SCHEDULED:\s*[<[]/) || l.match(/^\s*DEADLINE:\s*[<[]/)))
        if (tsLineIdx2 >= 0) {
          lines2[tsLineIdx2] = `CLOSED: [${todayStamp()}] ` + lines2[tsLineIdx2].trimStart()
        } else {
          lines2.splice(lineIdx2 + 1, 0, `  CLOSED: [${todayStamp()}]`)
        }
        const patch = buildPatch(file.path, file.content, lines2.join("\n"))
        await sdk.client.vcs.apply({ patch })
        await new Promise(r => setTimeout(r, 500))
        debounceRefetch()
      }
    } catch (e) {
      console.error("[opencode] habit completion failed:", e)
      setError(String(e))
      setTimeout(() => setError(null), 4000)
    } finally {
      setCompleting(prev => { const next = new Set(prev); next.delete(key); return next })
    }
  }

  return (
    <div class="flex flex-col h-full overflow-hidden">
      <Show when={error()}>
        {(msg) => (
          <div class="shrink-0 px-2 py-1 text-12-medium text-error-bg bg-error-weaker-base">{msg()}</div>
        )}
      </Show>
      <div class="shrink-0 px-2 pt-2 pb-1 flex items-center gap-1 border-b border-border-weaker-base">
        <For each={(["day", "week", "todos", "habits"] as const)}>
          {(v) => (
            <button
              class={`px-2 py-1 text-12-medium rounded-md transition-colors ${
                view() === v
                  ? "bg-text-strong/10 text-text-strong"
                  : "text-text-weak hover:text-text-base"
              }`}
              onClick={() => setView(v)}
            >
              {language.t(`session.agenda.view.${v}`)}
            </button>
          )}
        </For>

        <Show when={view() === "day" || view() === "week"}>
          <div class="flex-1" />
          <button
            class="text-text-weak hover:text-text-base transition-colors p-1 rounded hover:bg-background-weak"
            onClick={() => { if (view() === "day") setDayOffset(d => d - 1); else setWeekOffset(w => w - 1) }}
            aria-label="Previous"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6" /></svg>
          </button>
          <button
            class="text-11-medium text-text-weak hover:text-text-base transition-colors px-1"
            onClick={() => { setDayOffset(0); setWeekOffset(0) }}
          >
            Today
          </button>
          <button
            class="text-text-weak hover:text-text-base transition-colors p-1 rounded hover:bg-background-weak"
            onClick={() => { if (view() === "day") setDayOffset(d => d + 1); else setWeekOffset(w => w + 1) }}
            aria-label="Next"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6" /></svg>
          </button>
        </Show>
      </div>

      <div class="flex-1 overflow-y-auto min-h-0">
        <Show when={orgFiles().length === 0 && loadError()}>
          <div class="flex flex-col items-center justify-center py-12 gap-2">
            <div class="text-13-regular text-red-400">Failed to load agenda</div>
            <button class="text-12-medium text-blue-400 hover:underline" onClick={loadAll}>Retry</button>
          </div>
        </Show>

        <Show when={orgFiles().length === 0 && !loadError()}>
          <div class="flex items-center justify-center py-12 text-13-regular text-text-weak/30">Loading...</div>
        </Show>

        <Show when={orgFiles().length > 0 || loadError()} keyed={false}>
          <Switch>
            <Match when={view() === "day"}>
              <DayView files={orgFiles()} date={dayDate()} isToday={dayOffset() === 0} />
            </Match>
            <Match when={view() === "week"}>
              <WeekView files={orgFiles()} startDate={weekStartDate} />
            </Match>
            <Match when={view() === "todos"}>
              <TodosView files={orgFiles()} />
            </Match>
            <Match when={view() === "habits"}>
              <HabitsView files={orgFiles()} habits={habits()} completing={completing()} onComplete={completeHabit} />
            </Match>
          </Switch>
        </Show>
      </div>
    </div>
  )
}

function buildPatch(filePath: string, oldContent: string, newContent: string): string {
  const split = (s: string) => {
    const lines = s.split("\n")
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
    return lines
  }
  const oldLines = split(oldContent)
  const newLines = split(newContent)
  const ctx = 3
  let diffStart = 0
  while (diffStart < oldLines.length && diffStart < newLines.length && oldLines[diffStart] === newLines[diffStart]) diffStart++
  let diffEnd = 0
  while (diffEnd < oldLines.length - diffStart && diffEnd < newLines.length - diffStart && oldLines[oldLines.length - 1 - diffEnd] === newLines[newLines.length - 1 - diffEnd]) diffEnd++
  const beforeCtx = oldLines.slice(Math.max(0, diffStart - ctx), diffStart)
  const removed = diffEnd > 0 ? oldLines.slice(diffStart, oldLines.length - diffEnd) : oldLines.slice(diffStart)
  const added = diffEnd > 0 ? newLines.slice(diffStart, newLines.length - diffEnd) : newLines.slice(diffStart)
  const afterCtx = diffEnd > 0 ? oldLines.slice(oldLines.length - diffEnd) : []
  const hunkOldCount = beforeCtx.length + removed.length + afterCtx.length
  const hunkNewCount = beforeCtx.length + added.length + afterCtx.length
  const hunkStart = diffStart - beforeCtx.length
  const lines: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`, `@@ -${hunkStart + 1},${hunkOldCount} +${hunkStart + 1},${hunkNewCount} @@`]
  for (const line of beforeCtx) lines.push(` ${line}`)
  for (const line of removed) lines.push(`-${line}`)
  for (const line of added) lines.push(`+${line}`)
  for (const line of afterCtx) lines.push(` ${line}`)
  if (!oldContent.endsWith("\n")) lines.push("\\ No newline at end of file")
  return lines.join("\n")
}

function HabitsView(props: { files: OrgFile[]; habits: Array<{ file: OrgFile; headline: ParsedHeadline; dueDate?: string; overdue: boolean }>; completing: Set<string>; onComplete: (file: OrgFile, headline: ParsedHeadline) => void }) {
  const [filter, setFilter] = createSignal<"all" | "today" | "overdue">("today")

  const filtered = createMemo(() => {
    const f = filter()
    if (f === "all") return props.habits
    if (f === "overdue") return props.habits.filter(h => h.overdue && h.headline.todo !== "DONE")
    return props.habits.filter(h => h.overdue || h.headline.todo === "DONE" || h.headline.todo === "NEXT" || h.headline.todo === "IN-PROGRESS")
  })

  const todayHabits = createMemo(() => filtered().filter(h => h.overdue || h.headline.todo !== "DONE"))
  const doneToday = createMemo(() => filtered().filter(h => h.headline.todo === "DONE"))

  return (
    <div class="flex flex-col">
      <div class="shrink-0 px-3 pt-3 pb-2 flex items-center gap-2">
        <For each={(["today", "overdue", "all"] as const)}>
          {(v) => (
            <button
              class={`px-2 py-0.5 text-11-medium rounded-md transition-colors ${
                filter() === v ? "bg-text-strong/10 text-text-strong" : "text-text-weak hover:text-text-base"
              }`}
              onClick={() => setFilter(v)}
            >
              {v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          )}
        </For>
      </div>

      <Show when={todayHabits().length > 0}>
        <SectionLabel label="Due" count={todayHabits().length} />
        <div class="flex flex-col gap-0.5 px-1">
          <For each={todayHabits()}>
            {(item) => {
              const key = `${item.file.path}:${item.headline.line}`
              const isCompleting = props.completing.has(key)
              const isDone = item.headline.todo === "DONE"
              return (
                <div class={`flex items-center gap-2 px-3 py-1.5 rounded-sm transition-colors ${isDone ? "bg-surface-success-soft/30" : "hover:bg-background-weak"}`}>
                  <button
                    class={`shrink-0 w-4 h-4 rounded-sm border transition-colors flex items-center justify-center ${
                      isDone ? "bg-green-500 border-green-500" : isCompleting ? "border-text-weak/30 animate-pulse" : "border-text-weak/40 hover:border-text-base"
                    }`}
                    onClick={() => !isDone && !isCompleting && props.onComplete(item.file, item.headline)}
                    disabled={isDone || isCompleting}
                    aria-label={isDone ? "Completed" : "Complete habit"}
                  >
                    <Show when={isDone}>
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                    </Show>
                  </button>
                  <span class={`flex-1 min-w-0 text-13-regular ${isDone ? "text-text-weak line-through" : "text-text-base"}`}>{item.headline.text}</span>
                  <Show when={item.headline.repeater}>
                    <span class="shrink-0 text-10-medium text-text-weak/50 bg-background-weak rounded px-1.5 py-0.5">{formatRepeatLabel(item.headline.repeater)}</span>
                  </Show>
                  <Show when={item.headline.priority}>
                    <span class={`shrink-0 text-10-semibold px-1 py-0.5 rounded-sm ${item.headline.priority === "A" ? "bg-red-500/10 text-red-400" : item.headline.priority === "B" ? "bg-yellow-500/10 text-yellow-500" : "bg-blue-500/10 text-blue-400"}`}>{item.headline.priority}</span>
                  </Show>
                </div>
              )
            }}
          </For>
        </div>
      </Show>

      <Show when={doneToday().length > 0}>
        <SectionLabel label="Done" count={doneToday().length} />
        <div class="flex flex-col gap-0.5 px-1">
          <For each={doneToday()}>
            {(item) => (
              <div class="flex items-center gap-2 px-3 py-1.5 rounded-sm bg-surface-success-soft/30">
                <span class="shrink-0 w-4 h-4 rounded-sm border bg-green-500 border-green-500 flex items-center justify-center">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                </span>
                <span class="flex-1 min-w-0 text-13-regular text-text-weak line-through">{item.headline.text}</span>
                <Show when={item.headline.repeater}>
                  <span class="shrink-0 text-10-medium text-text-weak/50 bg-background-weak rounded px-1.5 py-0.5">{formatRepeatLabel(item.headline.repeater)}</span>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={filtered().length === 0}>
        <div class="px-3 py-8 text-center text-13-regular text-text-weak/30">No habits found</div>
      </Show>
    </div>
  )
}

function category(path: string): string {
  return path.replace(/\.org$/, "").split("/").pop() || path
}

function formatTime(ts: string): string {
  const m = ts.match(/(\d{2}):(\d{2})/)
  return m ? `${m[1]}:${m[2]}` : ""
}

function formatDateOnly(ts: string): string {
  return ts.replace(/\s+\w{3}\s+/, " ").split(" ")[0] || ts
}

function isSameDay(ts: string, date: Date): boolean {
  const prefix = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
  return ts.startsWith(prefix)
}

function isOverdue(ts: string): boolean {
  const cleaned = ts.replace(/\s+\w{3}\s+/, "T").replace(/:$/, ":00")
  const d = new Date(cleaned)
  if (isNaN(d.getTime())) return false
  const today = new Date()
  today.setHours(23, 59, 59, 0)
  return d < today
}

function daysUntil(ts: string): number {
  const cleaned = ts.replace(/\s+\w{3}\s+/, "T").replace(/:$/, ":00")
  const d = new Date(cleaned)
  if (isNaN(d.getTime())) return 0
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.floor((d.getTime() - today.getTime()) / 86400000)
}

function elapsedSince(ts: string): string {
  const cleaned = ts.replace(/\s+\w{3}\s+/, "T").replace(/:$/, ":00")
  const start = new Date(cleaned)
  if (isNaN(start.getTime())) return ""
  const minutes = Math.floor((Date.now() - start.getTime()) / 60000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

function fmtDate(d: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()}`
}

const ALL_TODO = new Set(["TODO", "NEXT", "IN-PROGRESS", "WAITING", "DONE", "CANCELLED"])

function todoStyle(todo?: string): string {
  if (!todo) return "text-text-weak"
  if (todo === "DONE") return "text-text-weak line-through"
  if (todo === "CANCELLED") return "text-text-weak/50 line-through"
  if (todo === "IN-PROGRESS") return "text-green-400"
  if (todo === "NEXT") return "text-blue-400"
  if (todo === "WAITING") return "text-yellow-500"
  return "text-text-weak"
}

function priorityStyle(p?: string): string {
  if (!p) return ""
  if (p === "A") return "bg-red-500/10 text-red-400"
  if (p === "B") return "bg-yellow-500/10 text-yellow-500"
  return "bg-blue-500/10 text-blue-400"
}

function ItemRow(props: { todo?: string; priority?: string; text: string; tags?: string[]; category?: string; time?: string; warn?: string; done?: boolean; active?: boolean }) {
  return (
    <div class={`flex items-center gap-2 px-3 py-1.5 rounded-sm transition-colors ${props.active ? "bg-surface-success-soft" : "hover:bg-background-weak"}`}>
      <Show when={props.time}>
        <span class="shrink-0 w-11 text-right text-11-regular text-text-weak tabular-nums">{props.time}</span>
      </Show>
      <Show when={!props.time}>
        <span class="shrink-0 w-11" />
      </Show>
      <Show when={props.todo}>
        <span class={`shrink-0 text-11-medium uppercase tracking-wide ${todoStyle(props.todo)}`}>
          {props.todo === "IN-PROGRESS" ? "PROG" : props.todo === "CANCELLED" ? "CNCL" : props.todo}
        </span>
      </Show>
      <Show when={!props.todo}>
        <span class="shrink-0 w-12" />
      </Show>
      <Show when={props.priority}>
        <span class={`shrink-0 text-10-semibold px-1 py-0.5 rounded-sm ${priorityStyle(props.priority)}`}>
          {props.priority}
        </span>
      </Show>
      <div class="flex-1 min-w-0">
        <span class={`text-13-regular ${props.done ? "text-text-weak line-through" : props.warn ? "text-red-400" : props.active ? "text-text-strong" : "text-text-base"}`}>
          {props.text}
        </span>
      </div>
      <Show when={props.warn}>
        <span class="shrink-0 text-10-semibold text-red-400">{props.warn}</span>
      </Show>
      <Show when={props.category}>
        <span class="shrink-0 text-11-regular text-text-weak/50 truncate max-w-24">{props.category}</span>
      </Show>
      <Show when={props.tags && props.tags!.length > 0}>
        <span class="shrink-0 text-11-regular text-text-weak/40">:{props.tags!.join(":")}:</span>
      </Show>
    </div>
  )
}

function SectionLabel(props: { label: string; count?: number }) {
  return (
    <div class="flex items-center gap-2 px-3 pt-3 pb-1">
      <span class="text-11-semibold text-text-weak/50 uppercase tracking-wider">{props.label}</span>
      <Show when={props.count !== undefined && props.count > 0}>
        <span class="text-10-semibold text-text-weak/40 bg-background-weak rounded-full px-1.5 leading-none">{props.count}</span>
      </Show>
    </div>
  )
}

function DayView(props: { files: OrgFile[]; date: Date; isToday?: boolean }) {
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

  const clocks = createMemo(() => {
    const result: Array<{ heading: string; startTime: string; category: string }> = []
    for (const f of props.files) {
      for (const h of f.headlines) {
        for (const c of h.clockEntries) {
          if (!c.out) result.push({ heading: h.text, startTime: c.in, category: category(f.path) })
        }
      }
    }
    return result
  })

  const overdue = createMemo(() => {
    const items: Array<{ todo?: string; priority?: string; text: string; tags: string[]; category: string; deadline: string; done: boolean }> = []
    if (!props.isToday) return items
    for (const f of props.files) {
      for (const h of f.headlines) {
        if (!h.deadline || !isOverdue(h.deadline) || isSameDay(h.deadline, props.date)) continue
        if (h.style === "habit" || h.repeater) continue
        if (h.closed || h.todo === "DONE" || h.todo === "CANCELLED") continue
        items.push({ todo: h.todo, priority: h.priority, text: h.text, tags: h.tags, category: category(f.path), deadline: h.deadline, done: h.todo === "DONE" || h.todo === "CANCELLED" })
      }
    }
    return items
  })

  const deadlines = createMemo(() => {
    const items: Array<{ todo?: string; priority?: string; text: string; tags: string[]; category: string; deadline: string; done: boolean }> = []
    for (const f of props.files) {
      for (const h of f.headlines) {
        if (!h.deadline || !isSameDay(h.deadline, props.date)) continue
        if (h.style === "habit" || h.repeater) continue
        const isDone = h.closed || h.todo === "DONE" || h.todo === "CANCELLED"
        items.push({ todo: h.todo, priority: h.priority, text: h.text, tags: h.tags, category: category(f.path), deadline: h.deadline, done: isDone })
      }
    }
    return items
  })

  const scheduled = createMemo(() => {
    const items: Array<{ todo?: string; priority?: string; text: string; tags: string[]; category: string; scheduled: string; done: boolean }> = []
    for (const f of props.files) {
      for (const h of f.headlines) {
        if (!h.scheduled || !isSameDay(h.scheduled, props.date)) continue
        if (h.style === "habit" || h.repeater) continue
        const isDone = h.closed || h.todo === "DONE" || h.todo === "CANCELLED"
        items.push({ todo: h.todo, priority: h.priority, text: h.text, tags: h.tags, category: category(f.path), scheduled: h.scheduled, done: isDone })
      }
    }
    return items.sort((a, b) => a.scheduled.localeCompare(b.scheduled))
  })

  const hasContent = createMemo(() => clocks().length > 0 || overdue().length > 0 || deadlines().length > 0 || scheduled().length > 0)

  return (
    <div class="flex flex-col">
      <div class="px-3 pt-2 pb-1">
        <span class="text-14-semibold text-text-strong">{dayNames[props.date.getDay()]}</span>
        <span class="text-13-regular text-text-weak ml-2">{months[props.date.getMonth()]} {props.date.getDate()}</span>
        <Show when={props.isToday}>
          <span class="text-10-semibold text-blue-400 ml-2">Today</span>
        </Show>
      </div>

      <Show when={clocks().length > 0}>
        <SectionLabel label="Tracking" count={clocks().length} />
        <div class="flex flex-col gap-0.5 px-1">
          <For each={clocks()}>
            {(c) => {
              const elapsed = createMemo(() => elapsedSince(c.startTime))
              return (
                <div class="flex items-center gap-2 px-3 py-1.5 rounded-sm bg-green-500/5 border border-green-500/10">
                  <span class="shrink-0 w-11 text-right text-11-semibold text-green-400 tabular-nums">{elapsed()}</span>
                  <span class="flex-1 min-w-0 text-13-regular text-text-strong truncate">{c.heading}</span>
                  <span class="shrink-0 text-11-regular text-text-weak/50">{c.category}</span>
                  <span class="shrink-0 w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                </div>
              )
            }}
          </For>
        </div>
      </Show>

      <Show when={overdue().length > 0}>
        <SectionLabel label="Overdue" count={overdue().length} />
        <div class="flex flex-col gap-0.5 px-1">
          <For each={overdue()}>
            {(item) => (
              <ItemRow todo={item.todo} priority={item.priority} text={item.text} tags={item.tags} category={item.category} time={formatDateOnly(item.deadline)} warn={`${Math.abs(daysUntil(item.deadline))}d overdue`} done={item.done} />
            )}
          </For>
        </div>
      </Show>

      <Show when={deadlines().length > 0}>
        <SectionLabel label="Due" count={deadlines().length} />
        <div class="flex flex-col gap-0.5 px-1">
          <For each={deadlines()}>
            {(item) => (
              <ItemRow todo={item.todo} priority={item.priority} text={item.text} tags={item.tags} category={item.category} time={formatTime(item.deadline)} done={item.done} />
            )}
          </For>
        </div>
      </Show>

      <Show when={scheduled().length > 0}>
        <SectionLabel label="Scheduled" count={scheduled().length} />
        <div class="flex flex-col gap-0.5 px-1">
          <For each={scheduled()}>
            {(item) => (
              <ItemRow todo={item.todo} priority={item.priority} text={item.text} tags={item.tags} category={item.category} time={formatTime(item.scheduled)} done={item.done} />
            )}
          </For>
        </div>
      </Show>

      <Show when={!hasContent()}>
        <div class="px-3 py-8 text-center text-13-regular text-text-weak/30">Nothing scheduled</div>
      </Show>
    </div>
  )
}

function WeekView(props: { files: OrgFile[]; startDate: () => Date }) {
  const days = createMemo(() => {
    const start = props.startDate()
    const result: Date[] = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      result.push(d)
    }
    return result
  })

  const today = createMemo(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  })

  const weekLabel = createMemo(() => {
    const start = props.startDate()
    const end = new Date(start)
    end.setDate(end.getDate() + 6)
    return `${fmtDate(start)} — ${fmtDate(end)}`
  })

  return (
    <div class="flex flex-col">
      <div class="px-3 pt-2 pb-1">
        <span class="text-14-semibold text-text-strong">{weekLabel()}</span>
      </div>
      <For each={days()}>
        {(d) => (
          <DayView files={props.files} date={d} isToday={isSameDay(today(), d)} />
        )}
      </For>
    </div>
  )
}

function TodosView(props: { files: OrgFile[] }) {
  const byState = createMemo(() => {
    const groups = new Map<string, Array<{ todo?: string; priority?: string; text: string; tags: string[]; category: string; scheduled?: string; deadline?: string }>>()
    const keywordOrder = ["IN-PROGRESS", "NEXT", "TODO", "WAITING"]
    for (const kw of keywordOrder) groups.set(kw, [])
    for (const f of props.files) {
      for (const h of f.headlines) {
        const todo = h.todo
        if (!todo || !ALL_TODO.has(todo)) continue
        if (h.style === "habit" || h.repeater) continue
        const items = groups.get(todo)
        if (!items) continue
        items.push({ todo, priority: h.priority, text: h.text, tags: h.tags, category: category(f.path), scheduled: h.scheduled, deadline: h.deadline })
      }
    }
    for (const [, items] of groups) {
      items.sort((a, b) => {
        const priOrder: Record<string, number> = { A: 0, B: 1, C: 2 }
        return (priOrder[a.priority ?? ""] ?? 3) - (priOrder[b.priority ?? ""] ?? 3)
      })
    }
    return groups
  })

  return (
    <div class="flex flex-col">
      <For each={[...byState().entries()]}>
        {([state, items]) => (
          <Show when={items.length > 0}>
            <SectionLabel label={state} count={items.length} />
            <div class="flex flex-col gap-0.5 px-1">
              <For each={items}>
                {(item) => (
                  <ItemRow
                    todo={item.todo}
                    priority={item.priority}
                    text={item.text}
                    tags={item.tags}
                    category={item.category}
                    time={item.deadline ? (isOverdue(item.deadline) ? `${Math.abs(daysUntil(item.deadline))}d` : formatDateOnly(item.deadline)) : item.scheduled ? formatTime(item.scheduled) : undefined}
                    warn={item.deadline && isOverdue(item.deadline) ? "overdue" : undefined}
                  />
                )}
              </For>
            </div>
          </Show>
        )}
      </For>
    </div>
  )
}