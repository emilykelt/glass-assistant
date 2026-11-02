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

// Local wall-clock time with offset (e.g. 2026-09-28T00:00:00+01:00), not UTC:
// all-day events serialised as "…T23:00:00Z" made the model mis-count days.
func iso(_ d: Date) -> String {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime]
  f.timeZone = TimeZone.current
  return f.string(from: d)
}

func weekday(_ d: Date) -> String {
  let f = DateFormatter()
  f.locale = Locale(identifier: "en_GB")
  f.dateFormat = "EEEE d MMM"
  return f.string(from: d)
}

// Compact event record shared by every command that returns events.
func eventDict(_ e: EKEvent) -> [String: Any] {
  var d: [String: Any] = [
    "id": e.eventIdentifier ?? "",
    "title": e.title ?? "",
    "startTime": iso(e.startDate),
    "endTime": iso(e.endDate),
    "day": weekday(e.startDate),
    "calendar": e.calendar.title,
  ]
  if e.isAllDay { d["allDay"] = true }
  if let loc = e.location, !loc.isEmpty { d["location"] = loc }
  return d
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
  emit(events.map(eventDict))

case "search-events":
  let p = Array(args.dropFirst())
  guard let query = p.first, !query.isEmpty else { die("usage: search-events query [days]") }
  let days = Int(p.dropFirst().first ?? "30") ?? 30
  guard waitAccess(.event) else { die("calendar access denied") }
  let cal = Calendar.current
  let start = cal.startOfDay(for: Date())
  guard let end = cal.date(byAdding: .day, value: days, to: start) else { die("date math failed") }
  let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
  let needle = query.lowercased()
  let matches = store.events(matching: predicate).filter {
    ($0.title ?? "").lowercased().contains(needle)
      || ($0.location ?? "").lowercased().contains(needle)
      || ($0.notes ?? "").lowercased().contains(needle)
  }
  emit(matches.map(eventDict))

case "calendars":
  // `detail` adds the backing account per calendar — which account owns a
  // calendar determines whether it is reachable off this machine.
  let detail = Array(args.dropFirst()).first == "detail"
  func sourceKind(_ t: EKSourceType) -> String {
    switch t {
    case .local: return "local"
    case .exchange: return "exchange"
    case .calDAV: return "caldav"
    case .mobileMe: return "icloud"
    case .subscribed: return "subscribed"
    case .birthdays: return "birthdays"
    @unknown default: return "other"
    }
  }
  var out: [String: Any] = ["calendars": [], "lists": []]
  if waitAccess(.event) {
    let cals = store.calendars(for: .event)
    out["calendars"] = detail
      ? cals.map { ["title": $0.title, "account": $0.source.title,
                    "kind": sourceKind($0.source.sourceType),
                    "writable": $0.allowsContentModifications] }
      : cals.map { $0.title }
  }
  if waitAccess(.reminder) {
    let lists = store.calendars(for: .reminder)
    out["lists"] = detail
      ? lists.map { ["title": $0.title, "account": $0.source.title,
                     "kind": sourceKind($0.source.sourceType),
                     "writable": $0.allowsContentModifications] }
      : lists.map { $0.title }
  }
  emit(out)

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
      "id": r.calendarItemIdentifier,
      "title": r.title ?? "",
      "dueDate": due,
      "list": r.calendar.title,
    ]
  }
  emit(arr)

case "complete-reminder":
  let p = Array(args.dropFirst())
  guard let target = p.first, !target.isEmpty else { die("usage: complete-reminder id|title") }
  guard waitAccess(.reminder) else { die("reminder access denied") }
  let predicate = store.predicateForIncompleteReminders(
    withDueDateStarting: nil, ending: nil, calendars: nil
  )
  let sem = DispatchSemaphore(value: 0)
  var rems: [EKReminder] = []
  store.fetchReminders(matching: predicate) { results in
    rems = results ?? []
    sem.signal()
  }
  sem.wait()

  // Prefer an exact identifier match; fall back to case-insensitive title.
  var candidates = rems.filter { $0.calendarItemIdentifier == target }
  if candidates.isEmpty {
    let needle = target.lowercased()
    candidates = rems.filter { ($0.title ?? "").lowercased() == needle }
  }
  if candidates.isEmpty {
    let needle = target.lowercased()
    candidates = rems.filter { ($0.title ?? "").lowercased().contains(needle) }
  }
  guard let match = candidates.first else { die("no incomplete reminder matching: \(target)") }
  if candidates.count > 1 {
    let titles = candidates.map { $0.title ?? "" }.joined(separator: " | ")
    die("ambiguous: \(candidates.count) reminders match \"\(target)\": \(titles)")
  }
  match.isCompleted = true
  do {
    try store.save(match, commit: true)
    emit(["ok": true, "title": match.title ?? "", "id": match.calendarItemIdentifier])
  } catch {
    die("save failed: \(error)")
  }

case "delete-event":
  let p = Array(args.dropFirst())
  guard let eventID = p.first, !eventID.isEmpty else { die("usage: delete-event eventId") }
  guard waitAccess(.event) else { die("calendar access denied") }
  guard let event = store.event(withIdentifier: eventID) else {
    die("event not found: \(eventID)")
  }
  let deletedTitle = event.title ?? ""
  do {
    try store.remove(event, span: .thisEvent, commit: true)
    emit(["ok": true, "title": deletedTitle])
  } catch {
    die("delete failed: \(error)")
  }

case "update-event":
  let p = Array(args.dropFirst())
  guard p.count >= 4 else { die("usage: update-event eventId startISO|'' endISO|'' title|''") }
  guard waitAccess(.event) else { die("calendar access denied") }
  guard let event = store.event(withIdentifier: p[0]) else { die("event not found: \(p[0])") }
  if !p[1].isEmpty {
    guard let s = parseISO(p[1]) else { die("bad start date: \(p[1])") }
    event.startDate = s
  }
  if !p[2].isEmpty {
    guard let en = parseISO(p[2]) else { die("bad end date: \(p[2])") }
    event.endDate = en
  }
  if !p[3].isEmpty { event.title = p[3] }
  guard event.endDate > event.startDate else { die("end date must be after start date") }
  do {
    try store.save(event, span: .thisEvent, commit: true)
    emit([
      "ok": true,
      "id": event.eventIdentifier ?? "",
      "title": event.title ?? "",
      "startTime": iso(event.startDate),
      "endTime": iso(event.endDate),
    ])
  } catch {
    die("save failed: \(error)")
  }

case "create-reminder":
  let p = Array(args.dropFirst())
  guard p.count >= 3 else { die("usage: create-reminder title dueISO|'' list") }
  guard waitAccess(.reminder) else { die("reminder access denied") }
  // Exact name, then case-insensitive, then the default list when the name is
  // empty or unknown (the model often guesses "Reminders"). Never fail on a name.
  let lists = store.calendars(for: .reminder)
  let wanted = p[2].trimmingCharacters(in: .whitespaces)
  let calendar = lists.first(where: { $0.title == wanted })
    ?? lists.first(where: { $0.title.lowercased() == wanted.lowercased() })
    ?? store.defaultCalendarForNewReminders()
    ?? lists.first
  guard let calendar = calendar else { die("no reminder lists available") }
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
