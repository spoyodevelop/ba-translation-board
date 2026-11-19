const oneDayMs = 24 * 60 * 60 * 1000;

export function formatPostTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  if (Date.now() - date.getTime() < oneDayMs) {
    return new Intl.DateTimeFormat("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
  }
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return date.getFullYear() === new Date().getFullYear()
    ? `${month}.${day}`
    : `${date.getFullYear()}.${month}.${day}`;
}
