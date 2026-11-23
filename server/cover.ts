// Which students a sponsor wallet can fully cover, choosing the most students:
// taking the smallest dues first fits the largest number into any balance.
// Shared by the server and the browser.
export function coverMost<T extends { outstanding: number }>(
  students: T[],
  balance: number,
): T[] {
  const chosen: T[] = [];
  let left = balance;
  for (const s of [...students].sort((a, b) => a.outstanding - b.outstanding)) {
    if (s.outstanding <= 0) continue;
    if (s.outstanding > left) break;
    chosen.push(s);
    left -= s.outstanding;
  }
  return chosen;
}
