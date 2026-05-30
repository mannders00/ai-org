import { createEffect, createMemo, For, on, Show } from "solid-js"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { shouldListRoot, shouldListExpanded } from "@/components/file-tree"

type Entry = { name: string; path: string; type: "file" | "directory" }

function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function DirectoryNode(props: { entry: Entry; depth: number; onFileClick: (path: string) => void }) {
  const file = useFile()

  const state = createMemo(() => file.tree.state(props.entry.path))
  const expanded = createMemo(() => state()?.expanded ?? false)

  const sortedChildren = createMemo(() => {
    const c = file.tree.children(props.entry.path)
    if (!c) return [] as Entry[]
    return sortEntries(c.map((n) => ({ name: n.name, path: n.path, type: n.type as "file" | "directory" })))
  })

  createEffect(
    on(
      () => shouldListExpanded({ level: props.depth + 1, dir: state() }),
      (should) => {
        if (should) file.tree.expand(props.entry.path)
      },
    ),
  )

  const toggle = () => {
    if (expanded()) file.tree.collapse(props.entry.path)
    else file.tree.expand(props.entry.path)
  }

  return (
    <Collapsible open={expanded()} onOpenChange={() => toggle()}>
      <button
        onClick={toggle}
        class="flex items-center gap-1.5 w-full text-left hover:bg-background-weak rounded-sm transition-colors group"
        style={{ "padding-left": `${props.depth * 12 + 8}px`, "padding-right": "8px", "padding-top": "4px", "padding-bottom": "4px" }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class={`shrink-0 text-text-weak transition-transform duration-150 ${expanded() ? "rotate-90" : ""}`}
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
        <FileIcon node={{ path: props.entry.path, type: "directory" }} expanded={expanded()} class="shrink-0 w-3.5 h-3.5" />
        <span class="text-13-regular text-text-base truncate">{props.entry.name}</span>
        <Show when={state()?.loading}>
          <span class="text-10-regular text-text-weak/40 ml-auto">…</span>
        </Show>
      </button>
      <Collapsible.Content>
        <Show when={expanded()}>
          <For each={sortedChildren()}>
            {(child) => (
              <TreeNode entry={child} depth={props.depth + 1} onFileClick={props.onFileClick} />
            )}
          </For>
        </Show>
      </Collapsible.Content>
    </Collapsible>
  )
}

function FileNode(props: { entry: Entry; depth: number; onFileClick: (path: string) => void }) {
  return (
    <button
      onClick={() => props.onFileClick(props.entry.path)}
      class="flex items-center gap-1.5 w-full text-left hover:bg-background-weak rounded-sm transition-colors"
      style={{ "padding-left": `${props.depth * 12 + 8}px`, "padding-right": "8px", "padding-top": "3px", "padding-bottom": "3px" }}
    >
      <FileIcon node={{ path: props.entry.path, type: "file" }} class="shrink-0 w-3.5 h-3.5" />
      <span class="text-13-regular text-text-base truncate">{props.entry.name}</span>
    </button>
  )
}

function TreeNode(props: { entry: Entry; depth: number; onFileClick: (path: string) => void }) {
  return (
    <>
      {props.entry.type === "directory" ? (
        <DirectoryNode entry={props.entry} depth={props.depth} onFileClick={props.onFileClick} />
      ) : (
        <FileNode entry={props.entry} depth={props.depth} onFileClick={props.onFileClick} />
      )}
    </>
  )
}

export function SessionFilesTab(props: { onFileClick: (path: string) => void }) {
  const file = useFile()
  const language = useLanguage()

  createEffect(
    on(
      () => shouldListRoot({ level: 0, dir: file.tree.state("") }),
      (should) => {
        if (should) file.tree.list("")
      },
    ),
  )

  const roots = createMemo(() => {
    const c = file.tree.children("")
    if (!c) return [] as Entry[]
    return sortEntries(c.map((n) => ({ name: n.name, path: n.path, type: n.type as "file" | "directory" })))
  })

  const loaded = createMemo(() => {
    const s = file.tree.state("")
    return s?.loaded ?? false
  })

  return (
    <div class="flex flex-col h-full overflow-hidden">
      <Show when={!loaded()}>
        <div class="flex items-center justify-center py-12 text-13-regular text-text-weak/30">
          {language.t("common.loading")}{language.t("common.loading.ellipsis")}
        </div>
      </Show>
      <Show when={loaded() && roots().length === 0}>
        <div class="flex items-center justify-center py-12 text-13-regular text-text-weak/30">
          {language.t("session.files.empty")}
        </div>
      </Show>
      <Show when={loaded() && roots().length > 0}>
        <div class="flex-1 overflow-y-auto min-h-0 pt-1 pb-4">
          <For each={roots()}>
            {(entry) => <TreeNode entry={entry} depth={0} onFileClick={props.onFileClick} />}
          </For>
        </div>
      </Show>
    </div>
  )
}