const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Next billing cycle: same day next month, clamped to that month's last day. */
export function addOneMonthYmd(ymd: string): string {
  const match = DATE_RE.exec(ymd);
  if (!match) {
    throw new Error(`Invalid due_date on bill: ${ymd}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const daysInNextMonth = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
  const nextDay = Math.min(day, daysInNextMonth);
  return `${nextYear.toString().padStart(4, "0")}-${nextMonth
    .toString()
    .padStart(2, "0")}-${nextDay.toString().padStart(2, "0")}`;
}
