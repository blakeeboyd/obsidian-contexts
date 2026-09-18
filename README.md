# Episodic

**Memory for your vault: records your actions in Obsidian to see the evolution of thought in your vault.**

Episodic records which notes you work in, when, for how long, what changed, and what was open alongside. It shows that record back to you as a trail, a map of your movement, and a set of threads of work it calls contexts.

The vault already knows what your notes say. Episodic records what you did with them. The name is Endel Tulving's: semantic memory is what you know, episodic memory is what you experienced, located in time and place. A vault is semantic memory; this is the other half. The icon is a seahorse, because the hippocampus, the structure that forms episodic memories, is named for one.

**Status: beta.** Read the next section before installing. This plugin writes a log of your activity into your vault.

## What it records, and where

Everything goes into one folder in your vault, `Episodic Log/` by default, as plain JSONL text files: one file per device per month (for example `850nr6-2026-09.jsonl`). The log is append-only. Every view in the plugin is computed from it at read time, so nothing else is stored, and deleting the folder deletes the record.

What lands in the log:

- **Visits.** Which note was in front of you, when it became active, how long it stayed active, how you got there (a followed link, the quick switcher, the file explorer, the map), how you left (switched note, closed the tab, left the app, went idle), and which heading section the cursor was in when you left.
- **Edits, as summaries.** While a note is active the plugin snapshots it on arrival and departure and logs the difference: net words, links and embeds added or removed, tags, headings, tasks added or completed, and so on. Short captured strings (a highlight, a footnote, a task line) are cut at 120 characters. The log never holds the body of a note.
- **Link previews.** A link read through its hover popover without being opened.
- **File events.** Creations, renames, deletions, and edits made while a note was not active (sync, scripts, an AI writing through a tool). A file created by the Obsidian Web Clipper is labeled as such.
- **Your declarations.** Which context you said you were working in, renames, corrections.

What never lands in the log: keystrokes, note contents, anything outside Obsidian, and, while the veil is on, nothing you can see (more on that below).

You control the capture:

| Control | Where | What it does |
|---|---|---|
| Capture toggles | Settings | Each signal (words, links, tags, headings, highlights, tasks, hovers, external edits...) can be switched off. Off means the work is skipped: nothing is recorded, nothing shown. |
| Pause | Settings, command | Stops logging entirely. Paused time does not exist in the record. |
| Veil | Context picker, settings | Keeps recording but hides everything recorded while veiled from every view. The log keeps it; the views never show it. |
| Excluded folders and files | Settings, Manage... | Still recorded and still shown in their own trail, but they join no context and no relatedness score. The privacy line for relations. |
| Bridge folders and files | Settings, Manage... | Daily notes, inboxes: they inherit every context they are visited under, and opening one never switches your context. |

## Install

Episodic is distributed through [BRAT](https://github.com/TfTHacker/obsidian42-brat) during the beta.

1. Install and enable BRAT from Community plugins.
2. In BRAT settings, choose "Add beta plugin" and enter `blakeeboyd/obsidian-episodic`.
3. Enable Episodic in Community plugins.

To use it on more than one device, turn on **Sync all other types** in Obsidian Sync's settings on every device. Without it the `.jsonl` log files stay on the device that wrote them.

## Contexts: the model

A **context** is a thread of work you name by declaring it. It is not a folder or a tag. A note belongs to every context it has been visited under, weighted by how long you spent there, so a note can live in several contexts at once, and its context history is a record of what it has meant to you.

**Declaring.** Tap the context chip in a note's header (or the compass line in the sidebar pane, or run *Declare context*) and pick a context, type a new name, or take **+ new context** to mint an anonymous one ("context 4"). Naming is optional. An anonymous context shows a derived label built from its most-engaged notes, and renaming it later pins whatever name you choose.

**How a switch applies.** A declaration is forward-looking. Visits that ended before it keep the context they had. One deliberate reach-back: declaring while a note is open claims that note's current sitting from its opening, because you usually open a note, realize what thread you are in, and then declare. Nothing older moves.

**Sigils.** Every context gets a one- or two-character glyph. Until you pick one it wears a placeholder from a starter set; the rename dialog has a picker for symbols, recent emoji, or anything from the OS emoji keyboard. Sigils show on the chip, in the picker, on the map, and in the rail.

**Corrections.** Right-click a stint in the pane's trail, a node on the map, or a row in a node's detail panel to move those visits to another context, remove the file from a context for good (evict), unassign them, or delete the visits from the record. Deletion is read-time: the log keeps the lines under a tombstone, and removing the tombstone line restores them.

**Merging.** Renaming a context onto an existing name merges the two.

## Views

### The sidebar pane

Open with *Open pane* or the ribbon icon. At the top: the declared context and a quiet guess ("Working in ▲ grant?") when the plugin recognizes a return to a known thread; click to confirm. Below, for the note in front of you: the threads it belongs to, notes related to it now (ranked by shared sessions, decayed over time, with a dismiss button that never deletes, only reweights), and its trail: every visit, expandable to the edits made in each. With no note open, the pane shows the files active today and recent sessions.

### The File Map

Open with *Open file map*. One tree per day (or session, week, or month), rooted at the first note of the sitting; children are the notes you went to from there, and the arrow style says whether you followed a link or just went next. Node fill deepens with engaged time. Bold means you edited it.

| Control | What it does |
|---|---|
| Rail toggle (far left) | Shows or hides the context rail. |
| Scope chip | This session, today, a date range, or all time. |
| Zoom, fit | Or ⌘-scroll to zoom and drag to pan. |
| Order menu | Tree grain (session, day, week, month), engagement wash, compact read-only visits, device filter, newest or oldest first. |

The **rail** lists every context as a row: sigil, color, name, a compass on the declared context, a glint on the plugin's guess, and engaged time in the current scope. Rows sort by recency and fade with inactivity. Click a row to solo it (the map shows only that context's movement, with a ⋯ badge where you left the context and came back), shift-click to add rows to the solo set, ⌘-click or click the soloed row again to see everything. Right-click a row to declare it, rename it or set its sigil, or merge it into another. The **+ New context** button mints an anonymous context.

