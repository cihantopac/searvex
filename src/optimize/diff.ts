/**
 * Line-based Myers diff (O((N+M)·D)) producing unified-diff hunks for change previews.
 */
type Op = { t: ' ' | '-' | '+'; line: string };

function myers(a: string[], b: string[]): Op[] {
  const n = a.length, m = b.length, max = n + m;
  const v = new Map<number, number>([[1, 0]]);
  const trace: Array<Map<number, number>> = [];
  for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0)) ? v.get(k + 1) ?? 0 : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= n && y >= m) return backtrack(trace, a, b, d);
    }
  }
  return [];
}

function backtrack(trace: Array<Map<number, number>>, a: string[], b: string[], dEnd: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0)) ? k + 1 : k - 1;
    const prevX = v.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ t: ' ', line: a[x]! });
    }
    if (x === prevX) {
      y--;
      ops.push({ t: '+', line: b[y]! });
    } else {
      x--;
      ops.push({ t: '-', line: a[x]! });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ t: ' ', line: a[x]! });
  }
  return ops.reverse();
}

export function unifiedDiff(file: string, before: string | null, after: string, context = 3): string {
  const a = before === null ? [] : before.split('\n');
  const b = after.split('\n');
  const ops = myers(a, b);
  const out = [`--- ${before === null ? '/dev/null' : 'a/' + file}`, `+++ b/${file}`];
  let i = 0, ai = 0, bi = 0;
  while (i < ops.length) {
    if (ops[i]!.t === ' ') {
      i++;
      ai++;
      bi++;
      continue;
    }
    const start = Math.max(0, i - context);
    let end = i;
    let lastChange = i;
    while (end < ops.length && (ops[end]!.t !== ' ' || end - lastChange <= context * 2)) {
      if (ops[end]!.t !== ' ') lastChange = end;
      end++;
    }
    end = Math.min(ops.length, lastChange + context + 1);
    const lead = i - start;
    const hunk = ops.slice(start, end);
    const aStart = ai - lead, bStart = bi - lead;
    const aLen = hunk.filter((o) => o.t !== '+').length, bLen = hunk.filter((o) => o.t !== '-').length;
    out.push(`@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@`);
    for (const o of hunk) out.push(o.t + o.line);
    for (let j = i; j < end; j++) {
      if (ops[j]!.t !== '+') ai++;
      if (ops[j]!.t !== '-') bi++;
    }
    i = end;
  }
  return out.join('\n');
}
