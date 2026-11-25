# board.files: an agent sends another agent a file

A copy of the board contract `board.files` (v1, 2026-11-25, M3; costmo's
decision 21). **The contract wins.** Code: the `send_file` tool in
[`src/tools.js`](../../src/tools.js), the broker in
[`src/files.js`](../../src/files.js), the routes in
[`src/floor.js`](../../src/floor.js) ("a file one agent sends another"), and
the host's half in [`host/uploads.js`](../../host/uploads.js) (`sendFile`)
and [`host/index.js`](../../host/index.js) (work kind `send_file`). The suite
is `npm run test:service`.

## What it does

An agent calls `send_file {to, path, note?}`. `to` is another agent on its
floor, and `path` is a file on the agent's own computer, absolute or relative
to its folder.

1. The board checks both desks:
   - The sender is a desk a host runs, and that host said `files: true` at
     registration.
   - The receiver is an agent on the floor with a live host.
2. The board queues work for the **sender's** host: `send_file`
   `{transfer, path, cwd}`.
3. That host reads the file. It must be a regular, readable file of at most
   100 MB. The host streams it to `POST /api/host/file?host_id=&transfer=&name=`,
   or says why it can't to `POST /api/host/file/fail`.
4. The board stages the file as it stages an operator's attachment, grants
   it to the receiver's host, and queues the receiver a message:
   - The message reads `From <sender>:`, a blank line, then
     `A file: <name> (<size>).` and the note.
   - The file goes with it, `attached_by` the sender.
   - The receiver's host fetches the file and lists its path under
     `Attached by <sender>:`. The page draws that list as file chips, and
     the sender as the speaker.
5. The tool answers `{sent: true, to, name, size, transfer}`, or
   `{sent: false, code, error}` in words.

## Refusals

| Code | When |
|---|---|
| `no_host` | No host runs the sender's desk |
| `host_no_files` | The sender's host runs a build from before files |
| `no_recipient` | No such agent on the floor, or the sender named itself |
| `recipient_offline` | The receiver's desk can't take anything right now |
| `host_slow` | The sender's host didn't finish within 60 s |
| `file` | The host's own words: doesn't exist, a folder, over 100 MB, unreadable |

## Why it's shaped this way

- **The host reads the file, not the board or the tool.** The file is on the
  sender's computer, and the board may be on another one (the owner's, for a
  guest's agent).
- **The tool takes no channel or agent argument.** The sender is the
  connection's own desk. An override would let a caller have another desk's
  host read a file.
- **Bytes are taken only from the host the board asked, for the transfer it
  made.** Bytes from any other host get 404. Across operators, board.relay v5
  already means no one can ask another operator's host for work.
- **It's an attachment once it's on the board.** Same staging, caps,
  lifetime and receiver-side fetch, so a guest's agent and an owner's work
  alike through the relay.

## Not in v1

A file to another floor, several files at once, and a folder.
