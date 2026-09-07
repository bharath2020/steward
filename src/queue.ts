export interface QueueWorkItem {
  nodeId: string;
  group?: string;
  nodeMaxParallelism?: number;
}

function ownCount(counts: Readonly<Record<string, number>>, key: string): number {
  return Object.hasOwn(counts, key) ? counts[key] : 0;
}

function ownLimit(limits: Readonly<Record<string, number>>, key: string, fallback: number): number {
  return Object.hasOwn(limits, key) ? limits[key] : fallback;
}

export function takeQueueWork<T extends QueueWorkItem>(
  work: readonly T[],
  availableSlots: number,
  groupLimits: Readonly<Record<string, number>>,
  activeGroupCounts: Readonly<Record<string, number>> = {},
  activeNodeCounts: Readonly<Record<string, number>> = {},
): { selected: T[]; remaining: T[] } {
  const remaining = [...work];
  const selected: T[] = [];
  const groupCounts = { ...activeGroupCounts };
  const nodeCounts = { ...activeNodeCounts };

  for (let index = 0; index < remaining.length && selected.length < availableSlots;) {
    const item = remaining[index];
    const groupKey = item.group ?? "__ungrouped";
    const groupLimit = item.group ? ownLimit(groupLimits, item.group, availableSlots) : Number.MAX_SAFE_INTEGER;
    const nodeLimit = item.nodeMaxParallelism ?? Number.MAX_SAFE_INTEGER;
    if (ownCount(groupCounts, groupKey) < groupLimit && ownCount(nodeCounts, item.nodeId) < nodeLimit) {
      groupCounts[groupKey] = ownCount(groupCounts, groupKey) + 1;
      nodeCounts[item.nodeId] = ownCount(nodeCounts, item.nodeId) + 1;
      selected.push(item);
      remaining.splice(index, 1);
    } else {
      index += 1;
    }
  }

  return { selected, remaining };
}

/**
 * Deterministically drains ordered work into bounded batches. A later item may
 * fill capacity when an earlier item's group or node-local queue is saturated.
 */
export function queueBatches<T extends QueueWorkItem>(
  work: readonly T[],
  globalMaxParallelism: number,
  groupLimits: Readonly<Record<string, number>>,
): T[][] {
  const remaining = [...work];
  const batches: T[][] = [];

  while (remaining.length > 0) {
    const next = takeQueueWork(remaining, globalMaxParallelism, groupLimits);
    const batch = next.selected;
    remaining.splice(0, remaining.length, ...next.remaining);

    if (batch.length === 0) throw new Error("Concurrency limits blocked every queued item");
    batches.push(batch);
  }

  return batches;
}
