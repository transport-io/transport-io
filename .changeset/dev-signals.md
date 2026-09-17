---
'transport-io': patch
---

`transport-io dev <entry>` no longer leaves the entry running when the command is stopped by
a signal sent to it alone, `kill <pid>` or `ChildProcess.kill()` from a script. The command
installed no signal handler, so it ended and the entry kept its WebTransport UDP port, and
the next run reported `WT_PORT_IN_USE`. Ctrl-C never showed it, because a terminal signals
the whole foreground process group. SIGTERM, SIGINT and SIGHUP are now passed to the entry,
and the command exits once the entry has: with the entry's code, by the same signal when the
entry died of one of those three, and with 128 plus the signal number for any other, where
it used to exit 0. An entry is also sent SIGTERM when the command exits for any other
reason. On Ctrl-C the entry receives SIGINT from the terminal and from the command, so a
SIGINT handler in it runs twice. SIGKILL cannot be passed on, and a command killed with it
still leaves the entry behind.
