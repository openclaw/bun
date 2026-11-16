// Inserted only into the reviewed temporary test projection; no live object is retained here.
export function invitationSnapshotAddress(description: string): bigint | undefined {
  // Same first hex match as the Bun Heap helper, without retaining RegExp.input.
  for (let start = description.indexOf("0x"); start >= 0; start = description.indexOf("0x", start + 2)) {
    let end = start + 2;
    while (end < description.length && "0123456789abcdefABCDEF".includes(description[end]!)) end++;
    if (end === start + 2) continue;
    try {
      const value = BigInt(description.slice(start, end));
      return value > 0n && value <= 0xffffffffffffffffn ? value : undefined;
    } catch {
      return;
    }
  }
}

export function invitationRetainerSnapshot(input: unknown, address: bigint | undefined) {
  const result: Record<string, unknown> = {
    version: 1,
    kind: "commit-retainer-snapshot",
    complete: false,
    diagnosticOnly: true,
    qualifiesRepin: false,
    limitations: [
      "debug snapshot performs an extra full GC after the original queryObjects",
      "address capture and snapshot allocation perturb layout and roots; address reuse remains possible",
      "reported edges and roots do not establish strong retention; weak-edge semantics unverified",
      "absence of a reported path does not identify a conservative stack root or prove collection",
      "one shortest reported path per reached root; alternate paths are not enumerated",
      "full snapshot memory is allocated before parser and output bounds apply",
    ],
  };
  try {
    if (!input || typeof input !== "object") throw new Error();
    const snapshot = input as Record<string, unknown>;
    const array = (value: unknown): unknown[] => {
      if (!Array.isArray(value)) throw new Error();
      return value;
    };
    const integer = (value: unknown): number => {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error();
      return value;
    };
    const stringAt = (values: unknown[], index: unknown): string => {
      const value = values[integer(index)];
      if (typeof value !== "string") throw new Error();
      return value;
    };
    const nodes = array(snapshot.nodes),
      edges = array(snapshot.edges),
      roots = array(snapshot.roots);
    const classes = array(snapshot.nodeClassNames),
      labels = array(snapshot.labels);
    const types = array(snapshot.edgeTypes),
      names = array(snapshot.edgeNames);
    if (
      snapshot.version !== 3 ||
      snapshot.type !== "GCDebugging" ||
      nodes.length % 7 ||
      edges.length % 4 ||
      roots.length % 3
    )
      throw new Error();
    result.counts = { nodes: nodes.length / 7, edges: edges.length / 4, roots: roots.length / 3 };
    // These bound derived indexing/traversal, not the preceding native snapshot allocation.
    if (nodes.length / 7 > 1_000_000 || edges.length / 4 > 4_000_000 || roots.length / 3 > 1_000_000) {
      result.reason = "snapshot-index-budget";
      return result;
    }
    const byId = new Map<number, number>();
    const addresses = new Set<bigint>();
    const addressRepresentations = { hexString: 0, decimalString: 0, safeInteger: 0 };
    const matches: number[] = [];
    let duplicateAddresses = 0;
    for (let offset = 0; offset < nodes.length; offset += 7) {
      const id = integer(nodes[offset]);
      if (byId.has(id)) throw new Error();
      byId.set(id, offset);
      stringAt(classes, nodes[offset + 2]);
      stringAt(labels, nodes[offset + 4]);
      if (id === 0) {
        // HeapSnapshotBuilder prepends this structural root; it has no live cell address.
        const synthetic = [0, 0, 0, 0, 0, "0x0", "0x0"];
        if (
          offset !== 0 ||
          classes[0] !== "<root>" ||
          labels[0] !== "" ||
          synthetic.some((value, index) => nodes[index] !== value)
        )
          throw new Error();
        result.syntheticRootRecord = true;
        continue;
      }
      const cell = nodes[offset + 5];
      if (typeof cell === "number") {
        integer(cell);
        addressRepresentations.safeInteger++;
      } else if (typeof cell === "string" && cell.length <= 20 && /^(?:0[xX][\da-fA-F]+|[0-9]+)$/.test(cell)) {
        addressRepresentations[cell.startsWith("0x") || cell.startsWith("0X") ? "hexString" : "decimalString"]++;
      } else throw new Error();
      const value = BigInt(cell);
      if (value <= 0n || value > 0xffffffffffffffffn) throw new Error();
      if (addresses.has(value)) duplicateAddresses++;
      addresses.add(value);
      if (address !== undefined && value === address) matches.push(id);
    }
    result.addressRepresentations = addressRepresentations;
    result.duplicateAddresses = duplicateAddresses;
    result.identity = { addressCaptured: address !== undefined, addressMatches: matches.length };
    if (duplicateAddresses) {
      result.reason = "duplicate-node-address";
      return result;
    }
    if (matches.length !== 1) {
      result.reason = matches.length ? "ambiguous-address" : "identity-not-found";
      return result;
    }
    const target = matches[0]!;
    const classOf = (id: number) => stringAt(classes, nodes[byId.get(id)! + 2]);
    if (!["Object", "FinalObject"].includes(classOf(target))) {
      result.reason = "identity-class-mismatch";
      return result;
    }
    const incoming: number[] = [];
    let incomingCount = 0,
      sentinelEdges = 0,
      sentinelStringEdges = 0,
      sentinelValueMatches = 0,
      sentinelValueUnrepresented = 0,
      unrepresentedZeroSources = 0;
    for (let offset = 0; offset < edges.length; offset += 4) {
      const from = integer(edges[offset]),
        to = integer(edges[offset + 1]);
      if (!byId.has(to) || (!byId.has(from) && from !== 0)) throw new Error();
      if (!byId.has(from)) unrepresentedZeroSources++;
      const type = stringAt(types, edges[offset + 2]);
      const name = type === "Property" || type === "Variable" ? stringAt(names, edges[offset + 3]) : undefined;
      if (name === undefined) integer(edges[offset + 3]);
      if (to === target) {
        incomingCount++;
        if (incoming.length < 32) incoming.push(offset);
      }
      if (from === target && type === "Property" && name === "sentinel") {
        sentinelEdges++;
        const label = stringAt(labels, nodes[byId.get(to)! + 4]);
        if (["String", "string"].includes(classOf(to))) {
          sentinelStringEdges++;
          // The pinned builder omits String scalar labels; this is shape evidence only.
          if (!label) sentinelValueUnrepresented++;
          else if (["synthetic invitation callback", '"synthetic invitation callback"'].includes(label))
            sentinelValueMatches++;
        }
      }
    }
    result.identity = {
      addressCaptured: true,
      addressMatches: 1,
      compatibleClass: true,
      sentinelEdges,
      sentinelStringEdges,
      sentinelValueMatches,
      sentinelValueUnrepresented,
      confidence: "address/class/property shape only; scalar text identity is not established",
      addressReuseExcluded: false,
    };
    if (
      !sentinelEdges ||
      sentinelEdges !== sentinelStringEdges ||
      sentinelEdges !== sentinelValueMatches + sentinelValueUnrepresented
    ) {
      result.reason = sentinelEdges ? "sentinel-shape-or-value-mismatch" : "sentinel-property-unrepresented";
      return result;
    }
    const allowedClasses = new Set([
      "<root>",
      "Object",
      "FinalObject",
      "Function",
      "JSFunction",
      "AsyncFunction",
      "Promise",
      "InternalPromise",
      "JSLexicalEnvironment",
      "JSModuleEnvironment",
      "JSGlobalObject",
      "GlobalObject",
      "Array",
      "WeakRef",
      "WeakMap",
      "WeakSet",
      "Map",
      "Set",
      "Structure",
      "String",
      "string",
      "FunctionExecutable",
      "UnlinkedFunctionExecutable",
      "JSGenerator",
      "AsyncGenerator",
    ]);
    const allowedNames = new Set([
      "captured",
      "sentinel",
      "assertCurrent",
      "prepareMentionInvitation",
      "settle",
      "reference",
      "control",
      "callbacks",
      "owner",
      "observers",
      "onRequest",
      "prototype",
      "constructor",
    ]);
    const redacted = { classes: 0, edgeTypes: 0, edgeNames: 0, rootLabels: 0 };
    const localIds = new Map<number, string>([[target, "n0"]]);
    const nodeInfo = (id: number) => {
      if (!localIds.has(id)) localIds.set(id, "n" + localIds.size);
      const raw = byId.has(id) ? classOf(id) : "Unrepresented";
      if (!allowedClasses.has(raw)) redacted.classes++;
      return { node: localIds.get(id)!, class: allowedClasses.has(raw) ? raw : "Other" };
    };
    const edgeInfo = (offset: number) => {
      const raw = stringAt(types, edges[offset + 2]);
      const type = ["Internal", "Property", "Variable", "Index"].includes(raw) ? raw : "Other";
      if (type === "Other") redacted.edgeTypes++;
      if (raw !== "Property" && raw !== "Variable") return { type };
      const name = stringAt(names, edges[offset + 3]);
      if (!allowedNames.has(name)) redacted.edgeNames++;
      return { type, name: allowedNames.has(name) ? name : "<redacted>" };
    };
    const rootRows: Array<{ id: number; reason: string; pendingActivity: boolean; ancillary: string }> = [];
    const rootCategories: Record<string, number> = {};
    const parentCounts = new Map(
      incoming.map(offset => [edges[offset] as number, { incomingCount: 0, reportedRootCount: 0 }]),
    );
    for (let offset = 0; offset < roots.length; offset += 3) {
      const id = integer(roots[offset]);
      if (!byId.has(id)) throw new Error();
      const parent = parentCounts.get(id);
      if (parent) parent.reportedRootCount++;
      const raw = stringAt(labels, roots[offset + 1]);
      const detail = stringAt(labels, roots[offset + 2]);
      const reason = raw.includes("DOMGCOutput")
        ? "DOMGCOutput"
        : ["Output", "WeakSets", "StrongHandles", "ProtectedValues", "VMExceptions", "Debugger"].includes(raw)
          ? raw
          : "Other";
      const pendingActivity = reason === "WeakSets" && detail.includes("pending activity");
      const category = pendingActivity ? "WeakSets-pending-activity" : reason;
      rootCategories[category] = (rootCategories[category] ?? 0) + 1;
      rootRows.push({
        id,
        reason,
        pendingActivity,
        ancillary: !detail ? "empty" : pendingActivity ? "pending-activity" : "redacted",
      });
    }
    const truncation: string[] = [];
    if (incomingCount > 32) truncation.push("incoming-edge-limit");
    const paths: Array<Record<string, unknown>> = [];
    const next = new Map<number, { child: number; edge: number }>();
    const visited = new Set([target]);
    let frontier = new Set([target]),
      scanned = 0,
      parentCountsComplete = false;
    for (let depth = 0; frontier.size; depth++) {
      for (const root of rootRows) {
        if (!frontier.has(root.id)) continue;
        const pathNodes = [nodeInfo(root.id)],
          pathEdges = [];
        let id = root.id;
        while (id !== target) {
          const step = next.get(id);
          if (!step || pathEdges.length >= 32) throw new Error();
          pathEdges.push(edgeInfo(step.edge));
          pathNodes.push(nodeInfo(step.child));
          id = step.child;
        }
        if (root.reason === "Other" || root.ancillary === "redacted") redacted.rootLabels++;
        paths.push({
          root: { reason: root.reason, pendingActivity: root.pendingActivity, ancillary: root.ancillary },
          nodes: pathNodes,
          edges: pathEdges,
        });
        if (paths.length === 8) break;
      }
      if (paths.length === 8) {
        truncation.push("root-path-limit");
        break;
      }
      if (depth === 32) {
        truncation.push("depth-limit");
        break;
      }
      const parents = new Set<number>();
      for (let offset = 0; offset < edges.length; offset += 4) {
        if (++scanned > 64_000_000) {
          truncation.push("edge-scan-budget");
          break;
        }
        const from = edges[offset] as number,
          to = edges[offset + 1] as number;
        // Reuse this existing scan; an interrupted first pass yields lower bounds only.
        if (depth === 0) {
          const parent = parentCounts.get(to);
          if (parent) parent.incomingCount++;
        }
        if (!frontier.has(to) || !byId.has(from) || visited.has(from)) continue;
        if (visited.size === 1024) {
          truncation.push("traversal-node-budget");
          break;
        }
        visited.add(from);
        parents.add(from);
        next.set(from, { child: to, edge: offset });
      }
      if (truncation.includes("edge-scan-budget") || truncation.includes("traversal-node-budget")) break;
      if (depth === 0) parentCountsComplete = true;
      frontier = parents;
    }
    result.target = nodeInfo(target);
    result.incomingCount = incomingCount;
    result.incoming = incoming.map(offset => ({ from: nodeInfo(edges[offset] as number), edge: edgeInfo(offset) }));
    result.incomingParents = [...parentCounts].map(([id, counts]) => ({
      ...nodeInfo(id),
      incomingCount: parentCountsComplete ? counts.incomingCount : null,
      incomingCountComplete: parentCountsComplete,
      ...(parentCountsComplete ? {} : { incomingCountLowerBound: counts.incomingCount }),
      reportedRootCount: counts.reportedRootCount,
    }));
    result.reverseSearch = { visitedCount: visited.size, frontierExhausted: frontier.size === 0 };
    result.reportedRootPaths = paths;
    result.allReportedRootCategories = rootCategories;
    result.filtering = "no root category or reported edge excluded by strength; unknown labels remain Other/redacted";
    result.redactedFields = redacted;
    result.unrepresentedZeroSourceEdges = unrepresentedZeroSources;
    result.truncation = truncation;
    result.complete = paths.length > 0 && !truncation.length && !unrepresentedZeroSources;
    result.reason = result.complete ? "reported-structure-only" : "incomplete-reported-structure";
  } catch {
    result.reason = "snapshot-format-or-parser-failure";
  }
  return result;
}

export function emitInvitationRetainerSnapshot(input: unknown, address: bigint | undefined): void {
  const report = invitationRetainerSnapshot(input, address);
  const prefix = "[invitation-snapshot] ";
  const line = prefix + JSON.stringify(report);
  console.log(
    Buffer.byteLength(line + "\n", "utf8") <= 64 * 1024
      ? line
      : prefix +
          JSON.stringify({
            version: 1,
            kind: "commit-retainer-snapshot",
            complete: false,
            diagnosticOnly: true,
            qualifiesRepin: false,
            reason: "output-byte-limit",
          }),
  );
}
