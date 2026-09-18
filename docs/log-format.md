# The log format

One folder in the vault (`Muninn Log/` by default; vaults set up before the rename keep `Contexts Log/`), one file per device per month, named `{deviceId}-{YYYY-MM}.jsonl`. Each line is one JSON event. Files are append-only; the plugin never rewrites a line. Every view is derived from these files at read time, so the shape below is the only persisted state the plugin has.

Timestamps (`t`, `start`, `from`, `to`, `covers`, `ctime`) are milliseconds since the epoch. Paths are vault-relative.

The authoritative shapes are the interfaces in `src/recorder.ts`; this page is the reader's guide.

## Two things that never appear in a line

**`device`.** Which device wrote an event is the file's name, not a field. The reader tags every event with its shard's device id when it loads; the writer strips the field on append.

**Read-time derivations.** Which context a visit belongs to, which session it falls in, how related two notes are: none of that is stored. Change a setting (session gap, half-life) and history regroups.

## Visits (spans)

A visit has no `type` field; it is the one event shape without one.

| Field | Meaning |
|---|---|
| `t` | When the visit ended. |
| `path` | The note. |
| `start` | When it became active. |
| `dur` | Engaged milliseconds (`t - start`, minus nothing; idle closes back-date `t`). |
| `ctime` | The file's creation time. The identity anchor for healing renames made outside Obsidian: when visits at one path stop and visits at another path with the same `ctime` begin, that boundary is a rename. |
| `from` | The note this one was opened from by following a link. Absent when opened some other way. |
| `via` | How it was opened: `link`, `switcher`, `explorer`, `search`, `backlink`, `map`, `braid`... Absent for untracked surfaces. |
| `left` | How it ended: `switch` (went to another note), `close`, `blur` (left the app), `idle`, `quit`, `pause`. |
| `section` | The heading section the cursor was in when the visit ended. |
| `edit` | An edit delta (below), present only when something changed. |

### The edit delta

Present fields only; an absent field means no change in that signal.

| Field | Meaning |
|---|---|
| `words` | Net words. |
| `linksAdded`, `linksRemoved`, `embedsAdded`, `embedsRemoved` | Wikilink targets, subpaths kept (`Note#Heading`, `Note#^block`). |
| `tagsAdded`, `tagsRemoved` | Inline and frontmatter tags, `#`-prefixed. |
| `headingsAdded`, `headingsRemoved`, `headingsChanged` | Heading text; `headingsChanged: true` alone means a reorder. |
| `highlightsAdded`, `highlightsRemoved`, `footnotesAdded`, `footnotesRemoved`, `calloutsAdded`, `calloutsRemoved`, `commentsAdded`, `commentsRemoved`, `struckAdded`, `struckRemoved` | Captured text, cut at 120 characters. |
| `tasksAdded`, `tasksCompleted`, `tasksReopened`, `tasksRemoved` | Task lines. |
| `urlsAdded`, `urlsRemoved` | External URLs. |
| `blockIdsAdded`, `blockIdsRemoved` | `^block-ids`. |
| `codeLangsAdded`, `codeLangsRemoved`, `codeBlocks`, `math`, `tables`, `bold`, `italic` | Net counts or language lists. |
| `fmChanged` | Frontmatter keys with `[before, after]` values (`null` = absent). |

Stint summaries in the views merge several visits' deltas and add `wordsAdded` / `wordsRemoved` (gross movement); those two never appear in the log.

## Structural events

| `type` | Fields | Meaning |
|---|---|---|
| `firstseen` | `path`, `ctime`, `counts` (`words`, `links`, `tags`, `headings`, ...), `links` | The baseline captured at first contact with a file, so later deltas have something to diff against. One per file per life; a `create` after a `delete` allows a fresh one. |
| `create` | `path`, `by` | A file was created. `by` names the writer when known: an announced plugin (`vault-mcp`), or `clipper` for a file born full with a source URL in its frontmatter. Absent = the user, or an unannounced writer. |
| `rename` | `from`, `to` | Logged renames. Read-time rename healing synthesizes the ones made outside Obsidian from `ctime`. |
| `delete` | `path` | |
| `extmod` | `path`, `by`, `edit` | The file changed while not active in the editor: sync, a script, an AI tool. `edit` is a delta against the last known state when computable. |
| `peek` | `path`, `from` | A link previewed through its hover popover without being opened. `from` is the note the link sits in. |

## Declarations and corrections

| `type` | Fields | Meaning |
|---|---|---|
| `context` | `name`, `via`, `covers` | The user declared a context (`name: ""` clears). `via: "guess"` = a confirmed guess; `via: "auto"` = the home-context pull on opening a file. `covers` = an earlier instant this declaration also claims (a manual declaration made while a note is open covers back to that note's opening). Visits are assigned to the declaration in force as of their end. |
| `relabel` | `from`, `to` | A context was renamed. Applied at read time through the whole history; renaming onto an existing name merges the two. |
| `sigil` | `name`, `sigil` | A context's glyph. Rides the same identity pass as renames, so it follows the context through relabels. Empty `sigil` unpins. |
| `evict` | `name`, `path` | The file does not belong to this context, whatever the visits say. All of the file's visits there, past and future, unassign. |
| `reassign` | `path`, `name`, `from`, `to` | This file's visits in this time range belong to `name` (`""` = none). The most specific correction; applied after declarations and evictions. |
| `erase` | `path`, `from`, `to` | Read-time deletion of this file's visits in the range. Remove the line to restore them. |
| `note` | `text`, `path`, `by` | A waypoint: a note-to-self deposited on the trail. `path` is the note in front of the user; the context is derived at read time. `by` is reserved for non-human authors. |
| `relate`, `unrelate` | `a`, `b` | Feedback on a pair: `unrelate` reweights the pair's score near zero (never deletes); `relate` restores. |

## The veil

Any behavioral event (visit, `peek`, `create`, `note`) may carry `"veiled": true`. It was written while the veil was on. The reader drops these before any view sees them; the writer never omits them. Structural events are never stamped.

## Reading the log yourself

Every line parses as JSON on its own. To rebuild what the plugin shows, the order of read-time passes is: heal renames from `ctime`, apply renames, drop veiled and erased events (and duplicate baselines from sync lag), then filter excluded folders for anything that relates notes to each other. `src/views.ts` is the reference implementation, and every function there is pure.
