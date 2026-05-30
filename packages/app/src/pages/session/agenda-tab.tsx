import { For, Match, Resource, Show, Switch, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
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
  body: string
  line: number
  clockEntries: Array<{ in: string; out?: string; minutes?: number }>
}

type AgendaView = "today" | "todos" | "week" | "deadlines"

const ACTIVE_TODO_STATES = new Set(["TODO", "NEXT", "IN-PROGRESS", "WAITING"])

const VIEW_LABELS: Record<AgendaView, string> = {
  today: "session.agenda.view.today",
  todos: "session.agenda.view.todos",
  week: "session.agenda.view.week",
  deadlines: "session.agenda.view.deadlines",
}

function parseOrgFile(content: string): ParsedHeadline[] {
  const lines = content.split("\n")
  const headlines: ParsedHeadline[] = []
  let current: ParsedHeadline | undefined
  let bodyLines: string[] = []
  let inProperties = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
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
      }
      headlines.push(current)
      inProperties = false
    } else if (current) {
      if (line.trim() === ":PROPERTIES:") { inProperties = true; continue }
      if (line.trim() === ":END:") { inProperties = false; continue }
      if (inProperties) continue
      const sm = line.match(/^\s*SCHEDULED:\s*\[([^\]]+)\]/)
      if (sm) { current.scheduled = sm[1]; continue }
      const dm = line.match(/^\s*DEADLINE:\s*\[([^\]]+)\]/)
      if (dm) { current.deadline = dm[1]; continue }
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

function formatDate(ts: string): string {
  return ts.replace(/\s+\w{3}\s+/, " ").trim()
}

function formatClockTime(ts: string): string {
  const m = ts.match(/(\d{4})-(\d{2})-(\d{2})\s+\w+\s+(\d{2}):(\d{2})/)
  if (m) return `${m[3]} ${m[4]}:${m[5]}`
  return ts
}

function isToday(ts: string): boolean {
  const now = new Date()
  const prefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  return ts.startsWith(prefix)
}

function isOverdue(ts: string): boolean {
  const cleaned = ts.replace(/\s+\w{3}\s+/, "T").replace(/:$/, ":00")
  const d = new Date(cleaned)
  if (isNaN(d.getTime())) return false
  return d < new Date()
}

function isInRange(ts: string, start: Date, end: Date): boolean {
  const cleaned = ts.replace(/\s+\w{3}\s+/, "T").replace(/:$/, ":00")
  const d = new Date(cleaned)
  if (isNaN(d.getTime())) return false
  return d >= start && d <= end
}

function isThisWeek(ts: string): boolean {
  const now = new Date()
  const end = new Date(now)
  end.setDate(end.getDate() + 7)
  return isInRange(ts, now, end)
}