Click a node for its detail panel: memberships, stats, and every tie to other nodes. ⌘-click opens the note.

### The `episodic` code block

Embed a live view in any note. The block is a query, not a snapshot: it re-renders as events land, and it never writes to the note.

````
```episodic
view: map
over: week
```
````

| Property | Values | Default |
|---|---|---|
| `view` | `list`, `map` | `list` |
| `over` | `session`, `today`, `yesterday`, `week`, `month`, `all`, a date (`2026-09-14`), or a range (`2026-09-01..2026-09-14`) | the note's day, if its filename carries a date; otherwise today |
| `context` | one or more context names, comma-separated; `none` for unassigned visits | all |
| `device` | device names from settings, or raw ids | all |
| `group` | `session`, `day`, `week`, `month` | one step below `over`: today gives session trees, week gives day trees, month gives week trees, all gives month trees |

A bare block in a daily note shows that day forever. The list view is the day's sessions and files; the map view draws the same forest as the File Map, newest at the top, with drag to pan, ⌘-scroll to zoom, double-click to fit, zoom buttons, a resize handle on the bottom edge (the height is remembered), and a corner button to open the full File Map. The older `norn`, `muninn`, `contexts`, and `contexts-day` block languages still work.

### The note header chip

On the phone the sidebar is out of reach, so the declared context also sits in each note's header row beside the reading-mode toggle: tap to switch. It reads *Excluded* for a note in an excluded folder, and while the veil is on it becomes a filled *Veiled* pill in your accent color; tapping that lifts the veil. Settings choose where the chip appears: off, mobile only, or everywhere (the default).

## The veil

Sometimes you want the record kept but not looked at. Pick **veil** in the context picker. From that moment visits, previews, creations, and notes are stamped and hidden from every view: the trail, the map, the code blocks, the history, the relatedness scores. Context switching is shut while veiled (a declaration is a visible, timestamped act). The chip and the pane both show *Veiled*; tap either to lift. A setting decides whether the veil stays until you lift it, lifts when the sitting ends (idle or restart), or lifts on restart.

The veil is a read-time filter over flagged events. The log underneath stays complete.

## Multiple devices

Each device writes its own log file. The views merge them into one history and tag each event with the device it came from. A visit from the phone says so in the trail, and the map can filter by device. Name your devices in settings. Requires Sync's "all other types" toggle on every device, as above.

## Settings, briefly

| Setting | Meaning |
|---|---|
| Idle timeout | Minutes without input before the open visit closes, back-dated to your last activity. |
| Session gap | Minutes of silence that separate one session from the next. Read-time: change it and history regroups. |
| Half-life | How fast relatedness and the context guess forget. Also read-time. |
| Log folder | Where the shards live. Changing it moves them. |
| Device names | Human names for device ids. |
| Context chip | Off, mobile only, all devices. |
| Veil, and when it lifts | See above. |
| Excluded, Bridge | Manage... opens a list that takes folders and single notes. |
| Capture | One toggle per signal. |

## Known gaps in this beta

- iOS lifecycle (the app suspending rather than losing focus) is lightly tested; phone visit durations may need a look.
- The braid view (a timeline of contexts as bands) exists in the code but has no command for now.
- Web Clipper attribution is a heuristic (a file born full with a source URL in its frontmatter); template-created notes could be mislabeled.
- Attribution of edits made by AI tools depends on the tool announcing itself; unannounced writers show as anonymous external edits.

## Development

```
npm install
npx tsc --noEmit        # typecheck
npm test                # vitest
npm run deploy          # build and copy into $EPISODIC_VAULT/.obsidian/plugins/episodic
```

`docs/log-format.md` documents the event schema for anyone reading the log files directly.

## Credits

Seahorse icon by Andre Buand, from [the Noun Project](https://thenounproject.com/icon/seahorse-6448301/) (CC BY 3.0).
