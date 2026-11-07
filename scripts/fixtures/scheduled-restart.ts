// Run twice against one database file: "save" in the first process and "read" in the
// next, to show a scheduled send survives a restart with nothing held in memory.
import { createScheduledSend, getTask, listDueScheduledSends, listOpenScheduledSends } from "../../src/db.ts";

const mode = process.argv[2];
if (mode === "save") {
  const row = createScheduledSend({
    key: "restart-test",
    sendAt: "2020-01-01T04:30:00.000Z",
    itemText: "Send email to Kiran — Hello — Wed 1 Jan 10:00",
    tag: "work",
    request: "{}",
    confirmChat: 1,
    confirmMessage: 2,
  });
  console.log(row ? "saved" : "not saved");
} else {
  const open = listOpenScheduledSends();
  const due = listDueScheduledSends(new Date().toISOString(), 3);
  const task = open[0] ? getTask(open[0].task_id) : undefined;
  console.log(open.length === 1 && due.length === 1 && task?.status === "open" ? "survived" : "lost");
}
process.exit(0);
