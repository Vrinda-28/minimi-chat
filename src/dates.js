const months = 'january february march april may june july august september october november december'.split(' ');
const weekdays = 'sunday monday tuesday wednesday thursday friday saturday'.split(' ');
const monthPattern = months.map(month => `${month}|${month.slice(0, 3)}\\.?`).join('|');
const dayPattern = '(\\d{1,2})(?:st|nd|rd|th)?';

export function validZone(value) {
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value || 'UTC' }).resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

export function localDay(timestamp, zone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(timestamp);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type).value).join('-');
}

export function resolveDays(question, now, zone) {
  const today = localDay(now, zone);
  // UTC here is a calendar arithmetic container for the user's local date.
  const calendar = new Date(today + 'T00:00:00Z');
  const year = calendar.getUTCFullYear();
  const dates = new Set();
  const add = (y, month, day) => {
    if (y < 1000 || y > 9999) return;
    const date = new Date(Date.UTC(y, month - 1, day));
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return;
    dates.add(date.toISOString().slice(0, 10));
  };
  const shift = days => {
    const date = new Date(calendar);
    date.setUTCDate(date.getUTCDate() + days);
    dates.add(date.toISOString().slice(0, 10));
  };

  for (const match of question.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    add(...match.slice(1).map(Number));
  }
  const named = [
    [new RegExp(`\\b${dayPattern}\\s+(${monthPattern})(?:,?\\s+(\\d{4}))?\\b`, 'gi'), false],
    [new RegExp(`\\b(${monthPattern})\\s+${dayPattern}(?:,?\\s+(\\d{4}))?\\b`, 'gi'), true],
  ];
  for (const [pattern, monthFirst] of named) {
    for (const match of question.matchAll(pattern)) {
      const [day, name] = monthFirst ? [match[2], match[1]] : [match[1], match[2]];
      const month = months.findIndex(value => value.startsWith(name.toLowerCase().slice(0, 3))) + 1;
      // Yearless dates refer to the most recent occurrence in conversation.
      if (match[3]) add(Number(match[3]), month, Number(day));
      else {
        for (let candidate = year; candidate >= year - 8; candidate--) {
          const date = new Date(Date.UTC(candidate, month - 1, Number(day)));
          if (date > calendar || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== Number(day)) continue;
          add(candidate, month, Number(day));
          break;
        }
      }
    }
  }
  for (const match of question.matchAll(/\b(day before yesterday|yesterday|today|(\d{1,3}) days? ago)\b/gi)) {
    const phrase = match[1].toLowerCase();
    shift(match[2] ? -Number(match[2]) : { today: 0, yesterday: -1, 'day before yesterday': -2 }[phrase]);
  }
  for (const match of question.matchAll(/\b(?:(last|this)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi)) {
    const modifier = match[1]?.toLowerCase();
    const weekday = weekdays.indexOf(match[2].toLowerCase());
    const current = calendar.getUTCDay();
    // Unqualified weekdays mean the most recent occurrence. "Last" means the prior ISO week.
    const fromMonday = value => (value + 6) % 7;
    const offset = fromMonday(weekday) - fromMonday(current);
    shift(modifier === 'last' ? offset - 7 : modifier === 'this' ? offset : (weekday - current - 7) % 7);
  }
  return [...dates].slice(0, 8);
}