function elapsedSince(ts: string): string {
  const cleaned = ts.replace(/\s+\w{3}\s+/, "T").replace(/:$/, ":00")
  const start = new Date(cleaned)
  if (isNaN(start.getTime())) return ""
  const minutes = Math.floor((Date.now() - start.getTime()) / 60000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

type OrgFile = { path: string; headlines: ParsedHeadline[] }

function AgendaItem(props: { todo?: string; priority?: string; text: string; tags?: string[]; detail?: string; time?: string; overdue?: boolean; active?: boolean }) {
  const todoColor = createMemo(() => {
    const t = props.todo
    if (!t) return ""
    if (t === "DONE" || t === "CANCELLED") return "text-text-weak line-through"
    if (t === "IN-PROGRESS") return "text-text-base"
    if (t === "NEXT") return "text-text-strong"
    if (t === "WAITING") return "text-text-weak italic"
    return "text-text-weak"
  })

  const priorityClass = createMemo(() => {
    const p = props.priority
    if (!p) return ""
    if (p === "A") return "bg-red-500/15 text-red-400 border-red-500/20"
    if (p === "B") return "bg-yellow-500/15 text-yellow-400 border-yellow-500/20"
    return "bg-blue-500/15 text-blue-400 border-blue-500/20"
  })

  return (
    <div class={`flex items-start gap-2.5 py-2 px-3 rounded-md transition-colors ${props.active ? "bg-background-stronger" : "hover:bg-background-weak"}`}>
      <Show when={props.todo}>
        <span class={`text-11-medium uppercase tracking-wide mt-0.5 shrink-0 ${todoColor()}`}>
          {props.todo}
        </span>
      </Show>
      <Show when={props.priority}>
        <span class={`text-10-medium px-1.5 py-0.5 rounded border mt-0.5 shrink-0 ${priorityClass()}`}>
          {props.priority}
        </span>
      </Show>
      <div class="flex-1 min-w-0">
        <div class={`text-13-regular leading-snug ${props.overdue ? "text-red-400" : props.active ? "text-text-strong" : "text-text-base"}`}>
          {props.text}
        </div>
        <Show when={props.detail}>
          <div class="text-12-regular text-text-weak mt-0.5 truncate">{props.detail}</div>
        </Show>
      </div>
      <Show when={props.time}>
        <span class={`text-11-regular shrink-0 mt-0.5 ${props.overdue ? "text-red-400" : props.active ? "text-text-strong" : "text-text-weak"}`}>
          {props.time}
        </span>
      </Show>
    </div>
  )
}

function ClockIndicator(props: { heading: string; startTime: string; file: string }) {
  const elapsed = createMemo(() => elapsedSince(props.startTime))
  return (
    <div class="flex items-center gap-2 py-2 px-3 rounded-md bg-surface-success-soft border border-border-success-muted">
      <div class="flex-1 min-w-0">
        <div class="text-13-medium text-text-strong truncate">{props.heading}</div>
        <div class="text-11-regular text-text-weak">{props.file} · <Show when={elapsed()} fallback="…">{elapsed()}</Show></div>
      </div>
      <div class="shrink-0 w-2 h-2 rounded-full bg-success-base animate-pulse" />
    </div>
  )
}

function TodayView(props: { files: OrgFile[]; language: ReturnType<typeof useLanguage> }) {
  const today = createMemo(() => {
    const now = new Date()
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    return {
      day: dayNames[now.getDay()],
      date: now.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
    }
  })

  const scheduledItems = createMemo(() => {
    const items: Array<{ todo?: string; priority?: string; text: string; file: string; scheduled?: string; tags: string[] }> = []
    for (const f of props.files) {
      for (const h of f.headlines) {
        if (h.scheduled && isToday(h.scheduled)) {
          items.push({ todo: h.todo, priority: h.priority, text: h.text, file: f.path, scheduled: h.scheduled, tags: h.tags })
        }
      }
    }
    return items
  })

  const deadlineItems = createMemo(() => {
    const items: Array<{ todo?: string; priority?: string; text: string; file: string; deadline: string; tags: string[] }> = []
    for (const f of props.files) {
      for (const h of f.headlines) {
        if (h.deadline && isToday(h.deadline)) {
          items.push({ todo: h.todo, priority: h.priority, text: h.text, file: f.path, deadline: h.deadline, tags: h.tags })
        }
      }
    }
    return items
  })

  const activeClocks = createMemo(() => {
    const clocks: Array<{ heading: string; startTime: string; file: string }> = []
    for (const f of props.files) {
      for (const h of f.headlines) {
        for (const c of h.clockEntries) {
          if (!c.out) {
            clocks.push({ heading: h.text, startTime: c.in, file: f.path })
          }
        }
      }
    }
    return clocks
  })

  const hasContent = createMemo(() => scheduledItems().length > 0 || deadlineItems().length > 0 || activeClocks().length > 0)

  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-baseline gap-2 px-3 pt-1">
        <span class="text-14-medium text-text-strong">{today().day}</span>
        <span class="text-12-regular text-text-weak">{today().date}</span>
      </div>

      <Show when={activeClocks().length > 0}>
        <div class="px-3">
          <div class="text-11-medium text-text-weak uppercase tracking-wider mb-1.5">
            {props.language.t("session.agenda.activeClocks")}
          </div>
          <div class="flex flex-col gap-1">
            <For each={activeClocks()}>
              {(clock) => <ClockIndicator heading={clock.heading} startTime={clock.startTime} file={clock.file} />}
            </For>
          </div>
        </div>
      </Show>

      <Show when={scheduledItems().length > 0}>
        <div class="px-3">
          <div class="text-11-medium text-text-weak uppercase tracking-wider mb-1">
            {props.language.t("session.agenda.scheduled")}
          </div>
          <div class="flex flex-col gap-0.5">
            <For each={scheduledItems()}>
              {(item) => (
                <AgendaItem
                  todo={item.todo}
                  priority={item.priority}
                  text={item.text}
                  time={item.scheduled ? formatClockTime(item.scheduled) : undefined}
                  detail={item.file}
                  tags={item.tags}
                />
              )}
            </For>
          </div>
        </div>
      </Show>

      <Show when={deadlineItems().length > 0}>
        <div class="px-3">
          <div class="text-11-medium text-text-weak uppercase tracking-wider mb-1">
            {props.language.t("session.agenda.deadlines")}
          </div>
          <div class="flex flex-col gap-0.5">
            <For each={deadlineItems()}>
              {(item) => (
                <AgendaItem
                  todo={item.todo}
                  priority={item.priority}
                  text={item.text}
                  time={formatClockTime(item.deadline)}
                  detail={item.file}
                  tags={item.tags}
                  overdue={isOverdue(item.deadline)}
                />
              )}
            </For>
          </div>
        </div>
      </Show>

      <Show when={!hasContent()}>
        <div class="flex flex-col items-center justify-center py-12 gap-3">
          <div class="text-13-regular text-text-weak">{props.language.t("session.agenda.nothingToday")}</div>
        </div>
      </Show>
    </div>
  )
}

function TodosView(props: { files: OrgFile[] }) {
  const allTodos = createMemo(() => {
    const items: Array<{ todo?: string; priority?: string; text: string; file: string; scheduled?: string; deadline?: string; tags: string[] }> = []
    for (const f of props.files) {
      for (const h of f.headlines) {
        if (ACTIVE_TODO_STATES.has(h.todo || "")) {
          items.push({ todo: h.todo, priority: h.priority, text: h.text, file: f.path, scheduled: h.scheduled, deadline: h.deadline, tags: h.tags })
        }
      }
    }
    return items.sort((a, b) => {
      const priOrder: Record<string, number> = { A: 0, B: 1, C: 2 }
      const pa = priOrder[a.priority ?? ""] ?? 3
      const pb = priOrder[b.priority ?? ""] ?? 3
      if (pa !== pb) return pa - pb
      const stateOrder: Record<string, number> = { "IN-PROGRESS": 0, NEXT: 1, TODO: 2, WAITING: 3 }
      const sa = stateOrder[a.todo ?? ""] ?? 4
      const sb = stateOrder[b.todo ?? ""] ?? 4
      return sa - sb
    })
  })

  return (
    <Show when={allTodos().length > 0} fallback={
      <div class="flex flex-col items-center justify-center py-12 gap-3">
        <div class="text-13-regular text-text-weak">No open TODOs found.</div>
      </div>
    }>
      <div class="flex flex-col gap-0.5 px-3 pt-3">
        <For each={allTodos()}>
          {(item) => (
            <AgendaItem
              todo={item.todo}
              priority={item.priority}
              text={item.text}
              detail={item.file}
              time={item.scheduled ? formatClockTime(item.scheduled) : item.deadline ? formatClockTime(item.deadline) : undefined}
              overdue={item.deadline ? isOverdue(item.deadline) : undefined}
              tags={item.tags}
            />
          )}
        </For>
      </div>
    </Show>
  )
}

function WeekView(props: { files: OrgFile[] }) {
  const weekItems = createMemo(() => {
    const now = new Date()
    const end = new Date(now)
    end.setDate(end.getDate() + 7)
    const items: Array<{ todo?: string; priority?: string; text: string; file: string; date: string; type: "S" | "D"; tags: string[] }> = []
    for (const f of props.files) {
      for (const h of f.headlines) {
        if (h.scheduled && isInRange(h.scheduled, now, end)) {
          items.push({ todo: h.todo, priority: h.priority, text: h.text, file: f.path, date: h.scheduled.split(" ")[0], type: "S", tags: h.tags })
        }
        if (h.deadline && isInRange(h.deadline, now, end)) {
          items.push({ todo: h.todo, priority: h.priority, text: h.text, file: f.path, date: h.deadline.split(" ")[0], type: "D", tags: h.tags })
        }
      }
    }
    return items.sort((a, b) => a.date.localeCompare(b.date))
  })

  return (
    <Show when={weekItems().length > 0} fallback={
      <div class="flex flex-col items-center justify-center py-12 gap-3">
        <div class="text-13-regular text-text-weak">Nothing scheduled this week.</div>
      </div>
    }>
      <div class="flex flex-col gap-0.5 px-3 pt-3">
        <For each={weekItems()}>
          {(item) => (
            <AgendaItem
              todo={item.todo}
              priority={item.priority}
              text={item.text}
              time={`${item.date} ${item.type === "S" ? "📅" : "🔴"}`}
              detail={item.file}
              tags={item.tags}
            />
          )}
        </For>
      </div>
    </Show>
  )
}

function DeadlinesView(props: { files: OrgFile[] }) {
  const overdueItems = createMemo(() => {
    const items: Array<{ todo?: string; priority?: string; text: string; file: string; deadline: string; tags: string[] }> = []
    for (const f of props.files) {
      for (const h of f.headlines) {
        if (h.deadline && isOverdue(h.deadline) && ACTIVE_TODO_STATES.has(h.todo || "")) {
          items.push({ todo: h.todo, priority: h.priority, text: h.text, file: f.path, deadline: h.deadline, tags: h.tags })
        }
      }
    }
    return items
  })

  return (
    <Show when={overdueItems().length > 0} fallback={
      <div class="flex flex-col items-center justify-center py-12 gap-3">
        <div class="text-13-regular text-text-weak">No overdue deadlines!</div>
      </div>
    }>
      <div class="flex flex-col gap-0.5 px-3 pt-3">
        <For each={overdueItems()}>
          {(item) => (
            <AgendaItem
              todo={item.todo}
              priority={item.priority}
              text={item.text}
              time={formatClockTime(item.deadline)}
              detail={item.file}
              overdue
              tags={item.tags}
            />
          )}
        </For>
      </div>
    </Show>
  )
}

export function SessionAgendaTab() {
  const sdk = useSDK()
  const language = useLanguage()
  const [view, setView] = createSignal<AgendaView>("today")

  const fetchOrgFiles = async (): Promise<OrgFile[]> => {
    const allFiles: OrgFile[] = []

    async function scanDir(dir: string, depth: number): Promise<void> {
      if (depth > 4) return
      let entries: Array<{ name: string; path: string; type: string }>
      try {
        const result = await sdk.client.file.list({ path: dir })
        if (!result.data) return
        entries = result.data
      } catch {
        return
      }

      for (const entry of entries) {
        if (entry.type === "file" && entry.name.endsWith(".org")) {
          try {
            const content = await sdk.client.file.read({ path: entry.path })
            if (content.data && content.data.type === "text" && content.data.content) {
              allFiles.push({ path: entry.path, headlines: parseOrgFile(content.data.content) })
            }
          } catch {
            /* skip unreadable files */
          }
        } else if (entry.type === "directory" && !entry.name.startsWith(".")) {
          await scanDir(entry.path, depth + 1)
        }
      }
    }

    await scanDir("", 0)
    return allFiles
  }

  const [orgFiles, { refetch }] = createResource(fetchOrgFiles, { initialValue: [] })

  const refreshInterval = setInterval(() => refetch(), 30_000)
  onCleanup(() => clearInterval(refreshInterval))

  const stopWatch = sdk.event.listen((e) => {
    const detail = e.details
    if (detail.type === "file.watcher.updated") {
      const filePath: string = detail.properties?.file ?? ""
      if (filePath.endsWith(".org")) {
        refetch()
      }
    }
  })
  onCleanup(() => stopWatch())

  const [clockTick, setClockTick] = createSignal(0)
  const clockInterval = setInterval(() => setClockTick((t) => t + 1), 60_000)
  onCleanup(() => clearInterval(clockInterval))

  void clockTick

  return (
    <div class="flex flex-col h-full overflow-hidden">
      <div class="shrink-0 px-3 pt-2 pb-1.5 flex items-center gap-1 border-b border-border-weaker-base">
        <For each={(["today", "todos", "week", "deadlines"] as AgendaView[])}>
          {(v) => (
            <button
              class={`px-2.5 py-1 text-12-medium rounded-md transition-colors ${
                view() === v
                  ? "bg-surface-base-active text-text-strong"
                  : "text-text-weak hover:text-text-base hover:bg-surface-base-hover"
              }`}
              onClick={() => setView(v)}
            >
              {language.t(VIEW_LABELS[v])}
            </button>
          )}
        </For>
      </div>

      <div class="flex-1 overflow-y-auto min-h-0">
        <Show when={orgFiles.loading && orgFiles.latest.length === 0}>
          <div class="flex items-center justify-center py-12">
            <div class="text-13-regular text-text-weak">{language.t("common.loading")}</div>
          </div>
        </Show>

        <Show when={orgFiles.error}>
          <div class="flex flex-col items-center justify-center py-12 gap-2">
            <div class="text-13-regular text-critical-base">{language.t("session.agenda.error")}</div>
            <button
              class="text-12-medium text-text-interactive-base hover:underline"
              onClick={() => refetch()}
            >
              {language.t("session.agenda.refresh")}
            </button>
          </div>
        </Show>

        <Show when={!orgFiles.loading && !orgFiles.error} keyed>
          <Switch>
            <Match when={view() === "today"}>
              <TodayView files={orgFiles.latest} language={language} />
            </Match>
            <Match when={view() === "todos"}>
              <TodosView files={orgFiles.latest} />
            </Match>
            <Match when={view() === "week"}>
              <WeekView files={orgFiles.latest} />
            </Match>
            <Match when={view() === "deadlines"}>
              <DeadlinesView files={orgFiles.latest} />
            </Match>
          </Switch>
        </Show>
      </div>
    </div>
  )
}