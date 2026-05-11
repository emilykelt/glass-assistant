import Foundation
import EventKit

let store = EKEventStore()

func waitAccess(_ entity: EKEntityType) -> Bool {
  let sem = DispatchSemaphore(value: 0)
  var ok = false
  if #available(macOS 14.0, *) {
    if entity == .event {
      store.requestFullAccessToEvents { granted, _ in
        ok = granted
        sem.signal()
      }
    } else {
      store.requestFullAccessToReminders { granted, _ in
        ok = granted
        sem.signal()
      }
    }
  } else {
    store.requestAccess(to: entity) { granted, _ in
      ok = granted
      sem.signal()
    }
  }
  sem.wait()
  return ok
}

func iso(_ d: Date) -> String {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime]
  return f.string(from: d)
}

func parseISO(_ s: String) -> Date? {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let d = f.date(from: s) { return d }
  f.formatOptions = [.withInternetDateTime]
  return f.date(from: s)
}

func emit(_ obj: Any) {
  let data = try! JSONSerialization.data(withJSONObject: obj, options: [])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func die(_ msg: String, _ code: Int32 = 1) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(code)
}

let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { die("usage: ekhelper <cmd> [args]") }

switch cmd {
case "today", "upcoming":
  let days: Int
  if cmd == "upcoming" {
    days = Int(args.dropFirst().first ?? "7") ?? 7
  } else {
    days = 1
  }
  guard waitAccess(.event) else { die("calendar access denied") }
  let cal = Calendar.current
  let start = cal.startOfDay(for: Date())
  guard let end = cal.date(byAdding: .day, value: days, to: start) else { die("date math failed") }
  let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
  let events = store.events(matching: predicate)
  let arr = events.map { e -> [String: Any] in
    return [
      "title": e.title ?? "",
      "startTime": iso(e.startDate),
      "endTime": iso(e.endDate),
      "calendar": e.calendar.title,
    ]
  }
  emit(arr)

case "create-event":
  let p = Array(args.dropFirst())
  guard p.count >= 4 else { die("usage: create-event title startISO endISO calendar") }
  guard waitAccess(.event) else { die("calendar access denied") }
  guard let s = parseISO(p[1]), let en = parseISO(p[2]) else { die("bad date") }
  guard let calendar = store.calendars(for: .event).first(where: { $0.title == p[3] }) else {
    die("calendar not found: \(p[3])")
  }
  let event = EKEvent(eventStore: store)
  event.title = p[0]
  event.startDate = s
  event.endDate = en
  event.calendar = calendar
  do {
    try store.save(event, span: .thisEvent, commit: true)
    emit(["ok": true, "id": event.eventIdentifier ?? ""])
  } catch {
    die("save failed: \(error)")
  }

case "reminders":
  guard waitAccess(.reminder) else { die("reminder access denied") }
  let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)
  let sem = DispatchSemaphore(value: 0)
  var rems: [EKReminder] = []
  store.fetchReminders(matching: predicate) { results in
    rems = results ?? []
    sem.signal()
  }
  sem.wait()
  let arr = rems.map { r -> [String: Any] in
    var due: String = ""
    if let dc = r.dueDateComponents, let d = Calendar.current.date(from: dc) {
      due = iso(d)
    }
    return [
      "title": r.title ?? "",
      "dueDate": due,
      "list": r.calendar.title,
    ]
  }
  emit(arr)

case "create-reminder":
  let p = Array(args.dropFirst())
  guard p.count >= 3 else { die("usage: create-reminder title dueISO|'' list") }
  guard waitAccess(.reminder) else { die("reminder access denied") }
  guard let calendar = store.calendars(for: .reminder).first(where: { $0.title == p[2] }) else {
    die("list not found: \(p[2])")
  }
  let r = EKReminder(eventStore: store)
  r.title = p[0]
  r.calendar = calendar
  if !p[1].isEmpty, let d = parseISO(p[1]) {
    r.dueDateComponents = Calendar.current.dateComponents(
      [.year, .month, .day, .hour, .minute], from: d
    )
  }
  do {
    try store.save(r, commit: true)
    emit(["ok": true])
  } catch {
    die("save failed: \(error)")
  }

default:
  die("unknown command: \(cmd)")
}
